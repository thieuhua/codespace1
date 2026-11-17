import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, lstatSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const TAG = /^[a-z0-9-]{1,32}$/;
const real = (p) => realpathSync.native(p);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

// All agent-owned git commands, including init/admin/test calls, use these overrides.
export function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=false',
    '-c', 'commit.gpgSign=false', '-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function identity(workdir, job) {
  if (!TAG.test(job.project || '') || !['claude', 'codex', 'agy'].includes(job.agent)) throw new Error('Project/agent không hợp lệ');
  const name = `${job.agent}-${createHash('sha256').update(job.thread_key).digest('hex').slice(0, 12)}`;
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

export function verifyWorktree(state) {
  const st = lstatSync(state.path), dot = join(state.path, '.git');
  const f = lstatSync(dot);
  if (!st.isDirectory() || st.isSymbolicLink() || !same(real(state.path), state.path) ||
      !f.isFile() || f.isSymbolicLink() || f.nlink !== 1 || readFileSync(dot, 'utf8') !== state.gitFile) {
    throw new Error('Worktree/.git đã thay đổi; không chạy git hoặc commit');
  }
}

export function prepareWorktree(workdir, projects, job) {
  const project = projects?.[job.project];
  if (!project?.repo) throw new Error(`Project chưa được cấu hình: ${job.project}`);
  const info = identity(workdir, job), repo = real(resolve(project.repo));
  if (git(repo, ['rev-parse', '--is-bare-repository']) !== 'false') throw new Error('Cần repo non-bare');
  // Enabling worktreeConfig with core.worktree in common config would redirect
  // other worktrees. Refuse that unusual layout instead of migrating it silently.
  let customWorktree;
  try { customWorktree = git(repo, ['config', '--local', '--get', 'core.worktree']); }
  catch (e) { if (e.status !== 1) throw e; }
  if (customWorktree) throw new Error('Repo có core.worktree riêng; cần chủ máy cấu hình worktreeConfig trước');
  let state;
  if (existsSync(info.stateFile)) {
    state = JSON.parse(readFileSync(info.stateFile, 'utf8'));
    if (!same(state.path, info.path) || !same(state.repo, repo) || state.branch !== info.branch ||
        state.thread_key !== job.thread_key || state.agent !== job.agent || state.project !== job.project) throw new Error('Worktree state không khớp cấu hình');
    verifyWorktree(state);
  } else {
    if (existsSync(info.path)) throw new Error('Worktree đã tồn tại nhưng thiếu state; cần chủ máy kiểm tra');
    mkdirSync(dirname(info.path), { recursive: true });
    git(repo, ['worktree', 'add', '-b', info.branch, info.path, 'HEAD']);
    const path = real(info.path);
    const gitdir = resolve(path, git(path, ['rev-parse', '--git-dir']));
    const gitFile = readFileSync(join(path, '.git'), 'utf8');
    if (!same(resolve(path, gitFile.trim().replace(/^gitdir: /, '')), gitdir)) throw new Error('gitdir không khớp');
    state = { ...info, path, repo, gitdir, gitFile, project: job.project, agent: job.agent, thread_key: job.thread_key };
    mkdirSync(dirname(info.stateFile), { recursive: true });
    writeFileSync(info.stateFile, JSON.stringify(state, null, 2), { flag: 'wx' });
  }
  verifyWorktree(state);
  // Keep exclusions private to this worktree; never edit the source repo's excludes.
  const excludes = join(state.gitdir, 'info', 'exclude');
  mkdirSync(dirname(excludes), { recursive: true });
  const old = existsSync(excludes) ? readFileSync(excludes, 'utf8') : '';
  const missing = ['/inbox/', '/outbox/', '/.codex-last-*'].filter((s) => !old.split(/\r?\n/).includes(s));
  if (missing.length) appendFileSync(excludes, '\n' + missing.join('\n') + '\n');
  // Git normally reads common/info/exclude, ignoring worktrees/<id>/info/exclude.
  // Point worktree-local core.excludesFile at our private file so the exclusions
  // also apply to git invoked by a CLI, without changing the source .gitignore.
  if (git(repo, ['config', '--bool', '--default', 'false', '--get', 'extensions.worktreeConfig']) !== 'true')
    git(repo, ['config', 'extensions.worktreeConfig', 'true']);
  git(state.path, ['config', '--worktree', 'core.excludesFile', excludes.replaceAll('\\', '/')]);
  const branch = git(state.path, ['symbolic-ref', '--short', 'HEAD']);
  if (branch !== state.branch) throw new Error('Nhánh worktree đã thay đổi');
  return { ...state, baseSha: git(state.path, ['rev-parse', 'HEAD']) };
}

export function commitWorktree(state, job, domain) {
  verifyWorktree(state); // Must precede every git call after untrusted CLI execution.
  if (git(state.path, ['symbolic-ref', '--short', 'HEAD']) !== state.branch) throw new Error('Nhánh worktree đã thay đổi; không commit');
  if (git(state.path, ['status', '--porcelain'])) {
    git(state.path, ['add', '-A']);
    // Inbox/outbox paths are excluded for untracked data; also reject tracked copies.
    const staged = git(state.path, ['diff', '--cached', '--name-only', '-z']);
    if (staged.split('\0').some((p) => /^(inbox\/|outbox\/|\.codex-last-)/.test(p))) throw new Error('Không commit inbox/outbox hoặc output Codex đã tracked');
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
    readdirSync(join(root, d.name)).filter((n) => /^(claude|codex|agy)-[a-f0-9]{12}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(join(root, d.name, n), 'utf8'))));
}

export function pruneWorktrees(workdir, projects, tag) {
  if (!TAG.test(tag) || !projects?.[tag]?.repo) throw new Error('Project chưa được cấu hình');
  const removed = [], skipped = [];
  for (const state of listWorktrees(workdir).filter((s) => s.project === tag)) {
    let unlock;
    try {
      const info = identity(workdir, state);
      if (!same(info.path, state.path) || !same(info.stateFile, state.stateFile) ||
          !same(real(projects[tag].repo), state.repo) || state.branch !== info.branch) throw new Error('State không khớp');
      unlock = lockWorktree(workdir, state);
      verifyWorktree(state);
      if (git(state.path, ['symbolic-ref', '--short', 'HEAD']) !== state.branch || git(state.path, ['status', '--porcelain'])) throw new Error('Worktree bẩn hoặc khác nhánh');
      git(state.repo, ['merge-base', '--is-ancestor', state.branch, 'HEAD']);
      git(state.repo, ['worktree', 'remove', state.path]);
      git(state.repo, ['branch', '-d', state.branch]);
      unlinkSync(state.stateFile);
      removed.push(state.branch);
    } catch (e) { skipped.push({ branch: state.branch, reason: e.message }); }
    finally { unlock?.(); }
  }
  return { removed, skipped };
}
