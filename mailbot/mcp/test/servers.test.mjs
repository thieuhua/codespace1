import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createJobTools } from '../job-tools.mjs';
import { createOrchestrator } from '../orchestrator.mjs';

async function connect(t, server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('job MCP exposes only job tools, uses job header, propagates API errors', async (t) => {
  const calls = [];
  const client = await connect(t, createJobTools({ url: 'https://example.com', token: 'job-token' }, async (url, init) => {
    calls.push({ url, init }); return Response.json({ error: 'limit' }, { status: 409 });
  }));
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), ['delegate_to_agent', 'notify_sender']);
  const result = await client.callTool({ name: 'notify_sender', arguments: { subject: 'hi', body: 'body' } });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /409/);
  assert.equal(calls[0].url, 'https://example.com/job-api/notify');
  assert.equal(calls[0].init.headers['X-Job-Token'], 'job-token');
  assert.equal(calls[0].init.headers.authorization, undefined);
  await client.callTool({ name: 'delegate_to_agent', arguments: { agent: 'codex', prompt: 'x' } });
  assert.equal(calls[1].url, 'https://example.com/job-api/delegate');
});

test('orchestrator has no inbox tool, fixes reply_to to owner, polls with bounds and maps admin paths', async (t) => {
  const calls = [], sleeps = [];
  const client = await connect(t, createOrchestrator({ url: 'https://example.com', admin_token: 'admin', owner: 'owner@example.com' }, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ job: { id: 7, status: init.method === 'POST' ? 'pending' : 'done' } });
  }, async (ms) => { sleeps.push(ms); }));
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), ['allowlist_list', 'cancel_job', 'get_job', 'list_jobs', 'submit_job']);
  const result = await client.callTool({ name: 'submit_job', arguments: { agent: 'agy', prompt: 'x', project: 'demo', wait_seconds: 5, reply_to: 'evil@example.com' } });
  assert.equal(JSON.parse(result.content[0].text).job.status, 'done');
  assert.equal(JSON.parse(calls[0].init.body).reply_to, 'owner@example.com');
  assert.equal(calls[0].init.headers.authorization, 'Bearer admin');
  assert.deepEqual(sleeps, [2000]);
  await client.callTool({ name: 'list_jobs', arguments: {} });
  await client.callTool({ name: 'get_job', arguments: { id: 7 } });
  await client.callTool({ name: 'cancel_job', arguments: { id: 7 } });
  await client.callTool({ name: 'allowlist_list', arguments: {} });
  assert.deepEqual(calls.map((c) => c.url.replace('https://example.com', '')), ['/jobs', '/jobs/7', '/jobs?limit=20', '/jobs/7', '/jobs/7/cancel', '/allowlist']);
});

test('orchestrator stops waiting at deadline and preserves submitted job ID on poll failure', async (t) => {
  let time = 0, polls = 0, fail = false;
  const client = await connect(t, createOrchestrator({ url: 'https://example.com', admin_token: 'admin', owner: 'owner@example.com' }, async (_url, init) => {
    if (init.method === 'GET') { polls++; if (fail) throw new Error('offline'); }
    return Response.json({ job: { id: 9, status: 'pending' } });
  }, async (ms) => { time += ms; }, () => time));
  const call = () => client.callTool({ name: 'submit_job', arguments: { agent: 'codex', prompt: 'x', wait_seconds: 3 } });
  assert.equal(JSON.parse((await call()).content[0].text).job.id, 9);
  assert.equal(time, 3000); assert.equal(polls, 1);
  fail = true;
  const result = JSON.parse((await call()).content[0].text);
  assert.equal(result.job.id, 9); assert.match(result.wait_error, /offline/);
});
