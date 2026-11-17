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
  const api = (path, token = 'admin', body, headers = {}) => worker.fetch(new Request('https://offline.test' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
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
  assert.equal(sqlite.prepare('SELECT project FROM jobs').get().project, 'demo');
  const visible = await (await api('/messages', 'reader')).json();
  assert.equal(visible.messages.length, 1);
  const privateId = sqlite.prepare("SELECT id FROM messages WHERE envelope_to LIKE '%+%'").get().id;
  for (const suffix of ['', '/attachments/1']) assert.equal((await api(`/messages/${privateId}${suffix}`, 'reader')).status, 404);
  assert.equal((await api(`/messages/${privateId}/read`, 'reader', {})).status, 404);
  assert.equal((await api('/jobs', 'reader')).status, 403);
});

test('admin/job APIs separate auth; result clears token; detail exposes output/outbox without token hash', async (t) => {
  const { api, sent } = setup(t);
  assert.equal((await api('/jobs', 'reader', { agent: 'claude', prompt: 'x', reply_to: 'a@example.com' })).status, 403);
  const { job: pending } = await (await api('/jobs', 'admin', { agent: 'claude', prompt: 'x', project: 'demo', reply_to: 'a@example.com' })).json();
  const { job } = await (await api('/jobs/claim', 'admin', { agents: ['claude'] })).json();
  assert.equal(job.id, pending.id);
  const headers = { 'X-Job-Token': job.job_token };
  assert.equal((await api('/job-api/notify', 'admin', { subject: 'x', body: 'x' })).status, 401);
  assert.equal((await api('/jobs', job.job_token)).status, 401);
  assert.equal((await api('/job-api/notify', '', { subject: 'update', body: 'hi' }, headers)).status, 200);
  assert.equal(sent[0].to, 'a@example.com'); assert.equal(sent[0].from, 'claude+demo@example.com');
  assert.equal((await api('/job-api/delegate', '', { agent: 'codex', prompt: 'child' }, headers)).status, 200);
  await api(`/jobs/${job.id}/result`, 'admin', { ok: true, output: 'done', session_id: 'session' });
  const detail = await (await api(`/jobs/${job.id}`)).json();
  assert.equal(detail.job.output, 'done'); assert.equal(detail.job.outbox_json, '[]');
  assert.equal(Object.hasOwn(detail.job, 'job_token_hash'), false);
  assert.equal((await api('/job-api/notify', '', { subject: 'x', body: 'x' }, headers)).status, 401);
  const jobs = await (await api('/jobs')).json();
  const child = jobs.jobs.find((j) => j.parent_id === job.id);
  assert.equal((await api(`/jobs/${child.id}/cancel`, 'admin', {})).status, 200);
  assert.equal((await (await api(`/jobs/${child.id}`)).json()).job.status, 'cancelled');
});
