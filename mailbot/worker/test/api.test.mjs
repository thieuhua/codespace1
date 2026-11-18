import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { database } from '../test-support/d1.mjs';

// Cloudflare-only constructor, without network or a Worker runtime.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:email') return { url: 'data:text/javascript,export class EmailMessage { constructor(from,to,raw){Object.assign(this,{from,to,raw})} }', shortCircuit: true };
  return next(specifier, context);
} });
const { default: worker } = await import('../src/index.js');
hooks.deregister();

function setup(t) {
  const { DB, sqlite } = database(t), sent = [];
  sqlite.exec("INSERT INTO allowlist VALUES ('a@example.com','*','now')");
  const env = { DB, MAIL_DOMAIN: 'example.com', API_TOKEN: 'reader', ADMIN_TOKEN: 'admin', EMAIL: { async send(m) { sent.push(m); } } };
  const api = (path, token = 'admin', body, headers = {}, method) => worker.fetch(new Request('https://offline.test' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const email = async (to, auth = 'pass') => {
    const raw = `Authentication-Results: mx.cloudflare.net; dmarc=${auth} header.from=example.com\r\nFrom: a@example.com\r\nTo: ${to}\r\nSubject: test\r\nMessage-ID: <root@x>\r\n\r\nDo work`;
    let rejected = null;
    await worker.email({ from: 'a@example.com', to, rawSize: raw.length, raw: new Blob([raw]).stream(), headers: new Headers(), setReject(s) { rejected = s; } }, env, { waitUntil() {} });
    return rejected;
  };
  return { sqlite, sent, api, email };
}

test('SMTP handler rejects unknown/unauthenticated tagged recipients; bare claude remains public', async (t) => {
  const { email, sqlite, api } = setup(t);
  assert.ok(await email('unknown@example.com'));
  assert.ok(await email('claude+demo@example.com', 'fail'));
  assert.ok(await email('codex@example.com', 'fail'));
  assert.ok(await email('claude@evil.com'));
  assert.equal(await email('claude@example.com', 'fail'), null);
  assert.equal(await email('claude+demo@example.com'), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM messages').get().n, 2);
  assert.equal(sqlite.prepare('SELECT project FROM tasks').get().project, 'demo');
  const visible = await (await api('/messages', 'reader')).json();
  assert.equal(visible.messages.length, 1);
  const privateId = sqlite.prepare("SELECT id FROM messages WHERE envelope_to LIKE '%+%'").get().id;
  for (const suffix of ['', '/attachments/1']) assert.equal((await api(`/messages/${privateId}${suffix}`, 'reader')).status, 404);
  assert.equal((await api(`/messages/${privateId}/read`, 'reader', {})).status, 404);
  assert.equal((await api('/tasks', 'reader')).status, 403);
});

test('admin/run APIs separate auth; old job APIs removed; owner fixed; finish revokes scoped token', async (t) => {
  const { api, sent } = setup(t);
  assert.equal((await api('/tasks', 'reader', {agent:'claude',prompt:'x',owner:'a@example.com'})).status,403);
  assert.equal((await api('/jobs')).status,404);
  assert.equal((await api('/job-api/notify','',{})).status,401);
  const {task}=await (await api('/tasks','admin',{agent:'claude',prompt:'x',project:'demo',owner:'a@example.com'})).json();
  const {run}=await (await api('/runs/claim','admin',{agents:['claude']})).json();
  assert.equal(run.task_id,task.id);
  const headers={'X-Run-Token':run.run_token};
  assert.equal((await api('/run-api/notify','admin',{text:'x'})).status,401);
  assert.equal((await api('/tasks',run.run_token)).status,401);
  assert.equal((await api('/run-api/notify','',{text:'hi'},headers)).status,200);
  assert.equal(sent[0].to,'a@example.com');assert.equal(sent[0].from,'claude+demo@example.com');
  await api(`/runs/${run.id}/result`,'admin',{ok:true,output:'done',session_id:'session'});
  const detail=await (await api(`/tasks/${task.id}?owner=a%40example.com`)).json();
  assert.equal(detail.task.status,'done');assert.equal(detail.runs[0].output,'done');
  assert.equal(Object.hasOwn(detail.runs[0],'token_hash'),false);
  assert.equal((await api('/run-api/notify','',{text:'late'},headers)).status,401);
  assert.equal((await api(`/tasks/${task.id}?owner=other%40example.com`)).status,404);
  const results=await (await api('/tasks?owner=a%40example.com')).json();assert.equal(results.tasks.length,1);
});

test('P4 admin answer endpoint enforces auth/owner/state and delivers answer as mail event',async t=>{
  const {api,sqlite}=setup(t);
  const {task}=await (await api('/tasks','admin',{agent:'claude',prompt:'work',owner:'a@example.com'})).json();
  const path=`/tasks/${task.id}/answer?owner=a%40example.com`;
  assert.equal((await api(path,'reader',{text:'answer'})).status,403);
  assert.equal((await api(path,'admin',{text:'answer'})).status,409);
  const {run}=await (await api('/runs/claim','admin',{agents:['claude']})).json();
  const headers={'X-Run-Token':run.run_token};
  assert.equal((await api('/run-api/ask_user','',{question:'choose?',timeout_seconds:60},headers)).status,200);
  await api(`/runs/${run.id}/result`,'admin',{ok:true,output:'waiting'});
  const list=await (await api('/tasks?owner=a%40example.com')).json();
  assert.equal(JSON.parse(list.tasks[0].wait_json).mode,'user');assert.ok(list.tasks[0].wait_until);
  assert.equal((await api(`/tasks/${task.id}/answer`,'admin',{text:'answer'})).status,400);
  assert.equal((await api(`/tasks/${task.id}/answer?owner=b%40example.com`,'admin',{text:'answer'})).status,409);
  assert.equal((await api(path,'admin',{text:'blue'})).status,200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM events WHERE kind='mail'").get().n,1);
  const {run:next}=await (await api('/runs/claim','admin',{agents:['claude']})).json();
  assert.equal(next.task_id,task.id);assert.match(next.events[0].payload_json,/blue/);
  assert.equal((await api(path,'admin',{text:'late'})).status,409);
});

 test('mail events protect incoming attachments from deletion until their run finishes',async t=>{
  const {api,email,sqlite}=setup(t);
  await email('claude@example.com');
  const id=sqlite.prepare('SELECT id FROM messages').get().id;
  assert.equal((await api(`/messages/${id}`,'admin',undefined,{},'DELETE')).status,409);
  assert.equal(sqlite.prepare('SELECT message_id FROM events').get().message_id,id);
  const {run}=await (await api('/runs/claim','admin',{agents:['claude']})).json();
  assert.equal(run.events[0].message_id,id);
  await api(`/runs/${run.id}/result`,'admin',{ok:true,output:'done'});
  assert.equal((await api(`/messages/${id}`,'admin',undefined,{},'DELETE')).status,200);
});

for (const status of ['failed', 'cancelled']) test(`E7 DELETE releases unconsumed mail of ${status} task`, async t => {
  const { api, email, sqlite } = setup(t);
  await email('claude@example.com');
  const id = sqlite.prepare('SELECT id FROM messages').get().id;
  const { run } = await (await api('/runs/claim', 'admin', { agents: ['claude'] })).json();
  sqlite.prepare("INSERT INTO events(task_id,kind,message_id,payload_json,dedupe_key,created_at) VALUES(?,'mail',?,'{}','late','now')").run(run.task_id, id);
  if (status === 'failed') await api(`/runs/${run.id}/result`, 'admin', { ok: false, output: 'error' });
  else {
    const before = sqlite.prepare('SELECT COUNT(*) n FROM outbound_mails').get().n;
    await api(`/tasks/${run.task_id}/cancel?owner=a%40example.com`, 'admin', {});
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM outbound_mails WHERE status=\'sent\'').get().n, before + 1);
  }
  assert.equal((await api(`/messages/${id}`, 'admin', undefined, {}, 'DELETE')).status, 200);
  assert.equal(sqlite.prepare('SELECT id FROM messages WHERE id=?').get(id), undefined);
});
