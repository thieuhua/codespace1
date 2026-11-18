import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, lstatSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const TAG = /^[a-z0-9-]{1,32}$/;
const real = (p) => realpathSync.native(p);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const repoKey = repo => process.platform === 'win32' ? real(repo).toLowerCase() : real(repo);
const repoQueues = new Map();

// All agent-owned git commands, including init/admin/test calls, use these overrides.
function gitInvocation(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  return { args: ['-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=false',
    '-c', 'core.attributesFile=NUL', '-c', 'commit.gpgSign=false', '-C', cwd, ...args], options: {
    encoding: 'utf8', windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  } };
}

export function git(cwd, args) {
  const call = gitInvocation(cwd, args);
  return execFileSync('git', call.args, call.options).trim();
}

// Preparation/pruning can involve a large checkout: do not block cancel/wake.
function gitAsync(cwd, args) {
  const call = gitInvocation(cwd, args);
  return new Promise((resolve, reject) => execFile('git', call.args, call.options, (error, stdout) => {
    if (error) { error.status = error.code; reject(error); }
    else resolve(stdout.trim());
  }));
}

function identity(workdir, job) {
  if (!TAG.test(job.project || '') || !['claude', 'codex', 'agy'].includes(job.agent)) throw new Error('Project/agent không hợp lệ');
  if (job.task_id !== undefined && (!Number.isSafeInteger(job.task_id) || job.task_id < 1)) throw new Error('Task ID không hợp lệ');
  const name = job.task_id ? `${job.agent}-task-${job.task_id}` : `${job.agent}-${createHash('sha256').update(job.thread_key).digest('hex').slice(0, 12)}`;
  return { path: resolve(workdir, 'worktrees', job.project, name), branch: `mailbot/${job.project}/${name}`,
    stateFile: resolve(workdir, 'worktree-state', job.project, `${name}.json`) };
}

export function lockWorktree(workdir, job) {
  const { stateFile } = identity(workdir, job);
  mkdirSync(dirname(stateFile), { recursive: true });
  const path = `${stateFile}.lock`;
  try { mkdirSync(path); } catch (e) { throw new Error(`Worktree đang khóa: ${path} (${e.code})`); }
  return () => rmdirSync(path);
}

