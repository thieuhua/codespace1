import { lstatSync, realpathSync, openSync, fstatSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function readLastOutput(path, cwd) {
  path = resolve(path); cwd = resolve(cwd);
  const parent = lstatSync(cwd);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !same(realpathSync.native(cwd), cwd) || !same(dirname(path), cwd))
    throw new Error('Codex output nằm ngoài cwd');
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !same(realpathSync.native(path), path))
    throw new Error('Codex output không phải tệp thường độc lập');
  const fd = openSync(path, 'r');
  try {
    const f = fstatSync(fd);
    if (!f.isFile() || f.nlink !== 1 || f.dev !== st.dev || f.ino !== st.ino || f.size !== st.size || f.size > 4 * 1024 * 1024)
      throw new Error('Codex output đã thay đổi hoặc quá lớn');
    const text = readFileSync(fd, 'utf8'), after = fstatSync(fd), leaf = lstatSync(path);
    if (after.nlink !== 1 || after.size !== f.size || after.mtimeMs !== f.mtimeMs || leaf.isSymbolicLink() ||
      leaf.nlink !== 1 || leaf.dev !== f.dev || leaf.ino !== f.ino || !same(realpathSync.native(path), path))
      throw new Error('Codex output đã thay đổi khi đọc');
    unlinkSync(path);
    return text;
  } finally { closeSync(fd); }
}
