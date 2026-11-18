import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database } from '../test-support/d1.mjs';
import { createJob, claimJob, finishJob, senderAuth, isAllowed } from '../src/mailbot.js';

// D1 adapter chạy SQL thật trên SQLite memory, không mạng hay credential.
function setup(t) {
  const { sqlite, DB } = database(t);
  const env = { DB, MAIL_DOMAIN: 'example.com' }, sent = [];
  const send = async (...args) => { sent.push(args); };
  const create = (sender = 'a@example.com', subject = 'hello', more = {}) => createJob(env, {
    msgId: 0, agent: 'claude', sender, mail: { text: 'prompt', subject, messageId: '<root@x>', ...more },
  }, send);
  return { env, sent, send, create, sqlite };
}
test('schema includes all future columns and is a one-time migration', (t) => {
  const { sqlite } = setup(t);
  const cols = sqlite.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  for (const c of ['options_json', 'project', 'parent_id', 'root_id', 'depth', 'cancel_requested', 'job_token_hash', 'notify_count', 'delegate_count', 'outbox_json', 'reply_to']) assert.ok(cols.includes(c));
  assert.throws(() => sqlite.exec(readFileSync(new URL('../schema-v3.sql', import.meta.url), 'utf8')), /duplicate column/);
  assert.doesNotThrow(() => sqlite.exec(readFileSync(new URL('../schema-v4.sql', import.meta.url), 'utf8')));
  assert.throws(() => sqlite.exec(readFileSync(new URL('../schema-v5.sql', import.meta.url), 'utf8')), /already exists/);
});
test('/new skips old session; successful result replaces thread for later replies', async (t) => {
  const { env, create, send } = setup(t);
  await create();
  const first = await claimJob(env, ['claude']);
  await finishJob(env, first.id, { ok: true, output: 'first', session_id: 'old' }, send);
  await create('a@example.com', '/new /model=opus /effort=max fresh');
  const fresh = await claimJob(env, ['claude']);
  assert.equal(fresh.resume_session, null);
  assert.equal(fresh.subject, 'fresh');
  assert.equal(JSON.parse(fresh.options_json).model, 'opus');
  await finishJob(env, fresh.id, { ok: true, output: 'new', session_id: 'new' }, send);
  await create('a@example.com', 'Re: next', { references: undefined, inReplyTo: `<mailbot-job-${fresh.id}@example.com>`, messageId: '<next@x>' });
  assert.equal((await claimJob(env, ['claude'])).resume_session, 'new');
  assert.equal(await claimJob(env, ['claude']), null);
});
test('/status and /cancel are sender scoped; pending cancelled, running signalled, no new jobs', async (t) => {
  const { env, create, sqlite, sent } = setup(t);
  const a = await create(), b = await create('b@example.com');
  await claimJob(env, ['claude']);
  await create('a@example.com', `/cancel=${b.id}`);
  assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(b.id).status, 'pending');
  await create('a@example.com', '/status');
  assert.ok(!sent.at(-1)[1].text.includes(`#${b.id} `));
  await create('a@example.com', '/cancel');
  assert.equal(sqlite.prepare('SELECT cancel_requested FROM jobs WHERE id=?').get(a.id).cancel_requested, 1);
  await create('b@example.com', '/cancel');
  assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(b.id).status, 'cancelled');
  sqlite.prepare("UPDATE jobs SET claimed_at='2000-01-01'").run();
  assert.equal(await claimJob(env, ['claude']), null);
  assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(a.id).status, 'cancelled');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 2);
});
test('unknown command suppressed at rate limit; rate-limited jobs do not count twice', async (t) => {
  const { create, sent } = setup(t);
  assert.equal((await create('a@example.com', '/wat')).status, 'command');
  assert.match(sent[0][1].text, /\/status/);
  for (let i = 0; i < 20; i++) await create();
  assert.equal((await create('a@example.com', '/wat')).status, 'command_suppressed');
  assert.equal(sent.length, 1);
  assert.equal((await create()).status, 'rate_limited');
});
test('terminal result with NULL reply_status retries mail only using stored result and stable ID', async (t) => {
  const { env, create, sqlite, send, sent } = setup(t);
  await create();
  const job = await claimJob(env, ['claude']);
  const files = [{ filename: 'test.txt', mime_type: 'text/plain', b64_lines: 'YQ==' }];
  // Mô phỏng Worker chết giữa lưu kết quả và cập nhật threads/gửi mail.
  const batch = env.DB.batch;
  env.DB.batch = async () => { throw new Error('interrupted'); };
  await assert.rejects(finishJob(env, job.id, { ok: true, output: 'stored', session_id: 'session', attachments: files }, send), /interrupted/);
  env.DB.batch = batch;
  const res = await finishJob(env, job.id, { ok: false, output: 'replacement', session_id: 'wrong', attachments: files }, send);
  assert.equal(res.reply, 'sent');
  assert.match(sent[0][1], /stored/);
  assert.ok(!sent[0][1].includes('replacement'));
  assert.equal(sent[0][2], `<mailbot-job-${job.id}@example.com>`);
  assert.equal(sqlite.prepare('SELECT session_id FROM jobs').get().session_id, 'session');
  assert.deepEqual(JSON.parse(sqlite.prepare('SELECT outbox_json FROM jobs').get().outbox_json), [{ filename: 'test.txt', size: 1 }]);
  assert.ok((await finishJob(env, job.id, {}, send)).error);
});
test('cancel during finish cannot save a session; invalid attachments leave job running', async (t) => {
  const { env, create, send, sqlite } = setup(t);
  await create();
  const job = await claimJob(env, ['claude']);
  assert.equal((await finishJob(env, job.id, { attachments: [{}] }, send)).code, 400);
  assert.equal(sqlite.prepare('SELECT status FROM jobs').get().status, 'running');
  await create('a@example.com', '/cancel');
  await finishJob(env, job.id, { ok: true, output: 'done', session_id: 'should-not-save' }, send);
  const row = sqlite.prepare('SELECT * FROM jobs').get();
  assert.equal(row.status, 'cancelled');
  assert.equal(row.session_id, null);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM threads').get().n, 0);
});
test('senderAuth and per-agent whitelist invariants', async (t) => {
  const { env, sqlite } = setup(t);
  const from = { key: 'from', line: 'From: a@example.com' };
  const ar = (s) => ({ key: 'authentication-results', line: `Authentication-Results: mx.cloudflare.net; ${s}` });
  const auth = (headers) => senderAuth({ from: { address: 'a@example.com' }, headerLines: headers });
  assert.equal(auth([from, ar('dmarc=pass header.from=example.com')]).ok, true);
  assert.equal(auth([from, from, ar('dmarc=pass header.from=example.com')]).ok, false);
  assert.equal(auth([from, ar('dmarc=fail header.from=example.com'), ar('dmarc=pass header.from=example.com')]).ok, false);
  assert.equal(auth([from, ar('dkim=pass header.s=dmarc=pass header.from=example.com')]).ok, false);
  sqlite.prepare("INSERT INTO allowlist VALUES ('a@example.com','claude','now')").run();
  assert.equal(await isAllowed(env, 'a@example.com', 'claude'), true);
  assert.equal(await isAllowed(env, 'a@example.com', 'codex'), false);
});

