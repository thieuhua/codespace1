import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, prepareWorktree, commitWorktree, listWorktrees, pruneWorktrees, lockWorktree, lockRepository, verifyWorktree } from '../worktrees.mjs';
import { RUN_TOOLS, runMcp, codexMcpArgs, cliEnv } from '../run-mcp.mjs';

const execFile = childProcess.execFileSync;
const spawnProcess = childProcess.spawn;

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mailbot-wt-test-'));
  const emptyConfig = join(root, 'empty-config'); writeFileSync(emptyConfig, '');
  // The unelevated Windows sandbox rejects Node pipe handles (EPERM), while file
  // descriptors work. Keep real git and its actual argv, only replace stdio here.
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    const outPath = join(root, 'git-stdout'), errPath = join(root, 'git-stderr');
    const out = openSync(outPath, 'w'), err = openSync(errPath, 'w');
    try {
      execFile(cmd, args, { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', out, err] });
      return readFileSync(outPath, 'utf8');
    } catch (e) { e.stderr = readFileSync(errPath, 'utf8'); throw e; }
    finally { closeSync(out); closeSync(err); }
  });
  let serial=0;
  t.mock.method(childProcess, 'execFile', (cmd,args,options,callback) => {
    const name=`git-async-${++serial}`;
    const outPath=join(root,`${name}-stdout`),errPath=join(root,`${name}-stderr`);
    const out=openSync(outPath,'w'),err=openSync(errPath,'w');
    let finished=false;
    const finish=error=>{
      if(finished)return;finished=true;
      closeSync(out);closeSync(err);
      const stdout=readFileSync(outPath,'utf8');
      if(error)error.stderr=readFileSync(errPath,'utf8');
      callback(error,stdout);
    };
    // execFile always opens pipes even with a stdio option. Use real async
    // spawn with file descriptors to accommodate the Windows sandbox.
    try {
      const child=spawnProcess(cmd,args,{...options,env:{...options.env,GIT_CONFIG_GLOBAL:emptyConfig,GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore',out,err]});
      child.on('error',finish);
      child.on('close',code=>finish(code===0?null:Object.assign(new Error(`git exited ${code}`),{code})));
      return child;
    } catch(error) {finish(error);}
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

test('worktree identity/reuse, excludes and hook-free commit', async (t) => {
  const { root, repo, workdir, projects, job } = setup(t);
  const hookMarker = join(root, 'hook-ran').replaceAll('\\', '/');
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > '${hookMarker}'\n`);
  writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), `#!/bin/sh\necho ran > '${hookMarker}'\n`);
  // post-checkout is also dangerous on worktree creation; test the same override.
  writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > '${hookMarker}'\n`);
  const state = await prepareWorktree(workdir, projects, job);
  assert.equal(git(state.path, ['config', '--get', 'core.hooksPath']), 'NUL');
  assert.equal(git(state.path, ['config', '--get', 'core.fsmonitor']), 'false');
  assert.equal(git(state.path, ['config', '--get', 'core.sshCommand']), 'false');
  assert.match(state.branch, /^mailbot\/demo\/claude-[a-f0-9]{12}$/);
  assert.equal((await prepareWorktree(workdir, projects, job)).path, state.path);
  for (const name of ['inbox/run-1', 'outbox/run-1']) { mkdirSync(join(state.path, name), { recursive: true }); writeFileSync(join(state.path, name, 'secret.txt'), 'private'); }
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

test('D task worktree identity is tag+agent+task_id, independent of root/session/run',async t=>{
  const {workdir,projects,job}=setup(t);
  const one=await prepareWorktree(workdir,projects,{...job,task_id:10,root_id:1});
  const two=await prepareWorktree(workdir,projects,{...job,task_id:11,root_id:1});
  assert.notEqual(one.path,two.path);assert.match(one.branch,/claude-task-10$/);
  assert.equal((await prepareWorktree(workdir,projects,{...job,id:99,task_id:10,root_id:1,thread_key:'changed'})).path,one.path);
  assert.ok(listWorktrees(workdir).some(s=>s.task_id===10));
});

test('modified .git is refused before post-CLI git; missing projects fail', async (t) => {
  const { workdir, projects, job } = setup(t);
  await assert.rejects(prepareWorktree(workdir, {}, job), /chưa được cấu hình/);
  const state = await prepareWorktree(workdir, projects, job), original = readFileSync(join(state.path, '.git'), 'utf8');
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
  await assert.rejects(prepareWorktree(workdir, projects, job), /\.git đã thay đổi/);
  if (mocked) { fs.readFileSync.mock.restore(); syncBuiltinESMExports(); }
  else writeFileSync(join(state.path, '.git'), original);
  assert.equal(git(state.path, ['rev-parse', 'HEAD']), state.baseSha);
  const unlock = lockWorktree(workdir, job);
  assert.throws(() => lockWorktree(workdir, job), /đang khóa/); unlock();
});

test('prune preserves dirty/unmerged branches and removes only clean merged worktree + branch', async (t) => {
  const { repo, workdir, projects, job } = setup(t);
  const state = await prepareWorktree(workdir, projects, job);
  writeFileSync(join(state.path, 'hello.txt'), 'changed');
  assert.equal((await pruneWorktrees(workdir, projects, 'demo')).removed.length, 0);
  commitWorktree(state, job, 'example.com');
  assert.equal((await pruneWorktrees(workdir, projects, 'demo')).removed.length, 0);
  assert.equal(existsSync(state.path), true);
  git(repo, ['merge', '--ff-only', state.branch]);
  const result = await pruneWorktrees(workdir, projects, 'demo');
  assert.deepEqual(result.removed, [state.branch]);
  assert.equal(existsSync(state.path), false);
  assert.equal(git(repo, ['branch', '--list', state.branch]), '');
  assert.equal(listWorktrees(workdir).length, 0);
});

test('job MCP is scoped to Claude/Codex; token absent from CLI env; paths use forward slashes', () => {
  const server = runMcp({ agent: 'claude', run_token: 'token' }, 'https://example.com', 'C:\\mailbot\\mcp\\run-tools.mjs');
  assert.equal(server.env.MAILBOT_RUN_TOKEN, 'token');
  assert.equal(server.args[0], 'C:/mailbot/mcp/run-tools.mjs');
  assert.equal(runMcp({ agent: 'agy', run_token: 'token' }, 'x'), null);
  assert.equal(runMcp({ agent: 'codex' }, 'x'), null);
  assert.deepEqual(cliEnv({ PATH: 'ok', MAILBOT_RUN_TOKEN: 'bad', MAILBOT_TOKEN: 'bad', MAILBOT_ADMIN_TOKEN: 'bad', mailbot_run_token: 'bad' }), { PATH: 'ok' });
  const args = codexMcpArgs(server).join(' ');
  assert.match(args, /mcp_servers.mailbot-run.command=/);
  assert.match(args, /mcp_servers.mailbot-run.env=/);
  assert.equal(RUN_TOOLS.length, 5);
});

test('C2 config snapshots and actual toplevel are verified before commit; filter config refused', async (t) => {
  const { workdir, repo, projects, job } = setup(t);
  const state = await prepareWorktree(workdir, projects, job);
  assert.equal(git(state.path, ['config', '--get', 'core.attributesFile']), 'NUL');
  // Simulate untrusted post-CLI writes at the read boundary: Windows protects
  // physical .git files in TEMP too. Assert refusal before *any* Git invocation.
  const read = fs.readFileSync, run = childProcess.execFileSync;
  let tampered = join(state.gitdir, 'config.worktree'), called = false;
  t.mock.method(fs, 'readFileSync', (p, ...args) => String(p) === tampered ? '[core]\n worktree = outside\n fsmonitor = arbitrary-command\n' : read(p, ...args));
  t.mock.method(childProcess, 'execFileSync', (...args) => { called = true; return run(...args); });
  syncBuiltinESMExports();
  assert.throws(() => commitWorktree(state, job, 'x'), /config.worktree đã thay đổi/);
  assert.equal(called, false);
  tampered = state.commonConfigPath;
  assert.throws(() => commitWorktree(state, job, 'x'), /common config đã thay đổi/);
  assert.equal(called, false);
  fs.readFileSync.mock.restore(); childProcess.execFileSync.mock.restore(); syncBuiltinESMExports();
  const exec = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => args.includes('--show-toplevel') ? repo : exec(cmd, args, options));
  syncBuiltinESMExports();
  assert.throws(() => verifyWorktree(state), /toplevel/);
  childProcess.execFileSync.mock.restore(); syncBuiltinESMExports();
  git(repo, ['config', 'filter.test.clean', 'this-must-never-run']);
  // Snapshot trusted common config for this test; filter guard still blocks git add.
  state.commonConfig = readFileSync(state.commonConfigPath, 'utf8');
  assert.throws(() => commitWorktree(state, job, 'x'), /filter\./);
  assert.equal(git(state.path, ['rev-parse', 'HEAD']), state.baseSha);
});

test('C2 tracked .gitattributes modifications/deletion refused before add; old state needs owner review', async (t) => {
  const { repo, workdir, projects, job } = setup(t);
  writeFileSync(join(repo, '.gitattributes'), '*.txt text\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'attributes']);
  const state = await prepareWorktree(workdir, projects, job);
  writeFileSync(join(state.path, '.gitattributes'), '*.txt filter=evil\n');
  assert.throws(() => commitWorktree(state, job, 'x'), /\.gitattributes/);
  rmSync(join(state.path, '.gitattributes'));
  assert.throws(() => commitWorktree(state, job, 'x'), /\.gitattributes/);
  assert.equal(git(state.path, ['diff', '--cached', '--name-only']), '');
  const legacy = JSON.parse(readFileSync(state.stateFile, 'utf8')); delete legacy.worktreeConfig;
  writeFileSync(state.stateFile, JSON.stringify(legacy));
  await assert.rejects(prepareWorktree(workdir, projects, job), /thiếu snapshot/);
});

test('C2 ignored untracked nested .gitattributes refused before staging', async (t) => {
  const { workdir, projects, job } = setup(t);
  const state = await prepareWorktree(workdir, projects, job);
  mkdirSync(join(state.path, 'nested'));
  writeFileSync(join(state.path, '.gitignore'), 'nested/\n');
  writeFileSync(join(state.path, 'nested', '.gitattributes'), '* filter=evil');
  assert.throws(() => commitWorktree(state, job, 'x'), /\.gitattributes/);
  assert.equal(git(state.path, ['diff', '--cached', '--name-only']), '');
});

test('C4 case-insensitive pathspec excludes negated ignores before object creation; dirty reserved index is reset', async (t) => {
  const { workdir, projects, job } = setup(t);
  const state = await prepareWorktree(workdir, projects, job);
  writeFileSync(join(state.path, '.gitignore'), '!/inbox/\n!/inbox/**\n!/outbox/\n!/outbox/**\n');
  for (const dir of ['Inbox', 'Outbox']) {
    mkdirSync(join(state.path, dir));
    writeFileSync(join(state.path, dir, 'private.txt'), `unique-${dir}-payload`);
  }
  writeFileSync(join(state.path, '.CODEX-LAST-1.txt'), 'unique-codex-payload');
  writeFileSync(join(state.path, 'hello.txt'), 'safe edit');
  commitWorktree(state, job, 'x');
  const files = git(state.path, ['ls-tree', '-r', '--name-only', 'HEAD']);
  assert.ok(!/inbox|outbox|codex-last/i.test(files));
  for (const file of ['Inbox/private.txt', 'Outbox/private.txt', '.CODEX-LAST-1.txt']) {
    const hash = git(state.path, ['hash-object', '--no-filters', file]);
    assert.throws(() => git(state.path, ['cat-file', '-e', hash]));
  }
  git(state.path, ['add', '-f', 'Inbox/private.txt']);
  assert.throws(() => commitWorktree(state, job, 'x'), /đã bỏ stage/);
  assert.equal(git(state.path, ['diff', '--cached', '--name-only']), '');
});

test('C9 repo lock shares identity across tags, retries briefly and guards prepare/prune', async (t) => {
  const { repo, workdir, projects, job } = setup(t);
  const release = await lockRepository(workdir, repo);
  await assert.rejects(prepareWorktree(workdir, projects, job), /Repo đang khóa/);
  let waits = 0;
  const unlock = await lockRepository(workdir, repo, { attempts: 2, wait: () => { waits++; release(); } });
  assert.equal(waits, 1);
  await assert.rejects(lockRepository(workdir, repo, { attempts: 1 }), /Repo đang khóa/);
  unlock();
  const state = await prepareWorktree(workdir, projects, job);
  const again = await lockRepository(workdir, repo);
  assert.equal((await pruneWorktrees(workdir, projects, 'demo')).removed.length, 0);
  assert.equal(existsSync(state.path), true);
  again();
  assert.equal((await pruneWorktrees(workdir, projects, 'demo')).removed.length, 1);
});

test('P3.5 parallel preparation across tags/agents sharing a repo completes without blocking event loop', async t => {
  const {repo,workdir,projects,job}=setup(t);
  const alias=process.platform==='win32'?repo.toUpperCase():join(repo,'.');
  projects.other={repo:alias};
  let turns=0,active=true;
  const tick=()=>{if(active){turns++;setImmediate(tick);}};
  setImmediate(tick);
  let states;
  try {
    const results=await Promise.allSettled([
      prepareWorktree(workdir,projects,{...job,task_id:1}),
      prepareWorktree(workdir,projects,{...job,project:'other',agent:'codex',task_id:2}),
      prepareWorktree(workdir,projects,{...job,task_id:3}),
    ]);
    for(const result of results)assert.equal(result.status,'fulfilled',result.reason?.stack);
    states=results.map(result=>result.value);
  } finally {active=false;}
  assert.equal(new Set(states.map(s=>s.path)).size,3);assert.ok(turns>0);
  for(const state of states)verifyWorktree(state);
});
