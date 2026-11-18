import test from 'node:test';
import assert from 'node:assert/strict';
import { codexInventoryCache, agyMcpCheck } from '../mcp-isolation.mjs';
import { codexMcpArgs } from '../run-mcp.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const turn = () => new Promise(resolve => setImmediate(resolve));
test('Codex shares overlapping inspections by entry/cwd, rechecks sequential calls and retries failures', async () => {
  let calls = 0, bad = false;
  const check = codexInventoryCache(async (_cmd, args) => {
    calls++; await turn();
    if (bad) throw new Error('offline');
    return JSON.stringify([{ name: 'admin', enabled: !args.includes('mcp_servers.admin.enabled=false') }]);
  });
  const values = await Promise.all(Array.from({ length: 20 }, () => check('codex.js', 'cwd')));
  assert.equal(calls, 2); assert.ok(values.every(value => value === values[0]));
  assert.throws(() => { values[0][0].enabled = false; });
  await check('codex.js', 'cwd'); assert.equal(calls, 4);
  await check('codex.js', 'other-cwd'); assert.equal(calls, 6);
  await check('other-entry.js', 'cwd'); assert.equal(calls, 8);
  bad = true;
  const failed = await Promise.allSettled(Array.from({ length: 10 }, () => check('codex.js', 'cwd')));
  assert.ok(failed.every(r => r.status === 'rejected')); assert.equal(calls, 9);
  bad = false; await check('codex.js', 'cwd'); assert.equal(calls, 11);
});

for (const refusesDisable of [false, true]) test(`P3.4 project-local server created after run 1 is disabled or refused on run 2 (refusal=${refusesDisable})`, async t => {
  const cwd=mkdtempSync(join(tmpdir(),'mailbot-mcp-local-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const local=join(cwd,'.codex');mkdirSync(local);
  const config=join(local,'config.toml');writeFileSync(config,'');
  let calls=0;
  const inventory=codexInventoryCache(async(_cmd,args,dir)=>{
    calls++;assert.equal(dir,cwd);
    // Offline CLI inventory double derives its result from the current cwd.
    if(!readFileSync(config,'utf8'))return '[]';
    return JSON.stringify([{name:'project-local',enabled:refusesDisable||!args.includes('mcp_servers.project-local.enabled=false')}]);
  });
  assert.deepEqual(await inventory('entry',cwd),[]);
  writeFileSync(config,'[mcp_servers.project-local]\ncommand = "fake-server"\n');
  if(refusesDisable)await assert.rejects(inventory('entry',cwd));
  else assert.ok(codexMcpArgs(null,await inventory('entry',cwd)).includes('mcp_servers.project-local.enabled=false'));
  assert.equal(calls,4);
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
