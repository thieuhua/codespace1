import { mkdirSync, lstatSync, realpathSync, existsSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

export function cleanupInbox(cwd, jobId) {
  if (!Number.isSafeInteger(Number(jobId)) || Number(jobId) < 1) throw new Error('ID job không hợp lệ');
  let path = resolve(cwd);
  for (const part of ['', 'inbox', `run-${jobId}`]) {
    path = join(path, part);
    if (!existsSync(path)) return;
    const st = lstatSync(path), real = realpathSync.native(path);
    const same = process.platform === 'win32' ? real.toLowerCase() === path.toLowerCase() : real === path;
    if (!st.isDirectory() || st.isSymbolicLink() || !same) throw new Error('Không dọn inbox bị chuyển hướng');
  }
  rmSync(path, { recursive: true, force: true });
}

export function saveInboxAttachment(cwd, jobId, attachmentId, attachment, messageId = null) {
  if (![jobId, attachmentId].every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) throw new Error('ID tệp không hợp lệ');
  const root = realpathSync.native(cwd);
  let sub = root;
  for (const part of ['inbox', `run-${jobId}`]) {
    sub = join(sub, part); mkdirSync(sub, { recursive: true });
    const st = lstatSync(sub), real = realpathSync.native(sub);
    if (!st.isDirectory() || st.isSymbolicLink() || real.toLowerCase() !== sub.toLowerCase()) throw new Error('Inbox bị chuyển hướng');
  }
  let safe = basename(attachment.filename || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = `_${safe}`;
  const path = join(sub, `${messageId === null ? "" : `${Number(messageId)}-`}${attachmentId}-${safe || 'file'}`);
  // Retry may reuse the job directory; unlink only a verified ordinary leaf.
  if (existsSync(path)) {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('Tệp inbox không an toàn');
    unlinkSync(path);
  }
  writeFileSync(path, Buffer.from(attachment.content_b64, 'base64'), { flag: 'wx' });
  return path;
}
