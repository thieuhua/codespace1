import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastOutput } from '../cli-output.mjs';
import { finalizeFiles } from '../job-finalize.mjs';
import { prepareOutbox } from '../outbox.mjs';
import { saveInboxAttachment } from '../inbox.mjs';
import { codexDisableArgs, codexMcpArgs } from '../run-mcp.mjs';
import { agyEnabledServers, verifyAgyMcp, codexInventoryCache } from '../mcp-isolation.mjs';
import { claudeSettings, claudeIsolationArgs } from '../cli-options.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mailbot-c-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('C2 Claude denies git metadata and worktree-state Read/Edit', () => {
  const args = claudeIsolationArgs();
  assert.ok(args.includes('--restricted'));
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write,Bash');
  const deny = JSON.parse(claudeSettings('C:\\Users\\test', 'E:\\mailbot-work')).permissions.deny;
  for (const path of ['**/.git', '**/.git/**', '**/worktree-state/**', '//e/mailbot-work/worktree-state/**', '**/task-state/**', '//e/mailbot-work/task-state/**'])
    for (const tool of ['Read', 'Edit']) assert.ok(deny.includes(`${tool}(${path})`));
});

test('C3 regular last output is read/deleted, hardlink is never read/deleted', (t) => {
  const dir = fixture(t), path = join(dir, '.codex-last-1.txt'), target = join(dir, 'private');
  writeFileSync(path, 'result');
  assert.equal(readLastOutput(path, dir), 'result');
  assert.equal(existsSync(path), false);
  writeFileSync(target, 'private'); linkSync(target, path);
  assert.throws(() => readLastOutput(path, dir), /tệp thường độc lập/);
  assert.equal(readFileSync(target, 'utf8'), 'private');
  assert.equal(existsSync(path), true);
});

test('C3 last output symlink and outside cwd are rejected', (t) => {
  const dir = fixture(t), path = join(dir, '.codex-last-1.txt'), target = join(dir, 'private');
  writeFileSync(target, 'private');
  assert.throws(() => readLastOutput(target, join(dir, 'wrong')));
  try { symlinkSync(target, path); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip(`symlink permission ${e.code}`); throw e; }
  assert.throws(() => readLastOutput(path, dir));
  assert.equal(readFileSync(target, 'utf8'), 'private');
});

for (const flag of ['cancelled', 'timedOut']) test(`C4/C7 ${flag}: no commit or attachments, clean inbox/outbox and release lock`, (t) => {
  const dir = fixture(t), job = { id: 1 }, outbox = prepareOutbox(dir, 1);
  const inboxPath = saveInboxAttachment(dir, 1, 1, { filename: 'a.txt', content_b64: 'YQ==' });
  writeFileSync(join(outbox.path, 'partial.txt'), 'unfinished');
  const result = { ok: true, session_id: 'sid', [flag]: true };
  let committed = false, unlocked = false;
  const files = finalizeFiles({ result, job, dir, outbox, worktree: {}, unlock: () => { unlocked = true; } },
    { commit: () => { committed = true; } });
  assert.equal(committed, false); assert.equal(unlocked, true);
  assert.equal(result.ok, false); assert.equal(result.session_id, null);
  assert.deepEqual(files.attachments, []);
  assert.equal(existsSync(inboxPath), false); assert.equal(existsSync(outbox.path), false);
});

test('C5/A pure Codex args disable plugins and every inherited MCP, quote TOML keys, then enable only job MCP', () => {
  const servers = [{ name: 'admin', enabled: true }, { name: 'a.b "quoted"', enabled: false }, { name: 'mailbot-run', enabled: true }];
  const args = codexMcpArgs({ command: 'node', args: ['job.mjs'], env: { MAILBOT_RUN_TOKEN: 'scoped' } }, servers);
  assert.deepEqual(args.slice(0, 2), ['--disable', 'plugins']);
  assert.ok(args.includes('mcp_servers.admin.enabled=false'));
  assert.ok(args.includes('mcp_servers."a.b \\"quoted\\"".enabled=false'));
  assert.ok(args.indexOf('mcp_servers.mailbot-run.enabled=false') < args.indexOf('mcp_servers.mailbot-run.enabled=true'));
  assert.ok(!args.includes('mcp_servers={}'));
  assert.throws(() => codexDisableArgs([{ name: 'x' }]));
});

test('C5/A Codex inventory cache lasts ten minutes, verifies disabled inventory, fails closed on bad results', async () => {
  let now = 0, calls = 0;
  const inspect = async (_cmd, args) => {
    calls++;
    assert.ok(args.includes('--disable')); assert.ok(args.includes('plugins'));
    return JSON.stringify([{ name: 'global', enabled: !args.includes('mcp_servers.global.enabled=false') }]);
  };
  const inventory = codexInventoryCache(inspect, () => now);
  assert.deepEqual(await inventory('codex.js', 'cwd'), [{ name: 'global', enabled: true }]);
  await inventory('codex.js', 'cwd'); assert.equal(calls, 2);
  now = 600000; await inventory('codex.js', 'cwd'); assert.equal(calls, 4);
  for (const bad of ['not json', '{}', '[{"name":"admin","enabled":true}]']) {
    const unsafe = codexInventoryCache(async () => bad);
    await assert.rejects(unsafe('entry', 'cwd'));
  }
});

test('C5/B agy rejects unknown enabled globals, allows explicit names, rejects unreadable inventory', () => {
  const output = 'NAME           TYPE  STATUS   COMMAND/URL\r\nagent_mailbox  http  enabled  http://127.0.0.1:8766/mcp\r\nadmin stdio disabled node admin.mjs';
  assert.deepEqual(agyEnabledServers(output), ['agent_mailbox']);
  assert.throws(() => verifyAgyMcp(output), /agent_mailbox/);
  assert.doesNotThrow(() => verifyAgyMcp(output, ['agent_mailbox']));
  assert.doesNotThrow(() => verifyAgyMcp('NAME TYPE STATUS COMMAND/URL'));
  for (const bad of ['', 'Error reading config', 'NAME TYPE STATUS COMMAND/URL\nx http unknown url']) assert.throws(() => verifyAgyMcp(bad));
  assert.throws(() => verifyAgyMcp(output, 'agent_mailbox'));
});
