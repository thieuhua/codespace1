import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../test-support/d1.mjs';
import { agentFor, rejectRecipient, readerScope, createJob, claimJob, finishJob } from '../src/mailbot.js';
import { jobForToken, notifySender, delegateJob, submitJob, cancelJob } from '../src/job-api.js';

function setup(t) {
  const { DB, sqlite } = database(t);
  sqlite.exec("INSERT INTO allowlist VALUES ('a@example.com','*','now')");
  const env = { DB, MAIL_DOMAIN: 'example.com' }, sent = [];
  const send = async (...a) => { sent.push(a); };
  const create = (tag = null, mail = {}) => createJob(env, { msgId: 0, agent: 'claude', tag, sender: 'a@example.com',
    mail: { subject: 'test', text: 'prompt', messageId: '<root@x>', ...mail } }, send);
  return { env, sqlite, send, sent, create };
}

test('recipient +tag grammar, domain and SMTP rejection policy', () => {
  assert.deepEqual(agentFor('Codex+demo-1@example.com', 'example.com'), { agent: 'codex', tag: 'demo-1' });
  assert.deepEqual(agentFor('claude@example.com'), { agent: 'claude', tag: null });
  for (const addr of ['x@example.com', 'claude+@example.com', 'claude+a+b@example.com', 'agy+bad_tag@example.com', `agy+${'a'.repeat(33)}@example.com`, 'codex@example.com@evil', 'claude']) assert.equal(agentFor(addr), null);
  assert.equal(agentFor('claude@evil.com', 'example.com'), null);
  assert.equal(rejectRecipient(null, true), true);
  for (const addr of ['claude+demo@example.com', 'codex@example.com', 'agy@example.com']) {
    assert.equal(rejectRecipient(agentFor(addr), false), true);
    assert.equal(rejectRecipient(agentFor(addr), true), false);
  }
  assert.equal(rejectRecipient(agentFor('claude@example.com'), false), false);
});

test('reader SQL only exposes exact claude@ configured domain', (t) => {
  const { sqlite } = database(t);
  for (const to of ['claude@example.com', 'CLAUDE@EXAMPLE.COM', 'claude+demo@example.com', 'codex@example.com', 'agy@example.com', 'unknown@example.com', 'claude@evil.com'])
    sqlite.prepare('INSERT INTO messages(received_at,envelope_from,envelope_to) VALUES (?,?,?)').run('now', 'a@x', to);
  assert.deepEqual(sqlite.prepare(`SELECT envelope_to FROM messages WHERE ${readerScope('example.com')}`).all().map((r) => r.envelope_to), ['claude@example.com', 'CLAUDE@EXAMPLE.COM']);
});

test('project inherits thread, reply aliases keep original thread/worktree and tagged from', async (t) => {
  const { env, create, send, sent } = setup(t);
  await create('demo');
  const first = await claimJob(env, ['claude']);
  await finishJob(env, first.id, { ok: true, output: 'done', session_id: 'sid' }, send);
  await create(null, { references: undefined, inReplyTo: `<mailbot-job-${first.id}@example.com>`, messageId: '<next@x>' });
  const next = await claimJob(env, ['claude']);
  assert.equal(next.project, 'demo');
  assert.equal(next.resume_session, 'sid');
  assert.equal(next.thread_key, first.thread_key);
  await create(null, { subject: '/status' });
  assert.equal(sent.at(-1)[1].from, 'claude+demo@example.com');
});

test('claim tokens are hashed, rotated on reclaim, cleared on finish and not interchangeable with admin', async (t) => {
  const { env, create, sqlite, send } = setup(t);
  await create();
  const a = await claimJob(env, ['claude']);
  assert.match(a.job_token, /^[\w-]{43}$/);
  assert.equal(a.job_token_hash, undefined);
  assert.notEqual(sqlite.prepare('SELECT job_token_hash FROM jobs').get().job_token_hash, a.job_token);
  assert.equal((await jobForToken(env, a.job_token)).id, a.id);
  assert.equal(await jobForToken(env, 'admin'), null);
  sqlite.exec("UPDATE jobs SET claimed_at='2000-01-01'");
  const b = await claimJob(env, ['claude']);
  assert.notEqual(b.job_token, a.job_token);
  assert.equal(await jobForToken(env, a.job_token), null);
  await finishJob(env, b.id, { ok: true }, send);
  assert.equal(await jobForToken(env, b.job_token), null);
  assert.equal(sqlite.prepare('SELECT job_token_hash FROM jobs').get().job_token_hash, null);
});