test('C1 exact From grammar, parser equality, and quoted A-R domain', async () => {
  const auth = (value, address = 'thieu@gmail.com', ar = 'dmarc=pass header.from="gmail.com"') => senderAuth({
    from: { address }, headerLines: [{ key: 'from', line: `From: ${value}` },
      { key: 'authentication-results', line: `Authentication-Results: mx.cloudflare.net; ${ar}` }],
  });
  for (const from of ['thieu@gmail.com', 'Tên hiển thị <thieu@gmail.com>', '"Tên hiển thị" <THIEU@gmail.com>'])
    assert.equal(auth(from).ok, true, from);
  for (const from of ['(\\) <thieu@gmail.com>,) <fakethieu@gmail.com>', '<thieu@gmail.com>',
    'thieu@gmail.com (comment)', 'a,b <thieu@gmail.com>', 'a;b <thieu@gmail.com>',
    'a@b <thieu@gmail.com>', 'a\\b <thieu@gmail.com>', '"a,b" <thieu@gmail.com>', '"unclosed <thieu@gmail.com>',
    '"a\\b" <thieu@gmail.com>', '<"attacker@evil.com" <thieu@gmail.com>>',
    'thieu@gmail.com, " <attacker@evil.com>', 'fakethieu@gmail.com']) assert.equal(auth(from).ok, false, from);
  assert.equal(auth('thieu@gmail.com', 'fakethieu@gmail.com').ok, false);
  assert.equal(auth('thieu@gmail.com', undefined, 'dkim=pass header.s="; dmarc=pass header.from=gmail.com fake"; dmarc=fail header.from=gmail.com').ok, false);
  assert.equal(auth('thieu@gmail.com', undefined, 'dmarc=pass header.from="gmail.com').ok, false);
  assert.equal(auth('thieu@gmail.com', undefined, '(dmarc=pass header.from=gmail.com); dmarc=fail').ok, false);
});

