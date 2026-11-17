import { mkdirSync, lstatSync, realpathSync, readdirSync, openSync, fstatSync, readSync, closeSync, rmSync } from "node:fs";
import { join, sep, resolve, extname } from "node:path";

export const MAX_BYTES = 2 * 1024 * 1024;
const mimeTypes = { '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.html': 'text/html', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.zip': 'application/zip', '.svg': 'image/svg+xml' };
const real = (p) => realpathSync.native(p);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (p, dir) => (process.platform === 'win32' ? p.toLowerCase() : p).startsWith(
  (process.platform === 'win32' ? dir.toLowerCase() : dir) + sep);

function directory(p) {
  const st = lstatSync(p);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Outbox phải là thư mục thường");
}

// Ghi nhận cwd thực trước khi CLI chạy. Không đi qua junction/symlink outbox.
export function prepareOutbox(cwd, id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error("job id không hợp lệ");
  const root = real(cwd);
  const parent = join(root, "outbox");
  mkdirSync(parent, { recursive: true });
  directory(parent);
  if (!same(real(parent), parent)) throw new Error("Outbox nằm ngoài cwd");
  const path = join(parent, `job-${id}`);
  mkdirSync(path, { recursive: true });
  directory(path);
  if (!same(real(path), path)) throw new Error("Outbox nằm ngoài cwd");
  return { path, root };
}

// Chỉ đọc cấp 1; kiểm tra trước và sau open để chặn link và thay tệp giữa chừng.
export function readOutbox({ path, root }, { discard = false } = {}) {
  path = resolve(path);
  const attachments = [], notes = [];
  let total = 0, safeCleanup = false;
  try {
    directory(root);
    directory(join(root, 'outbox'));
    if (!same(real(root), root) || !same(real(join(root, 'outbox')), join(root, 'outbox')) ||
      !same(path, join(root, 'outbox', path.split(sep).at(-1))) || !/^job-\d+$/.test(path.split(sep).at(-1))) {
      throw new Error("Đường dẫn outbox đã thay đổi");
    }
    // rmSync trên symlink lá chỉ xóa link; không đi theo link.
    safeCleanup = true;
    directory(path);
    const base = real(path);
    if (!same(base, path)) throw new Error("Outbox đã bị chuyển hướng");
    for (const name of discard ? [] : readdirSync(path).sort()) {
      let fd;
      try {
        const p = join(path, name);
        const st = lstatSync(p);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !inside(real(p), base)) throw new Error("không phải tệp thường độc lập");
        if (attachments.length >= 10 || st.size > MAX_BYTES - total) throw new Error("vượt giới hạn 10 tệp / 2 MB");
        fd = openSync(p, 'r');
        const f = fstatSync(fd);
        if (!f.isFile() || f.nlink !== 1 || f.size > MAX_BYTES - total || f.dev !== st.dev || f.ino !== st.ino || f.size !== st.size ||
          lstatSync(p).isSymbolicLink() || !inside(real(p), base)) throw new Error("tệp đã thay đổi hoặc vượt giới hạn");
        const buf = Buffer.alloc(f.size);
        let bytes = 0;
        while (bytes < buf.length) {
          const n = readSync(fd, buf, bytes, buf.length - bytes, null);
          if (!n) throw new Error("tệp bị cắt khi đọc");
          bytes += n;
        }
        const after = fstatSync(fd);
        if (after.nlink !== 1 || after.size !== f.size || after.mtimeMs !== f.mtimeMs) throw new Error("tệp thay đổi khi đọc");
        attachments.push({ filename: name, mime_type: mimeTypes[extname(name).toLowerCase()] || 'application/octet-stream',
          b64_lines: buf.toString('base64').match(/.{1,76}/g)?.join('\r\n') || '' });
        total += bytes;
      } catch (err) { notes.push(`Bỏ tệp ${name.replace(/[\x00-\x1f\x7f]/g, '')}: ${err.message}`); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  } catch (err) { notes.push(`Không đọc outbox: ${err.message}`); }
  finally {
    if (safeCleanup) {
      try {
        // Kiểm tra lại cha ngay trước recursive remove; không xóa qua cha bị chuyển hướng.
        directory(join(root, 'outbox'));
        if (same(real(join(root, 'outbox')), join(root, 'outbox'))) rmSync(path, { recursive: true, force: true });
      } catch (err) { notes.push(`Không dọn outbox: ${err.message}`); }
    }
  }
  return { attachments, notes };
}
