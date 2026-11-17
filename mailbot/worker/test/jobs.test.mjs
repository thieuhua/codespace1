import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createJob, claimJob, finishJob, senderAuth, isAllowed } from '../src/mailbot.js';

// D1 adapter chạy SQL thật trên SQLite memory, không mạng hay credential.
function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const f of ['schema.sql', 'schema-v2.sql', 'schema-v3.sql']) sqlite.exec(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, '$p$1'));
      let values = {};
      return {
        bind(...args) { values = Object.fromEntries(args.map((v, i) => [`$p${i + 1}`, v])); return this; },
        async first() { return statement.get(values) || null; },
        async all() { return { results: statement.all(values) }; },
        async run() { const r = statement.run(values); return { meta: { last_row_id: r.lastInsertRowid } }; },
      };
    },
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
  };
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
  const files = [{ filename: 'test.txt', mime_type: 'text/plain', b64: 'YQ==' }];
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