test('notify quota is atomic, sender fixed; notify Message-ID is mapped to session on finish', async (t) => {
  const { env, create, send, sent, sqlite } = setup(t);
  await create('demo');
  const claimed = await claimJob(env, ['claude']), job = await jobForToken(env, claimed.job_token);
  const results = await Promise.all(Array.from({ length: 8 }, () => notifySender(env, job, { subject: 'update', body: 'progress', to: 'evil@x' }, send)));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(sqlite.prepare('SELECT notify_count FROM jobs').get().notify_count, 3);
  for (const [, mail] of sent) { assert.equal(mail.to, 'a@example.com'); assert.equal(mail.from, 'claude+demo@example.com'); }
  const notifyId = sent[0][1].messageId;
  await finishJob(env, job.id, { ok: true, session_id: 'sid' }, send);
  assert.equal(sqlite.prepare('SELECT session_id FROM threads WHERE thread_key=?').get(`a@example.com|${notifyId}`).session_id, 'sid');
  await create(null, { messageId: '<reply@x>', inReplyTo: notifyId });
  const reply = await claimJob(env, ['claude']);
  assert.equal(reply.project, 'demo');
  assert.equal(reply.thread_key, job.thread_key);
});

test('delegate validates agent, whitelist and depth; atomic maximum two children, three jobs per tree', async (t) => {
  const { env, create, sqlite } = setup(t);
  await create('demo');
  const claim = await claimJob(env, ['claude']), parent = await jobForToken(env, claim.job_token);
  assert.equal((await delegateJob(env, parent, { agent: 'claude', prompt: 'x' })).code, 400);
  assert.equal((await delegateJob(env, parent, { agent: 'other', prompt: 'x' })).code, 400);
  sqlite.exec("DELETE FROM allowlist; INSERT INTO allowlist VALUES ('a@example.com','claude','now')");
  assert.equal((await delegateJob(env, parent, { agent: 'codex', prompt: 'x' })).code, 403);
  sqlite.exec("INSERT INTO allowlist VALUES ('a@example.com','*','now')");
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => delegateJob(env, parent, { agent: i % 2 ? 'codex' : 'agy', prompt: 'x' })));
  const children = results.filter((r) => r.job).map((r) => r.job);
  assert.equal(children.length, 2);
  assert.equal(sqlite.prepare('SELECT delegate_count FROM jobs WHERE id=?').get(parent.id).delegate_count, 2);
  for (const c of children) {
    assert.equal(c.project, 'demo'); assert.equal(c.root_id, parent.id); assert.equal(c.parent_id, parent.id); assert.equal(c.depth, 1);
    assert.equal(c.reply_to, parent.sender); assert.equal(c.message_id, 0);
    assert.equal(sqlite.prepare('SELECT thread_key FROM jobs WHERE id=?').get(c.id).thread_key, `${c.sender}|<delegate-${c.id}@mailbot>`);
  }
  const childClaim = await claimJob(env, ['agy', 'codex']);
  const child = await jobForToken(env, childClaim.job_token);
  assert.equal((await delegateJob(env, child, { agent: 'claude', prompt: 'too deep' })).code, 409);
  // Even if a counter were inconsistent, the independent tree-count guard applies.
  sqlite.prepare('UPDATE jobs SET delegate_count=0 WHERE id=?').run(parent.id);
  assert.equal((await delegateJob(env, parent, { agent: 'codex', prompt: 'full tree' })).code, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM jobs').get().n, 3);
});

