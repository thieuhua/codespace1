import test from 'node:test';
import assert from 'node:assert/strict';
import { codexInventoryCache, agyMcpCheck } from '../mcp-isolation.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
test('Codex concurrent checks share both inspections, cache by entry/cwd and retry failures', async () => {
  let calls = 0, now = 0, bad = false;
  const check = codexInventoryCache(async (_cmd, args) => {
    calls++; await turn();
    if (bad) throw new Error('offline');
    return JSON.stringify([{ name: 'admin', enabled: !args.includes('mcp_servers.admin.enabled=false') }]);
  }, () => now);
  const values = await Promise.all(Array.from({ length: 20 }, () => check('codex.js', 'cwd')));
  assert.equal(calls, 2); assert.ok(values.every(value => value === values[0]));
  assert.throws(() => { values[0][0].enabled = false; });
  await check('codex.js', 'other-cwd'); assert.equal(calls, 4);
  await check('other-entry.js', 'cwd'); assert.equal(calls, 6);
  now = 600000; bad = true;
  const failed = await Promise.allSettled(Array.from({ length: 10 }, () => check('codex.js', 'cwd')));
  assert.ok(failed.every(r => r.status === 'rejected')); assert.equal(calls, 7);
  bad = false; await check('codex.js', 'cwd'); assert.equal(calls, 9);
});

test('Codex verification failure is not cached', async () => {
  let calls = 0, bad = true;
  const check = codexInventoryCache(async () => { calls++; return bad ? '[{"name":"admin","enabled":true}]' : '[]'; });
  await assert.rejects(check('entry', 'cwd'));
  bad = false; await check('entry', 'cwd'); assert.equal(calls, 4);
});

test('agy single-flight shares only overlapping inventory, validates each allowlist, never caches errors or successes', async () => {
  let calls = 0, bad = false;
  const check = agyMcpCheck(async () => {
    calls++; await turn(); if (bad) throw new Error('MCP unavailable');
    return 'NAME TYPE STATUS COMMAND/URL\nadmin stdio enabled fake';
  });
  const checks = await Promise.allSettled([check('agy', 'cwd', ['admin']), check('agy', 'cwd', []), check('agy', 'cwd', ['admin'])]);
  assert.deepEqual(checks.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']); assert.equal(calls, 1);
  await check('agy', 'cwd', ['admin']); assert.equal(calls, 2);
  bad = true;
  const failed = await Promise.allSettled([check('agy', 'cwd'), check('agy', 'cwd')]);
  assert.ok(failed.every(r => r.status === 'rejected')); assert.equal(calls, 3);
  bad = false; await check('agy', 'cwd', ['admin']); assert.equal(calls, 4);
  await Promise.all([check('agy', 'one', ['admin']), check('agy', 'two', ['admin'])]); assert.equal(calls, 6);
});
