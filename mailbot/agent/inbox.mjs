import { mkdirSync, lstatSync, realpathSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export function saveInboxAttachment(cwd, jobId, attachmentId, attachment) {
  if (![jobId, attachmentId].every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) throw new Error('ID tệp không hợp lệ');
  const root = realpathSync.native(cwd);
  let sub = root;
  for (const part of ['inbox', `job-${jobId}`]) {
    sub = join(sub, part); mkdirSync(sub, { recursive: true });
    const st = lstatSync(sub), real = realpathSync.native(sub);
    if (!st.isDirectory() || st.isSymbolicLink() || real.toLowerCase() !== sub.toLowerCase()) throw new Error('Inbox bị chuyển hướng');
  }
  let safe = basename(attachment.filename || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = `_${safe}`;
  const path = join(sub, `${attachmentId}-${safe || 'file'}`);
  // Retry may reuse the job directory; unlink only a verified ordinary leaf.
  if (existsSync(path)) {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('Tệp inbox không an toàn');
    unlinkSync(path);
  }
  writeFileSync(path, Buffer.from(attachment.content_b64, 'base64'), { flag: 'wx' });
  return path;
}
