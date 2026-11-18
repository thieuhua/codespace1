import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOutbox } from '../../agent/outbox.mjs';
import { finalizeFiles } from '../../agent/job-finalize.mjs';
import { database } from '../test-support/d1.mjs';
import { submitTask, claimRun, finishRun, runForToken, runTool, receiveTaskMail, cronTick, schedule, cancelTask, completeTask, liveMessages } from '../src/tasks.js';

function fixture(t) {
  const { DB, sqlite } = database(t), sent = [];
  sqlite.exec("INSERT INTO allowlist VALUES('a@example.com','*','now')");
  const env = { DB, MAIL_DOMAIN: 'example.com' };
  const send = async (_env, mail) => { sent.push(mail); };
  const create = async () => (await submitTask(env, { agent: 'claude', owner: 'a@example.com', prompt: 'work' })).task;
  const claim = (agent = 'claude') => claimRun(env, [agent]);
  const tool = async (run, name, body) => runTool(env, await runForToken(env, run.run_token), name, body, send);
  const finish = (run, body = {}, sender = send) => finishRun(env, run.id, { ok: true, output: 'result', session_id: 'session', ...body }, sender);
  const row = (table, id) => sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  const incoming = (task, id = 99) => receiveTaskMail(env, { sender: task.owner, agent: 'claude', msgId: id,
    mail: { inReplyTo: task.rfc_message_id, messageId: `<mail-${id}@x>`, subject: 'follow', text: 'new instruction' } }, send);
  // Inject a competing transaction immediately before the next atomic batch.
  const beforeBatch = (action) => {
    const original = DB.batch;
    DB.batch = async statements => { DB.batch = original; await action(); return original(statements); };
  };
  return { DB, sqlite, env, sent, send, create, claim, tool, finish, row, incoming, beforeBatch };
}

