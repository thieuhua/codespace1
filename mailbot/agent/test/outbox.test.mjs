import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, linkSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareOutbox, readOutbox, MAX_BYTES } from '../outbox.mjs';

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'mailbot-test-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { temp, outbox: prepareOutbox(temp, 1) };
}
test('reads regular files only at level one, detects MIME and cleans outbox', (t) => {
  const { outbox } = fixture(t);
  writeFileSync(join(outbox.path, 'a.txt'), 'Xin chào');
  writeFileSync(join(outbox.path, 'b.unknown'), Buffer.from([0, 255, 1]));
  mkdirSync(join(outbox.path, 'nested'));
  writeFileSync(join(outbox.path, 'nested', 'hidden.txt'), 'hidden');
  const { attachments, notes } = readOutbox(outbox);
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].mime_type, 'text/plain');
  assert.equal(Buffer.from(attachments[0].b64_lines, 'base64').toString(), 'Xin chào');
  assert.equal(attachments[1].mime_type, 'application/octet-stream');
  assert.ok(attachments.every((a) => a.b64_lines.split('\r\n').every((line) => line.length <= 76)));
  assert.equal(notes.length, 1);
  assert.equal(existsSync(outbox.path), false);
});
test('hardlinks are rejected and cleanup preserves the other link', (t) => {
  const { temp, outbox } = fixture(t);
  const original = join(temp, 'original.txt');
  writeFileSync(original, 'private');
  linkSync(original, join(outbox.path, 'hardlink.txt'));
  const r = readOutbox(outbox);
  assert.equal(r.attachments.length, 0);
  assert.equal(r.notes.length, 1);
  assert.equal(readFileSync(original, 'utf8'), 'private');
});
test('symlinks are rejected without reading or deleting target', (t) => {
  const { temp, outbox } = fixture(t);
  const original = join(temp, 'original.txt');
  writeFileSync(original, 'private');
  try { symlinkSync(original, join(outbox.path, 'link.txt')); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip(`symlink không đủ quyền: ${e.code}`); throw e; }
  const r = readOutbox(outbox);
  assert.equal(r.attachments.length, 0);
  assert.equal(r.notes.length, 1);
  assert.equal(readFileSync(original, 'utf8'), 'private');
});
test('oversize file skipped; exact total budget accepted and later excess noted', (t) => {
  const { outbox } = fixture(t);
  writeFileSync(join(outbox.path, 'a-too-big.bin'), Buffer.alloc(MAX_BYTES + 1));
  writeFileSync(join(outbox.path, 'b-full.bin'), Buffer.alloc(MAX_BYTES, 1));
  writeFileSync(join(outbox.path, 'c-extra.txt'), 'x');
  const r = readOutbox(outbox);
  assert.deepEqual(r.attachments.map((a) => a.filename), ['b-full.bin']);
  assert.equal(Buffer.from(r.attachments[0].b64_lines, 'base64').length, MAX_BYTES);
  assert.equal(r.notes.length, 2);
  assert.equal(existsSync(outbox.path), false);
});
test('ten file limit, with discarded files in notes', (t) => {
  const { outbox } = fixture(t);
  for (let i = 0; i < 12; i++) writeFileSync(join(outbox.path, `${i}.txt`), 'x');
  const r = readOutbox(outbox);
  assert.equal(r.attachments.length, 10);
  assert.equal(r.notes.length, 2);
});
test('replaced outbox directory is not traversed; junction target survives cleanup', (t) => {
  const { temp, outbox } = fixture(t);
  const target = join(temp, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'private.txt'), 'private');
  rmSync(outbox.path, { recursive: true });
  try { symlinkSync(target, outbox.path, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip(`symlink không đủ quyền: ${e.code}`); throw e; }
  assert.equal(readOutbox(outbox).attachments.length, 0);
  assert.equal(readFileSync(join(target, 'private.txt'), 'utf8'), 'private');
});
test('replaced outbox parent cannot redirect reads or recursive cleanup', (t) => {
  const { temp, outbox } = fixture(t);
  const parent = join(temp, 'outbox');
  const target = join(temp, 'target');
  mkdirSync(join(target, 'job-1'), { recursive: true });
  writeFileSync(join(target, 'job-1', 'private.txt'), 'private');
  renameSync(parent, join(temp, 'old-outbox'));
  try { symlinkSync(target, parent, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip(`symlink không đủ quyền: ${e.code}`); throw e; }
  assert.equal(readOutbox(outbox).attachments.length, 0);
  assert.equal(readFileSync(join(target, 'job-1', 'private.txt'), 'utf8'), 'private');
  assert.throws(() => prepareOutbox(temp, 2));
});
