import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRunTools } from '../run-tools.mjs';
import { createOrchestrator } from '../orchestrator.mjs';

async function connect(t, server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('run MCP exposes only run tools, uses scoped header, propagates API errors', async (t) => {
  const calls = [];
  const client = await connect(t, createRunTools({ url: 'https://example.com', token: 'run-token' }, async (url, init) => {
    calls.push({ url, init }); return Response.json({ error: 'limit' }, { status: 409 });
  }));
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), ['ask_user', 'await', 'notify', 'reply', 'spawn']);
  const result = await client.callTool({ name: 'notify', arguments: { text: 'body' } });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /409/);
  assert.equal(calls[0].url, 'https://example.com/run-api/notify');
  assert.equal(calls[0].init.headers['X-Run-Token'], 'run-token');
  assert.equal(calls[0].init.headers.authorization, undefined);
  await client.callTool({ name: 'spawn', arguments: { agent: 'codex', prompt: 'x' } });
  assert.equal(calls[1].url, 'https://example.com/run-api/spawn');
  const ask=await client.callTool({name:'ask_user',arguments:{question:'clarify'}});
  assert.equal(ask.isError,true);assert.match(ask.content[0].text,/409/);assert.equal(calls.length,3);
  assert.equal(calls[2].url,'https://example.com/run-api/ask_user');
  await client.callTool({name:'ask_user',arguments:{question:'clarify',timeout_seconds:60}});
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{question:'clarify',timeout_seconds:60});
  await client.callTool({name:'await',arguments:{seconds:60}});
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{seconds:60});
  await client.callTool({name:'await',arguments:{ids:[1]}});
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{ids:[1]});
  const count=calls.length;
  assert.equal((await client.callTool({name:'await',arguments:{seconds:59}})).isError,true);
  assert.equal(calls.length,count);
  await client.callTool({name:'reply',arguments:{text:'final',files:['secret']}});
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{text:'final'});
});

test('orchestrator has no inbox tool, fixes owner to owner, polls with bounds and maps admin paths', async (t) => {
  const calls = [], sleeps = [];
  const client = await connect(t, createOrchestrator({ url: 'https://example.com', admin_token: 'admin', owner: 'owner@example.com' }, async (url, init) => {
    calls.push({ url, init });
    return Response.json({ task: { id: 7, status: init.method === 'POST' ? 'active' : 'done' } });
  }, async (ms) => { sleeps.push(ms); }));
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), ['allowlist_list', 'answer_task', 'cancel_task', 'get_task', 'list_tasks', 'submit_task']);
  const result = await client.callTool({ name: 'submit_task', arguments: { agent: 'agy', prompt: 'x', project: 'demo', wait_seconds: 5, owner: 'evil@example.com' } });
  assert.equal(JSON.parse(result.content[0].text).task.status, 'done');
  assert.equal(JSON.parse(calls[0].init.body).owner, 'owner@example.com');
  assert.equal(calls[0].init.headers.authorization, 'Bearer admin');
  assert.deepEqual(sleeps, [2000]);
  await client.callTool({ name: 'list_tasks', arguments: {} });
  await client.callTool({ name: 'get_task', arguments: { id: 7 } });
  await client.callTool({ name: 'cancel_task', arguments: { id: 7 } });
  await client.callTool({ name: 'allowlist_list', arguments: {} });
  assert.deepEqual(calls.map((c) => c.url.replace('https://example.com', '')), ['/tasks', '/tasks/7?owner=owner%40example.com', '/tasks?owner=owner%40example.com&limit=20', '/tasks/7?owner=owner%40example.com', '/tasks/7/cancel?owner=owner%40example.com', '/allowlist']);
  await client.callTool({name:'answer_task',arguments:{id:7,text:'yes',owner:'evil@example.com'}});
  assert.equal(calls.at(-1).url,'https://example.com/tasks/7/answer?owner=owner%40example.com');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body),{text:'yes'});
});

test('orchestrator stops waiting at deadline and preserves submitted job ID on poll failure', async (t) => {
  let time = 0, polls = 0, fail = false;
  const client = await connect(t, createOrchestrator({ url: 'https://example.com', admin_token: 'admin', owner: 'owner@example.com' }, async (_url, init) => {
    if (init.method === 'GET') { polls++; if (fail) throw new Error('offline'); }
    return Response.json({ task: { id: 9, status: 'active' } });
  }, async (ms) => { time += ms; }, () => time));
  const call = () => client.callTool({ name: 'submit_task', arguments: { agent: 'codex', prompt: 'x', wait_seconds: 3 } });
  assert.equal(JSON.parse((await call()).content[0].text).task.id, 9);
  assert.equal(time, 3000); assert.equal(polls, 1);
  fail = true;
  const result = JSON.parse((await call()).content[0].text);
  assert.equal(result.task.id, 9); assert.match(result.wait_error, /offline/);
});
