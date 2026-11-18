import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import PostalMime from 'postal-mime';
import { database } from '../test-support/d1.mjs';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:email') return { url: 'data:text/javascript,export class EmailMessage { constructor(from,to,raw){Object.assign(this,{from,to,raw})} }', shortCircuit: true };
  return next(specifier, context);
} });
const { default: worker } = await import('../src/index.js');
const { sendMail } = await import('../src/send.js');
hooks.deregister();

function setup(t, config = 'qa.xuanthieu.site', owner = 'tester@qa.xuanthieu.site') {
  const { DB, sqlite } = database(t), sent = [];
  sqlite.prepare("INSERT INTO allowlist VALUES(?,'*','now')").run(owner.toLowerCase());
  const env = { DB, MAIL_DOMAIN: 'example.com', API_TOKEN: 'reader', ADMIN_TOKEN: 'admin',
    EMAIL: { async send(mail) { sent.push(mail); } } };
  if (config !== null) env.QA_SINK_DOMAINS = config;
  const api = (path, body, token = 'admin', method = body === undefined ? 'GET' : 'POST') => worker.fetch(new Request('https://offline.test' + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const call = async (path, body) => {
    const response = await api(path, body), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const start = async () => {
    const { task } = await call('/tasks', { agent: 'claude', owner, prompt: 'QA work', title: 'QA subject' });
    const { run } = await call('/runs/claim', { agents: ['claude'] });
    return { task, run };
  };
  const outbox = async (query = '') => (await call('/api/qa/outbox' + query)).mails;
  return { sqlite, env, api, call, start, outbox, sent, owner };
}

for (const [label, config, owner, sink] of [
  ['missing setting', null, 'tester@qa.xuanthieu.site', false],
  ['empty setting', '', 'tester@qa.xuanthieu.site', false],
  ['enabled', 'qa.xuanthieu.site', 'tester@qa.xuanthieu.site', true],
  ['case and multiple domains', 'other.test, QA.XUANTHIEU.SITE; third.test\nlast.test', 'tester+tag@QA.XuanThieu.Site', true],
  ['unknown domain', 'qa.xuanthieu.site', 'tester@elsewhere.test', false],
  ['subdomain', 'qa.xuanthieu.site', 'tester@sub.qa.xuanthieu.site', false],
  ['suffix lookalike', 'qa.xuanthieu.site', 'tester@evilqa.xuanthieu.site', false],
]) test(`QA sink ${label}: task reservation and delivery`, async t => {
  const f = setup(t, config, owner), { task, run } = await f.start();
  let sawSending = false;
  const batch = f.env.DB.batch.bind(f.env.DB);
  f.env.DB.batch = async statements => {
    if (f.sqlite.prepare("SELECT 1 FROM outbound_mails WHERE status='sending' AND send_key IS NOT NULL").get()) sawSending = true;
    return batch(statements);
  };
  await f.call(`/runs/${run.id}/result`, { ok: true, output: 'QA result' });
  assert.equal(f.sent.length, sink ? 0 : 1);
  const [mail] = await f.outbox();
  assert.equal(!!mail, sink);
  const outbound = f.sqlite.prepare('SELECT * FROM outbound_mails WHERE task_id=?').get(task.id);
  assert.equal(outbound.status, 'sent'); assert.ok(outbound.send_key); assert.ok(outbound.sent_at);
  if (sink) {
    assert.equal(sawSending, true);
    assert.equal(mail.to.toLowerCase(), owner.toLowerCase());
    assert.equal(mail.message_id, outbound.message_id); assert.equal(mail.subject, outbound.subject);
    assert.ok(mail.created_at);
    const parsed = await PostalMime.parse(mail.raw);
    assert.equal(parsed.messageId, outbound.message_id); assert.match(parsed.text, /QA result/);
  } else assert.equal(f.sent[0].to, owner.toLowerCase());
});

test('QA endpoint requires admin; validates cursor/limit and returns ascending pages', async t => {
  const f = setup(t);
  for (let i = 0; i < 3; i++) await sendMail(f.env, {
    from: 'claude@example.com', to: f.owner, subject: `mail ${i}`, text: 'private', messageId: `<qa-${i}@example.com>`,
  });
  for (const [token, status] of [['', 401], ['wrong', 401], ['reader', 403]]) {
    const response = await f.api('/api/qa/outbox', undefined, token);
    assert.equal(response.status, status); assert.doesNotMatch(await response.text(), /private|tester@/);
  }
  const { run } = await f.start();
  assert.equal((await f.api('/api/qa/outbox', undefined, run.run_token)).status, 401);
  assert.equal((await f.api('/api/qa/outbox', {})).status, 404);
  for (const query of ['?after_id=-1', '?after_id=1junk', '?after_id=9007199254740992', '?limit=0', '?limit=-1', '?limit=no']) {
    assert.equal((await f.api('/api/qa/outbox' + query)).status, 400);
  }
  const first = await f.outbox('?limit=2');
  assert.equal(first.length, 2); assert.ok(first[0].id < first[1].id);
  const next = await f.outbox(`?after_id=${first[1].id}&limit=2`);
  assert.equal(next.length, 1); assert.equal(next[0].subject, 'mail 2');
  assert.equal((await f.outbox(`?after_id=${next[0].id}`)).length, 0);
  assert.equal((await f.outbox('?limit=1000')).length, 3);
});

test('QA capture and sent roll back together; finish retry captures once and never calls EMAIL', async t => {
  const f = setup(t), { task, run } = await f.start(), body = { ok: true, output: 'retry result' };
  f.sqlite.exec("CREATE TRIGGER reject_qa_part BEFORE INSERT ON qa_outbox_parts BEGIN SELECT RAISE(ABORT,'QA storage failure'); END");
  await f.call(`/runs/${run.id}/result`, body);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM qa_outbox').get().n, 0);
  const failed = f.sqlite.prepare('SELECT * FROM outbound_mails').get();
  assert.equal(failed.status, 'error'); assert.match(failed.error, /QA storage failure/);
  assert.equal(f.sent.length, 0);
  f.sqlite.exec('DROP TRIGGER reject_qa_part');
  await Promise.all(Array.from({ length: 5 }, () => f.call(`/runs/${run.id}/result`, body)));
  const [captured] = await f.outbox();
  await f.call(`/runs/${run.id}/result`, body);
  assert.deepEqual(await f.outbox(), [captured]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM qa_outbox').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT status FROM outbound_mails').get().status, 'sent');
  assert.equal(f.sqlite.prepare('SELECT mail_count FROM tasks WHERE id=?').get(task.id).mail_count, 1);
  assert.equal(f.sent.length, 0);
});

test('QA sendMail preserves first complete MIME including maximum-size attachments on retry', async t => {
  const f = setup(t), bytes = Buffer.alloc(2 * 1024 * 1024, 65);
  const mail = { from: 'claude@example.com', to: f.owner, subject: 'Tệp QA', text: 'Nội dung QA',
    messageId: '<attachment-qa@example.com>', inReplyTo: '<original@example.com>', references: '<older@example.com>',
    attachments: [{ filename: 'test.bin', mime_type: 'application/octet-stream', b64_lines: bytes.toString('base64').match(/.{1,76}/g).join('\r\n') }] };
  // Sink works without any EMAIL binding.
  delete f.env.EMAIL;
  await sendMail(f.env, mail);
  const [captured] = await f.outbox();
  assert.ok(captured.raw.length > 2 * 1024 * 1024);
  assert.ok(f.sqlite.prepare('SELECT COUNT(*) n FROM qa_outbox_parts').get().n > 1);
  assert.ok(f.sqlite.prepare('SELECT MAX(length(raw)) n FROM qa_outbox_parts').get().n <= 256 * 1024);
  const parsed = await PostalMime.parse(captured.raw);
  assert.equal(parsed.subject, mail.subject); assert.match(parsed.text, /Nội dung QA/);
  assert.equal(parsed.inReplyTo, mail.inReplyTo); assert.match(parsed.references, /older@example.com/);
  assert.deepEqual(Buffer.from(parsed.attachments[0].content), bytes);
  await sendMail(f.env, { ...mail, text: 'must not overwrite captured MIME' });
  assert.deepEqual(await f.outbox(), [captured]);
});

test('QA sink covers real SMTP handler command replies outside deliverOutbound', async t => {
  const f = setup(t), raw = `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=qa.xuanthieu.site\r\nFrom: ${f.owner}\r\nTo: claude@example.com\r\nSubject: /status\r\nMessage-ID: <qa-status@example.com>\r\n\r\nstatus`;
  await worker.email({ from: f.owner, to: 'claude@example.com', rawSize: raw.length,
    raw: new Blob([raw]).stream(), headers: new Headers(), setReject(reason) { assert.fail(reason); } }, f.env, { waitUntil() {} });
  assert.equal(f.sent.length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM command_receipts').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM outbound_mails').get().n, 0);
  const [mail] = await f.outbox();
  assert.match(mail.message_id, /mailbot-command-/); assert.match((await PostalMime.parse(mail.raw)).text, /không có task/);
});

for (const kind of ['question', 'notify', 'failed', 'cancelled']) test(`QA sink covers ${kind} task mail`, async t => {
  const f = setup(t), { run } = await f.start();
  if (kind === 'question' || kind === 'notify') {
    const response = await worker.fetch(new Request(`https://offline.test/run-api/${kind === 'question' ? 'ask_user' : 'notify'}`, {
      method: 'POST', headers: { 'X-Run-Token': run.run_token, 'content-type': 'application/json' },
      body: JSON.stringify(kind === 'question' ? { question: 'QA question?' } : { text: 'QA progress' }),
    }), f.env);
    assert.equal(response.status, 200);
  }
  if (kind !== 'notify') await f.call(`/runs/${run.id}/result`, { ok: kind !== 'failed', cancelled: kind === 'cancelled', output: 'QA terminal' });
  assert.equal(f.sent.length, 0); assert.equal((await f.outbox()).length, 1);
  assert.equal(f.sqlite.prepare('SELECT status FROM outbound_mails').get().status, 'sent');
});
