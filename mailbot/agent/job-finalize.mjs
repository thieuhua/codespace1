import { readOutbox } from './outbox.mjs';
import { cleanupInbox } from './inbox.mjs';
import { commitWorktree, verifyWorktree } from './worktrees.mjs';

export function finalizeFiles({ result, outbox, worktree, dir, job, domain, unlock, executed = true },
  { read = readOutbox, cleanup = cleanupInbox, commit = commitWorktree } = {}) {
  let files = { attachments: [], notes: [] }, gitReport = '';
  const stopped = result.cancelled || result.timedOut || !executed || !result.ok;
  try {
    if (!stopped && worktree) verifyWorktree(worktree);
    if (outbox) files = read(outbox, { discard: !!stopped });
    if (job.deliver === 'parent' && files.attachments.length) files.notes.push('Task con: outbox không gửi email; chỉ chuyển metadata tệp cho cha. Đưa nội dung cần thiết vào kết quả văn bản.');
    if (stopped) { result.ok = false; result.session_id = null; }
    else if (worktree) gitReport = commit(worktree, job, domain);
  } catch (e) {
    result.ok = false; result.session_id = null;
    files.attachments = [];
    if (outbox) read(outbox, { discard: true });
    gitReport = `\n\n[Git lỗi] ${e.message}\nNhánh: ${worktree?.branch || ''}\nWorktree: ${worktree?.path || dir}`;
  } finally {
    try { cleanup(dir, job.id); } catch (e) { files.notes.push(`Không dọn inbox: ${e.message}`); }
    unlock?.();
  }
  return { ...files, gitReport };
}