for (const count of [1, 8]) test(`E1 queued mail preserves reply/files and successful run ${count}`, async t => {
  const f = fixture(t), task = await f.create(), run = await f.claim();
  f.sqlite.prepare('UPDATE tasks SET run_count=? WHERE id=?').run(count, task.id);
  await f.tool(run, 'reply', { text: 'part one' });
  await f.incoming(task);
  const dir = mkdtempSync(join(tmpdir(), 'mailbot-e1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outbox = prepareOutbox(dir, run.id);
  writeFileSync(join(outbox.path, 'result.txt'), 'a');
  const files = finalizeFiles({ result: { ok: true }, outbox, dir, job: run });
  assert.equal(existsSync(outbox.path), false);
  const body = { attachments: files.attachments };
  await f.finish(run, body);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /part one/);
  assert.equal(f.sent[0].attachments[0].b64_lines, 'YQ==');
  assert.notEqual(f.row('tasks', task.id).status, 'failed');
  const next = await f.claim();
  assert.ok(next); assert.equal(next.resume_session, 'session');
  assert.equal(next.events[0].kind, 'mail');
  await f.finish(run, body); assert.equal(f.sent.length, 1);
  await f.finish(next); assert.equal(f.sent.length, 2);
});

for (const mode of ['explicit', 'auto', 'partial-all']) test(`E2 mail wake inherits unfinished child wait: ${mode}`, async t => {
  const f = fixture(t), task = await f.create(), parent = await f.claim();
  const a = await f.tool(parent, 'spawn', { agent: 'codex', prompt: 'a' });
  const ar = await f.claim('codex');
  let b, br;
  if (mode === 'partial-all') {
    b = await f.tool(parent, 'spawn', { agent: 'agy', prompt: 'b' }); br = await f.claim('agy');
    await f.finish(ar);
  }
  if (mode !== 'auto') await f.tool(parent, 'await', { ids: b ? [a.task_id, b.task_id] : [a.task_id] });
  await f.incoming(task); await f.finish(parent);
  const next = await f.claim(); assert.ok(next);
  await f.finish(next);
  assert.equal(f.row('tasks', task.id).status, 'waiting');
  assert.equal(f.row('tasks', b?.task_id || a.task_id).status, 'active');
  await f.finish(br || ar);
  const summary = await f.claim(); assert.ok(summary);
  await f.finish(summary); assert.equal(f.row('tasks', task.id).status, 'done');
  assert.equal(f.sent.length, 1);
});

test('E3 notify reserves slot 15 for final reply with attachment; mail at 14 starts a new root', async t => {
  const f = fixture(t), task = await f.create(), run = await f.claim();
  f.sqlite.prepare('UPDATE tasks SET mail_count=13 WHERE id=?').run(task.id);
  assert.equal((await f.tool(run, 'notify', { text: 'last progress' })).ok, true);
  assert.equal((await f.tool(run, 'notify', { text: 'overflow' })).code, 409);
  const fresh = await f.incoming(task); assert.notEqual(fresh.id, task.id);
  await f.finish(run, { attachments: [{ filename: 'final.txt', mime_type: 'text/plain', b64_lines: 'YQ==' }] });
  assert.equal(f.row('tasks', task.id).mail_count, 15);
  assert.equal(f.sent.at(-1).attachments.length, 1);
});

test('E3 queued mail reserves its own final slot across notify and finish', async t => {
  const f = fixture(t), task = await f.create(), run = await f.claim();
  f.sqlite.prepare('UPDATE tasks SET mail_count=13 WHERE id=?').run(task.id);
  await f.incoming(task);
  assert.equal((await f.tool(run, 'notify', { text: 'would consume next final slot' })).code, 409);
  await f.finish(run); const next = await f.claim(); assert.ok(next);
  await f.finish(next);
  assert.equal(f.row('tasks', task.id).mail_count, 15); assert.equal(f.sent.length, 2);
});

test('E1/E3 a full queued batch at mail_count 13 routes further mail to another root', async t => {
  const f = fixture(t), task = await f.create(), run = await f.claim();
  f.sqlite.prepare('UPDATE tasks SET mail_count=13 WHERE id=?').run(task.id);
  for (let i = 0; i < 128; i++) assert.equal((await f.incoming(task, 1000 + i)).id, task.id);
  const overflow = await f.incoming(task, 2000); assert.notEqual(overflow.id, task.id);
  await f.finish(run); const next = await f.claim();
  // The overflow root was reserved first, so finish it before the old continuation.
  assert.equal(next.task_id, overflow.id); await f.finish(next);
  const continuation = await f.claim(); assert.equal(continuation.events.length, 128);
  await f.finish(continuation);
  assert.equal(f.row('tasks', task.id).mail_count, 15);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM events WHERE task_id=? AND run_id IS NULL').get(task.id).n, 0);
});

test('E4 stale cron snapshot cannot fail a run already finished into waiting', async t => {
  const f = fixture(t), task = await f.create(), run = await f.claim();
  await f.tool(run, 'spawn', { agent: 'codex', prompt: 'child' });
  f.sqlite.prepare('UPDATE tasks SET run_count=max_runs WHERE id=?').run(task.id);
  f.sqlite.prepare("UPDATE runs SET claimed_at='2000' WHERE id=?").run(run.id);
  // finish phase one won, before its follow-up schedule starts.
  f.beforeBatch(() => {
    f.sqlite.prepare("UPDATE runs SET status='done',finish_key='winner',token_hash=NULL WHERE id=?").run(run.id);
    f.sqlite.prepare("UPDATE tasks SET status='waiting',wait_json=? WHERE id=?").run(JSON.stringify({ mode: 'all', ids: [task.id + 1] }), task.id);
  });
  await cronTick(f.env, f.send);
  assert.equal(f.row('runs', run.id).status, 'done');
  assert.equal(f.row('tasks', task.id).status, 'waiting');
  assert.equal(f.row('tasks', task.id).lost_count, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='run_lost'").get().n, 0);
});

test('E6 persistent send error cannot starve newer pending mail or another error', async t => {
  const f = fixture(t), a = await f.create(), b = await f.create();
  await completeTask(f.env, { taskId: a.id, status: 'failed', result: 'a' });
  await completeTask(f.env, { taskId: b.id, status: 'failed', result: 'b' });
  const attempted = [];
  const sender = async (_env, mail) => { attempted.push(mail.text); if (mail.text.includes(': a')) throw new Error('permanent'); };
  await cronTick(f.env, sender); await cronTick(f.env, sender);
  assert.ok(attempted.some(text => text.includes(': b')));
  // Two error rows also rotate, rather than always retrying the lowest id.
  f.sqlite.exec("UPDATE outbound_mails SET status='error',send_key=NULL");
  attempted.length = 0;
  const failing = async (_env, mail) => { attempted.push(mail.text); throw new Error('permanent'); };
  await cronTick(f.env, failing); await cronTick(f.env, failing);
  assert.equal(new Set(attempted).size, 2);
});

test('E6 complete/cancel send durable terminal mail immediately; email cancel sends one command reply only', async t => {
  const f = fixture(t), a = await f.create(), b = await f.create();
  await completeTask(f.env, { taskId: a.id, status: 'failed', result: 'TTL' }, f.send);
  assert.equal(f.sent.length, 1);
  await cancelTask(f.env, b.id, b.owner, f.send); assert.equal(f.sent.length, 2);
  const c = await f.create();
  await receiveTaskMail(f.env, { sender: c.owner, agent: 'claude', msgId: 1, mail: { subject: `/cancel=${c.id}` } }, f.send);
  assert.equal(f.sent.length, 3);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM outbound_mails WHERE task_id=?').get(c.id).n, 0);
  const d = await f.create();
  for (let i = 0; i < 30; i++) f.sqlite.prepare('INSERT INTO command_receipts(sender,created_at) VALUES(?,?)').run(d.owner, new Date().toISOString());
  const result = await receiveTaskMail(f.env, { sender: d.owner, agent: 'claude', msgId: 2, mail: { subject: '/cancel' } }, f.send);
  assert.equal(result.status, 'command_suppressed');
  await cronTick(f.env, f.send); assert.equal(f.sent.length, 3);
});

test('E6 schedule budget exhaustion sends terminal immediately when sender is provided', async t => {
  const f = fixture(t), task = await f.create();
  f.sqlite.exec("UPDATE runs SET status='failed'; UPDATE tasks SET run_count=max_runs");
  await schedule(f.env, task.id, f.send);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Run budget exhausted/);
});

for (const status of ['failed', 'cancelled']) test(`E7 unconsumed mail protects only live tasks: ${status}`, async t => {
  const f = fixture(t), task = await f.create(); await f.claim(); await f.incoming(task);
  assert.equal(f.sqlite.prepare(liveMessages).get().message_id, 99);
  await completeTask(f.env, { taskId: task.id, status, result: status });
  assert.equal(f.sqlite.prepare(liveMessages).get(), undefined);
});

for (const change of ['failed', 'cancelled', 'expired', 'quota']) test(`E8 map/batch race routes mail to new root: ${change}`, async t => {
  const f = fixture(t), task = await f.create(); await f.claim();
  f.beforeBatch(() => {
    if (change === 'expired') f.sqlite.prepare("UPDATE tasks SET expires_at='2000' WHERE id=?").run(task.id);
    else if (change === 'quota') f.sqlite.prepare('UPDATE tasks SET mail_count=14 WHERE id=?').run(task.id);
    else return completeTask(f.env, { taskId: task.id, status: change, result: 'race' });
  });
  const result = await f.incoming(task);
  assert.notEqual(result.id, task.id);
  assert.equal(f.sqlite.prepare('SELECT task_id FROM events WHERE message_id=99').get().task_id, result.id);
});

test('E8 duplicate mail event does not create an extra root', async t => {
  const f = fixture(t), task = await f.create(); await f.claim();
  await f.incoming(task); await f.incoming(task);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM events WHERE message_id=99').get().n, 1);
});

test('E9 recovery claim includes attachments of lost start and mail events without replaying tools', async t => {
  const f = fixture(t), task = await f.create(), run = await f.claim();
  f.sqlite.exec("INSERT INTO messages(id,received_at,envelope_from,envelope_to) VALUES(1,'now','a@example.com','claude@example.com'),(2,'now','a@example.com','claude@example.com')");
  f.sqlite.prepare('UPDATE events SET message_id=1 WHERE run_id=?').run(run.id);
  f.sqlite.prepare("INSERT INTO events(task_id,run_id,kind,message_id,payload_json,dedupe_key,created_at) VALUES(?,?,'mail',2,'{}','original-mail','now')").run(task.id, run.id);
  f.sqlite.exec("INSERT INTO attachments(message_id,filename,mime_type,size,content_b64) VALUES(1,'a.txt','text/plain',1,'YQ=='),(2,'b.txt','text/plain',1,'Yg==')");
  await f.tool(run, 'notify', { text: 'already sent' });
  f.sqlite.prepare("UPDATE runs SET claimed_at='2000' WHERE id=?").run(run.id);
  await cronTick(f.env, f.send);
  assert.deepEqual(f.sqlite.prepare(liveMessages).all().map(e => e.message_id).sort(), [1, 2]);
  const next = await f.claim(); assert.deepEqual(next.attachments.map(a => a.message_id), [1, 2]);
  assert.deepEqual(f.sqlite.prepare(liveMessages).all().map(e => e.message_id).sort(), [1, 2]);
  assert.deepEqual(next.events.map(e => e.kind), ['run_lost']); assert.equal(f.sent.length, 1);
});

test('E9 expired tasks do not consume the two queue sweep slots', async t => {
  const f = fixture(t), tasks = [];
  for (let i = 0; i < 5; i++) tasks.push(await f.create());
  f.sqlite.exec("UPDATE runs SET status='done'; UPDATE events SET run_id=NULL");
  f.sqlite.prepare("UPDATE tasks SET expires_at='2000'").run();
  for (const task of tasks.slice(3)) f.sqlite.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run(new Date(Date.now() + 86400000).toISOString(), task.id);
  const result = await cronTick(f.env, f.send);
  assert.equal(result.queued, 2);
  assert.deepEqual(f.sqlite.prepare("SELECT task_id FROM runs WHERE status='pending' ORDER BY task_id").all().map(r => r.task_id), tasks.slice(3).map(t => t.id));
});

test('E9 retention compares ISO timestamps correctly on the seventh-day boundary', async t => {
  const f = fixture(t), task = await f.create();
  const now = new Date('2026-11-18T12:00:00.000Z');
  t.mock.method(globalThis, 'Date', class extends Date { constructor(...args) { super(...(args.length ? args : [now.valueOf()])); } static now() { return now.valueOf(); } });
  f.sqlite.exec("UPDATE runs SET status='done'; UPDATE tasks SET status='done',finished_at='2026-11-11T11:00:00.000Z'");
  const insert = f.sqlite.prepare("INSERT INTO tasks(agent,owner,title,deliver,rfc_message_id,created_at,updated_at,expires_at) VALUES('claude','a@example.com','new','email',?,'now','now','2999')");
  for (let i = 0; i < 1000; i++) insert.run(`<new-${i}@x>`);
  await cronTick(f.env, f.send);
  assert.equal(f.row('tasks', task.id), undefined);
});

test('E9 finish retry uses committed finish_key for descendant parent recovery', async t => {
  const f = fixture(t); await f.create(); const run = await f.claim();
  const prepare = f.DB.prepare; let committedKey, checked = false;
  f.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('SELECT DISTINCT c.parent_id')) {
      const bind = statement.bind;
      statement.bind = (...args) => {
        committedKey ||= f.row('runs', run.id).finish_key;
        if (!checked) { checked = true; throw new Error('phase two interrupted'); }
        assert.equal(args[0], committedKey);
        return bind.apply(statement, args);
      };
    }
    return statement;
  };
  await assert.rejects(f.finish(run), /phase two interrupted/);
  await f.finish(run); assert.equal(f.sent.length, 1);
});
