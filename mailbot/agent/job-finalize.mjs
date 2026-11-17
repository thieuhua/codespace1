import { readOutbox } from './outbox.mjs';
import { cleanupInbox } from './inbox.mjs';
import { commitWorktree } from './worktrees.mjs';

export function finalizeFiles({ result, outbox, worktree, dir, job, domain, unlock, executed = true },
  { read = readOutbox, cleanup = cleanupInbox, commit = commitWorktree } = {}) {
  let files = { attachments: [], notes: [] }, gitReport = '';
  const stopped = result.cancelled || result.timedOut || !executed;
  try {
    if (outbox) files = read(outbox, { discard: !!stopped });
    try { cleanup(dir, job.id); } catch (e) { files.notes.push(`Không dọn inbox: ${e.message}`); }
    if (stopped) { result.ok = false; result.session_id = null; }
    else if (worktree) gitReport = commit(worktree, job, domain);
  } catch (e) {
    result.ok = false; result.session_id = null;
    gitReport = `\n\n[Git lỗi] ${e.message}\nNhánh: ${worktree?.branch || ''}\nWorktree: ${worktree?.path || dir}`;
  } finally { unlock?.(); }
  return { ...files, gitReport };
}