test('submission and delegation share sender rate budget; cancellation revokes job token', async (t) => {
  const { env, create, sqlite } = setup(t);
  assert.equal((await submitJob(env, { agent: 'agy', prompt: 'x', reply_to: 'stranger@example.com' })).code, 403);
  const submitted = await submitJob(env, { agent: 'claude', prompt: 'x', project: 'demo', reply_to: 'A@EXAMPLE.COM' });
  assert.equal(submitted.job.message_id, 0); assert.equal(submitted.job.reply_to, 'a@example.com');
  const c = await claimJob(env, ['claude']), parent = await jobForToken(env, c.job_token);
  for (let i = 0; i < 19; i++) await create();
  assert.equal((await submitJob(env, { agent: 'agy', prompt: 'x', reply_to: 'a@example.com' })).code, 429);
  assert.equal((await delegateJob(env, parent, { agent: 'codex', prompt: 'x' })).code, 409);
  assert.equal(sqlite.prepare('SELECT delegate_count FROM jobs WHERE id=?').get(parent.id).delegate_count, 0);
  await cancelJob(env, parent.id);
  assert.equal(await jobForToken(env, c.job_token), null);
  assert.equal((await delegateJob(env, parent, { agent: 'codex', prompt: 'x' })).code, 409);
});

test('C10 rate_limited leaves thread project/session intact', async (t) => {
  const { env, create, send, sqlite } = setup(t);
  await create('demo');
  const job = await claimJob(env, ['claude']);
  await finishJob(env, job.id, { ok: true, session_id: 'kept' }, send);
  for (let i = 0; i < 19; i++) await create('demo');
  const before = sqlite.prepare('SELECT * FROM threads ORDER BY thread_key').all();
  assert.equal((await create('other')).status, 'rate_limited');
  assert.deepEqual(sqlite.prepare('SELECT * FROM threads ORDER BY thread_key').all(), before);
});

test('C8 command receipts also bound submission/delegation without consuming child quota', async (t) => {
  const { env, create, sqlite } = setup(t);
  await create();
  const claim = await claimJob(env, ['claude']), parent = await jobForToken(env, claim.job_token);
  for (let i = 0; i < 19; i++) assert.equal((await create(null, { subject: '/status' })).status, 'command');
  assert.equal((await submitJob(env, { agent: 'agy', prompt: 'x', reply_to: 'a@example.com' })).code, 429);
  assert.equal((await delegateJob(env, parent, { agent: 'codex', prompt: 'x' })).code, 409);
  assert.equal(sqlite.prepare('SELECT delegate_count FROM jobs WHERE id=?').get(parent.id).delegate_count, 0);
});

for (const origin of ['submit', 'delegate']) test(`C10 ${origin}: notify root first; second reply retains session/project`, async (t) => {
  const { env, create, send, sent, sqlite } = setup(t);
  let first;
  if (origin === 'submit') {
    await submitJob(env, { agent: 'codex', prompt: 'root', project: 'demo', reply_to: 'a@example.com' });
    first = await claimJob(env, ['codex']);
  } else {
    await create('demo');
    const parent = await claimJob(env, ['claude']);
    await delegateJob(env, await jobForToken(env, parent.job_token), { agent: 'codex', prompt: 'child' });
    first = await claimJob(env, ['codex']);
  }
  await finishJob(env, first.id, { ok: true, session_id: 'first-sid' }, send);
  const reply = (mail) => createJob(env, { msgId: 0, agent: 'codex', sender: 'a@example.com',
    mail: { text: 'next', subject: 'next', ...mail } }, send);
  await reply({ messageId: '<reply1@user>', inReplyTo: `<mailbot-job-${first.id}@example.com>` });
  const next = await claimJob(env, ['codex']);
  assert.equal(next.resume_session, 'first-sid');
  assert.equal(next.project, 'demo');
  await notifySender(env, await jobForToken(env, next.job_token), { subject: 'update', body: 'progress' }, send);
  const refs = sqlite.prepare('SELECT references_hdr FROM jobs WHERE id=?').get(next.id).references_hdr;
  assert.ok(refs.startsWith('<reply1@user> <mailbot-notify-'));
  await finishJob(env, next.id, { ok: true, session_id: 'next-sid' }, send);
  await reply({ messageId: '<reply2@user>', references: `<reply1@user> <mailbot-job-${next.id}@example.com>` });
  const third = await claimJob(env, ['codex']);
  assert.equal(third.resume_session, 'next-sid');
  assert.equal(third.project, 'demo');
  // The root key must also remain stable for worktree identity, not just resume.
  assert.equal(third.thread_key, first.thread_key);
});