test('C8 command-only floods consume an atomic shared budget, safe subject and cancellation revokes hash', async (t) => {
  const { env, create, sqlite, sent } = setup(t);
  await create();
  const job = await claimJob(env, ['claude']);
  await create('a@example.com', '/cancel');
  assert.equal(sqlite.prepare('SELECT job_token_hash FROM jobs WHERE id=?').get(job.id).job_token_hash, null);
  assert.equal(sent.at(-1)[1].subject, 'Re: [cancel]');
  const results = await Promise.all(Array.from({ length: 30 }, () => create('a@example.com', '/status')));
  assert.equal(results.filter((r) => r.status === 'command').length, 18);
  assert.equal(sent.length, 19);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM command_receipts').get().n, 19);
  assert.equal(sent.at(-1)[1].subject, 'Re: [status]');
  assert.equal((await create()).status, 'rate_limited');
});

test('C8 Auto-Submitted suppresses command replies without consuming budget', async (t) => {
  const { create, sent, sqlite } = setup(t);
  assert.equal((await create('a@example.com', '/status', { headerLines: [{ key: 'auto-submitted', line: 'Auto-Submitted: auto-replied' }] })).status, 'command_suppressed');
  assert.equal(sent.length, 0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM command_receipts').get().n, 0);
});

test('C8 status/cancel are suppressed at job budget', async (t) => {
  const { create, sent, sqlite } = setup(t);
  for (let i = 0; i < 20; i++) await create();
  for (const command of ['/status', '/cancel', '/wat']) assert.equal((await create('a@example.com', command)).status, 'command_suppressed');
  assert.equal(sent.length, 0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs WHERE cancel_requested=1').get().n, 0);
});

test('failed and cancelled terminal retries keep status and never save session', async (t) => {
  const { env, create, sqlite, send, sent } = setup(t);
  for (const status of ['failed', 'cancelled']) {
    const { id } = await create();
    sqlite.prepare('UPDATE jobs SET status=?, output=? WHERE id=?').run(status, 'stored error', id);
    assert.equal((await finishJob(env, id, { ok: true, output: 'overwrite', session_id: 'bad' }, send)).reply, 'sent');
    assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(id).status, status);
    assert.match(sent.at(-1)[1], /stored error/);
  }
  assert.equal(sqlite.prepare('SELECT count(*) n FROM threads').get().n, 0);
});

test('existing stale retry limit and invalid session protection are preserved', async (t) => {
  const { env, create, sqlite, send } = setup(t);
  const { id } = await create();
  assert.equal((await claimJob(env, ['claude'])).attempts, 1);
  sqlite.prepare("UPDATE jobs SET claimed_at='2000-01-01'").run();
  assert.equal((await claimJob(env, ['claude'])).attempts, 2);
  sqlite.prepare("UPDATE jobs SET claimed_at='2000-01-01'").run();
  assert.equal(await claimJob(env, ['claude']), null);
  assert.equal(sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(id).status, 'failed');
  await create();
  const next = await claimJob(env, ['claude']);
  await finishJob(env, next.id, { ok: true, session_id: '--unsafe', output: 'safe' }, send);
  assert.equal(sqlite.prepare('SELECT session_id FROM jobs WHERE id=?').get(next.id).session_id, null);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM threads').get().n, 0);
});