// Canonical repo identity, shared across tags/agents and the admin process.
export async function lockRepository(workdir, repo, { attempts = 80, wait = () => delay(25) } = {}) {
  const root = resolve(workdir, 'worktree-state', 'repo-locks');
  mkdirSync(root, { recursive: true });
  const canonical = real(repo), key = repoKey(repo);
  const path = join(root, createHash('sha256').update(key).digest('hex') + '.lock');
  for (let n = 0; n < attempts; n++) {
    try { mkdirSync(path); return () => rmdirSync(path); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (n + 1 < attempts) await wait();
  }
  throw new Error(`Repo đang khóa: ${canonical}`);
}

// Queue before touching the file lock. Failures release the queue too; unrelated
// canonical repositories proceed independently. The file lock protects admin/
// other processes, while this queue has no timeout for preceding local work.
export async function withRepositoryLock(workdir, repo, operation, lockOptions) {
  const key = repoKey(repo), previous = repoQueues.get(key);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  repoQueues.set(key, gate);
  try {
    await previous;
    const unlock = await lockRepository(workdir, repo, lockOptions);
    try { return await operation(); }
    finally { unlock(); }
  } finally {
    release();
    if (repoQueues.get(key) === gate) repoQueues.delete(key);
  }
}

function configText(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('Git config không phải tệp thường độc lập');
  return readFileSync(path, 'utf8');
}

function verifyWorktreeFiles(state) {
  const st = lstatSync(state.path), dot = join(state.path, '.git');
  const f = lstatSync(dot);
  if (!st.isDirectory() || st.isSymbolicLink() || !same(real(state.path), state.path) ||
      !f.isFile() || f.isSymbolicLink() || f.nlink !== 1 || readFileSync(dot, 'utf8') !== state.gitFile) {
    throw new Error('Worktree/.git đã thay đổi; không chạy git hoặc commit');
  }
  if (state.worktreeConfig !== undefined && configText(join(state.gitdir, 'config.worktree')) !== state.worktreeConfig)
    throw new Error('config.worktree đã thay đổi; không commit');
  if (state.commonConfig !== undefined && configText(state.commonConfigPath) !== state.commonConfig)
    throw new Error('Git common config đã thay đổi; không commit');
}

export function verifyWorktree(state) {
  verifyWorktreeFiles(state);
  if (!same(resolve(git(state.path, ['rev-parse', '--show-toplevel'])), state.path))
    throw new Error('Git toplevel không khớp worktree; không commit');
}

async function verifyWorktreeAsync(state) {
  verifyWorktreeFiles(state);
  if (!same(resolve(await gitAsync(state.path, ['rev-parse', '--show-toplevel'])), state.path))
    throw new Error('Git toplevel không khớp worktree; không commit');
}

export async function prepareWorktree(workdir, projects, job) {
  if (job.task_id) job = { ...job, thread_key: `task:${job.task_id}` };
  const project = projects?.[job.project];
  if (!project?.repo) throw new Error(`Project chưa được cấu hình: ${job.project}`);
  const info = identity(workdir, job), repo = real(resolve(project.repo));
  return withRepositoryLock(workdir, repo, () => prepareLocked(info, repo, job));
}

async function prepareLocked(info, repo, job) {
  if (await gitAsync(repo, ['rev-parse', '--is-bare-repository']) !== 'false') throw new Error('Cần repo non-bare');
  // Enabling worktreeConfig with core.worktree in common config would redirect
  // other worktrees. Refuse that unusual layout instead of migrating it silently.
  let customWorktree;
  try { customWorktree = await gitAsync(repo, ['config', '--local', '--get', 'core.worktree']); }
  catch (e) { if (e.status !== 1) throw e; }
  if (customWorktree) throw new Error('Repo có core.worktree riêng; cần chủ máy cấu hình worktreeConfig trước');
  let state;
  if (existsSync(info.stateFile)) {
    state = JSON.parse(readFileSync(info.stateFile, 'utf8'));
    if (!same(state.path, info.path) || !same(state.repo, repo) || state.branch !== info.branch ||
        state.thread_key !== job.thread_key || state.agent !== job.agent || state.project !== job.project) throw new Error('Worktree state không khớp cấu hình');
    if (typeof state.worktreeConfig !== 'string') throw new Error('Worktree state cũ thiếu snapshot config.worktree; cần chủ máy kiểm tra/prune trước khi dùng lại');
    await verifyWorktreeAsync(state);
  } else {
    if (existsSync(info.path)) throw new Error('Worktree đã tồn tại nhưng thiếu state; cần chủ máy kiểm tra');
    mkdirSync(dirname(info.path), { recursive: true });
    await gitAsync(repo, ['worktree', 'add', '-b', info.branch, info.path, 'HEAD']);
    const path = real(info.path);
    const gitdir = resolve(path, await gitAsync(path, ['rev-parse', '--git-dir']));
    const gitFile = readFileSync(join(path, '.git'), 'utf8');
    if (!same(resolve(path, gitFile.trim().replace(/^gitdir: /, '')), gitdir)) throw new Error('gitdir không khớp');
    state = { ...info, path, repo, gitdir, gitFile, project: job.project, agent: job.agent, thread_key: job.thread_key, task_id: job.task_id };
    mkdirSync(dirname(info.stateFile), { recursive: true });
    writeFileSync(info.stateFile, JSON.stringify(state, null, 2), { flag: 'wx' });
  }
  await verifyWorktreeAsync(state);
  // Keep exclusions private to this worktree; never edit the source repo's excludes.
  const excludes = join(state.gitdir, 'info', 'exclude');
  mkdirSync(dirname(excludes), { recursive: true });
  const old = existsSync(excludes) ? readFileSync(excludes, 'utf8') : '';
  const missing = ['/inbox/', '/outbox/', '/.codex-last-*'].filter((s) => !old.split(/\r?\n/).includes(s));
  if (missing.length) appendFileSync(excludes, '\n' + missing.join('\n') + '\n');
  // Git normally reads common/info/exclude, ignoring worktrees/<id>/info/exclude.
  // Point worktree-local core.excludesFile at our private file so the exclusions
  // also apply to git invoked by a CLI, without changing the source .gitignore.
  if (await gitAsync(repo, ['config', '--bool', '--default', 'false', '--get', 'extensions.worktreeConfig']) !== 'true')
    await gitAsync(repo, ['config', 'extensions.worktreeConfig', 'true']);
  await gitAsync(state.path, ['config', '--worktree', 'core.excludesFile', excludes.replaceAll('\\', '/')]);
  const branch = await gitAsync(state.path, ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== state.branch) throw new Error('Nhánh worktree đã thay đổi');
  state.worktreeConfig = configText(join(state.gitdir, 'config.worktree'));
  writeFileSync(info.stateFile, JSON.stringify(state, null, 2));
  const commonConfigPath = resolve(state.path, await gitAsync(state.path, ['rev-parse', '--git-common-dir']), 'config');
  return { ...state, commonConfigPath, commonConfig: configText(commonConfigPath), baseSha: await gitAsync(state.path, ['rev-parse', 'HEAD']) };
}

const reserved = (p) => /^(inbox(?:\/|$)|outbox(?:\/|$)|\.codex-last-)/i.test(p);
function rejectReservedIndex(state) {
  const staged = git(state.path, ['diff', '--cached', '--name-only', '-z']);
  if (staged.split('\0').some(reserved)) {
    git(state.path, ['reset', '--mixed', 'HEAD']);
    throw new Error('Không commit inbox/outbox hoặc output Codex đã tracked/staged; đã bỏ stage');
  }
}

function verifyNoFilters(state) {
  let filters = '';
  try { filters = git(state.path, ['config', '--get-regexp', '^filter[.]']); }
  catch (e) { if (e.status !== 1) throw e; }
  if (filters) throw new Error('Git config có filter.; không commit');
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', state.baseSha];
  // Ignored .gitattributes still affect git add, so include ignored files too.
  const changed = git(state.path, args) + '\0' + git(state.path, ['ls-files', '--others', '-z']);
  if (changed.split('\0').some((p) => /(^|\/)\.gitattributes$/i.test(p)))
    throw new Error('.gitattributes thay đổi so với baseSha; không commit');
}

export function commitWorktree(state, job, domain) {
  verifyWorktree(state); // Must precede every git call after untrusted CLI execution.
  if (git(state.path, ['symbolic-ref', '--short', 'HEAD']) !== state.branch) throw new Error('Nhánh worktree đã thay đổi; không commit');
  verifyNoFilters(state);
  rejectReservedIndex(state);
  if (git(state.path, ['status', '--porcelain'])) {
    // Wildcard the first character too: Git otherwise treats a literal ignored
    // directory prefix in an exclude pathspec as an explicitly requested path.
    git(state.path, ['add', '-A', '--', '.', ...['[i]nbox', '[i]nbox/**', '[o]utbox', '[o]utbox/**', '.codex-last-*']
      .map((p) => `:(top,exclude,icase,glob)${p}`)]);
    // Inbox/outbox paths are excluded for untracked data; also reject tracked copies.
    const staged = git(state.path, ['diff', '--cached', '--name-only', '-z']);
    rejectReservedIndex(state);
    if (staged) git(state.path, ['-c', 'user.name=mailbot', '-c', `user.email=${job.agent}@${domain}`,
      'commit', '--no-verify', '-m', `mailbot job ${job.id}: ${String(job.subject || '').replace(/[\r\n\x00]/g, ' ').slice(0, 300)}`]);
  }
  const stat = git(state.path, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${state.baseSha}..HEAD`]);
  return `\n\n[Git]\nNhánh: ${state.branch}\nWorktree: ${state.path}\n${stat || '(không có thay đổi)'}`;
}

export function listWorktrees(workdir) {
  const root = resolve(workdir, 'worktree-state');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && TAG.test(d.name)).flatMap((d) =>
    readdirSync(join(root, d.name)).filter((n) => /^(claude|codex|agy)-(?:[a-f0-9]{12}|task-[1-9]\d*)\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(join(root, d.name, n), 'utf8'))));
}

export async function pruneWorktrees(workdir, projects, tag) {
  if (!TAG.test(tag) || !projects?.[tag]?.repo) throw new Error('Project chưa được cấu hình');
  const removed = [], skipped = [];
  for (const state of listWorktrees(workdir).filter((s) => s.project === tag)) {
    let unlock;
    try {
      const info = identity(workdir, state);
      if (!same(info.path, state.path) || !same(info.stateFile, state.stateFile) ||
          !same(real(projects[tag].repo), state.repo) || state.branch !== info.branch) throw new Error('State không khớp');
      unlock = lockWorktree(workdir, state);
      await withRepositoryLock(workdir, state.repo, async () => {
        await verifyWorktreeAsync(state);
        if (await gitAsync(state.path, ['symbolic-ref', '--short', 'HEAD']) !== state.branch || await gitAsync(state.path, ['status', '--porcelain'])) throw new Error('Worktree bẩn hoặc khác nhánh');
        await gitAsync(state.repo, ['merge-base', '--is-ancestor', state.branch, 'HEAD']);
        await gitAsync(state.repo, ['worktree', 'remove', state.path]);
        await gitAsync(state.repo, ['branch', '-d', state.branch]);
        unlinkSync(state.stateFile);
        removed.push(state.branch);
      });
    } catch (e) { skipped.push({ branch: state.branch, reason: e.message }); }
    finally { unlock?.(); }
  }
  return { removed, skipped };
}
