import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, prepareWorktree, commitWorktree, listWorktrees, pruneWorktrees, lockWorktree } from '../worktrees.mjs';
import { JOB_TOOLS, jobMcp, codexMcpArgs, cliEnv } from '../job-mcp.mjs';

const execFile = childProcess.execFileSync;

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mailbot-wt-test-'));
  // The unelevated Windows sandbox rejects Node pipe handles (EPERM), while file
  // descriptors work. Keep real git and its actual argv, only replace stdio here.
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    const outPath = join(root, 'git-stdout'), errPath = join(root, 'git-stderr');
    const out = openSync(outPath, 'w'), err = openSync(errPath, 'w');
    try {
      execFile(cmd, args, { ...options, stdio: ['ignore', out, err] });
      return readFileSync(outPath, 'utf8');
    } catch (e) { e.stderr = readFileSync(errPath, 'utf8'); throw e; }
    finally { closeSync(out); closeSync(err); }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  // Only recursively remove the exact test root created by mkdtemp, after git exits.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), workdir = join(root, 'work'); mkdirSync(repo);
  git(repo, ['init']);
  writeFileSync(join(repo, 'hello.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
  const projects = { demo: { repo } }, job = { id: 1, agent: 'claude', project: 'demo', thread_key: 'a@example.com|<root@x>', subject: 'change' };
  return { root, repo, workdir, projects, job };
}

test('worktree identity/reuse, excludes and hook-free commit', (t) => {
  const { root, repo, workdir, projects, job } = setup(t);
  const hookMarker = join(root, 'hook-ran').replaceAll('\\', '/');
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > '${hookMarker}'\n`);
  writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), `#!/bin/sh\necho ran > '${hookMarker}'\n`);
  // post-checkout is also dangerous on worktree creation; test the same override.
  writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > '${hookMarker}'\n`);
  const state = prepareWorktree(workdir, projects, job);
  assert.equal(git(state.path, ['config', '--get', 'core.hooksPath']), 'NUL');
  assert.equal(git(state.path, ['config', '--get', 'core.fsmonitor']), 'false');
  assert.equal(git(state.path, ['config', '--get', 'core.sshCommand']), 'false');
  assert.match(state.branch, /^mailbot\/demo\/claude-[a-f0-9]{12}$/);
  assert.equal(prepareWorktree(workdir, projects, job).path, state.path);
  for (const name of ['inbox/job-1', 'outbox/job-1']) { mkdirSync(join(state.path, name), { recursive: true }); writeFileSync(join(state.path, name, 'secret.txt'), 'private'); }
  writeFileSync(join(state.path, '.codex-last-1.txt'), 'output');
  assert.equal(git(state.path, ['status', '--porcelain']), '');
  writeFileSync(join(state.path, 'hello.txt'), 'updated\n');
  const report = commitWorktree(state, job, 'example.com');
  assert.match(report, /hello.txt/); assert.match(report, /Nhánh:/);
  assert.equal(existsSync(join(root, 'hook-ran')), false);
  assert.equal(git(repo, ['show', 'HEAD:hello.txt']), 'base');
  assert.equal(git(state.path, ['status', '--porcelain']), '');
  assert.equal(git(state.path, ['log', '-1', '--format=%an <%ae>']), 'mailbot <claude@example.com>');
  assert.equal(listWorktrees(workdir).length, 1);
});

test('modified .git is refused before post-CLI git; missing projects fail', (t) => {
  const { workdir, projects, job } = setup(t);
  assert.throws(() => prepareWorktree(workdir, {}, job), /chưa được cấu hình/);
  const state = prepareWorktree(workdir, projects, job), original = readFileSync(join(state.path, '.git'), 'utf8');
  writeFileSync(join(state.path, 'hello.txt'), 'uncommitted');
  let mocked = false;
  try { writeFileSync(join(state.path, '.git'), 'gitdir: C:/wrong\n'); }
  catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    // Windows sandbox protects .git even in TEMP. Simulate its changed contents
    // at the read boundary; the actual commit path and real git remain in use.
    t.diagnostic('Sandbox blocks physical .git mutation; simulating read contents for tamper detection');
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (p, ...args) => String(p) === join(state.path, '.git') ? 'gitdir: C:/wrong\n' : read(p, ...args));
    syncBuiltinESMExports(); mocked = true;
  }
  assert.throws(() => commitWorktree(state, job, 'example.com'), /\.git đã thay đổi/);
  assert.throws(() => prepareWorktree(workdir, projects, job), /\.git đã thay đổi/);
  if (mocked) { fs.readFileSync.mock.restore(); syncBuiltinESMExports(); }
  else writeFileSync(join(state.path, '.git'), original);
  assert.equal(git(state.path, ['rev-parse', 'HEAD']), state.baseSha);
  const unlock = lockWorktree(workdir, job);
  assert.throws(() => lockWorktree(workdir, job), /đang khóa/); unlock();
});

test('prune preserves dirty/unmerged branches and removes only clean merged worktree + branch', (t) => {
  const { repo, workdir, projects, job } = setup(t);
  const state = prepareWorktree(workdir, projects, job);
  writeFileSync(join(state.path, 'hello.txt'), 'changed');
  assert.equal(pruneWorktrees(workdir, projects, 'demo').removed.length, 0);
  commitWorktree(state, job, 'example.com');
  assert.equal(pruneWorktrees(workdir, projects, 'demo').removed.length, 0);
  assert.equal(existsSync(state.path), true);
  git(repo, ['merge', '--ff-only', state.branch]);
  const result = pruneWorktrees(workdir, projects, 'demo');
  assert.deepEqual(result.removed, [state.branch]);
  assert.equal(existsSync(state.path), false);
  assert.equal(git(repo, ['branch', '--list', state.branch]), '');
  assert.equal(listWorktrees(workdir).length, 0);
});

test('job MCP is scoped to Claude/Codex; token absent from CLI env; paths use forward slashes', () => {
  const server = jobMcp({ agent: 'claude', job_token: 'token' }, 'https://example.com', 'C:\\mailbot\\mcp\\job-tools.mjs');
  assert.equal(server.env.MAILBOT_JOB_TOKEN, 'token');
  assert.equal(server.args[0], 'C:/mailbot/mcp/job-tools.mjs');
  assert.equal(jobMcp({ agent: 'agy', job_token: 'token' }, 'x'), null);
  assert.equal(jobMcp({ agent: 'codex' }, 'x'), null);
  assert.deepEqual(cliEnv({ PATH: 'ok', MAILBOT_JOB_TOKEN: 'bad', MAILBOT_TOKEN: 'bad', MAILBOT_ADMIN_TOKEN: 'bad', mailbot_job_token: 'bad' }), { PATH: 'ok' });
  const args = codexMcpArgs(server).join(' ');
  assert.match(args, /mcp_servers.mailbot-job.command=/);
  assert.match(args, /mcp_servers.mailbot-job.env=/);
  assert.equal(JOB_TOOLS.length, 2);
});
