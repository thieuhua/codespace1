import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveInboxAttachment } from '../inbox.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'mailbot-inbox-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('inbox saves sanitized name and safely refreshes ordinary retry files', (t) => {
  const root = setup(t), att = { filename: '../../CON.txt', content_b64: 'YQ==' };
  const path = saveInboxAttachment(root, 1, 2, att);
  assert.equal(path, join(root, 'inbox', 'job-1', '2-_CON.txt'));
  assert.equal(readFileSync(path, 'utf8'), 'a');
  saveInboxAttachment(root, 1, 2, { ...att, content_b64: 'Yg==' });
  assert.equal(readFileSync(path, 'utf8'), 'b');
  assert.throws(() => saveInboxAttachment(root, '../bad', 2, att), /ID/);
});
test('inbox refuses redirected parent and hardlinked existing leaf', (t) => {
  const root = setup(t), outside = join(root, 'outside'), cwd = join(root, 'cwd');
  mkdirSync(outside); mkdirSync(cwd);
  symlinkSync(outside, join(cwd, 'inbox'), 'junction');
  assert.throws(() => saveInboxAttachment(cwd, 1, 2, { filename: 'a.txt', content_b64: 'YQ==' }), /chuyển hướng/);
  rmSync(join(cwd, 'inbox'));
  mkdirSync(join(cwd, 'inbox', 'job-1'), { recursive: true });
  const target = join(outside, 'keep.txt'); writeFileSync(target, 'keep');
  linkSync(target, join(cwd, 'inbox', 'job-1', '2-a.txt'));
  assert.throws(() => saveInboxAttachment(cwd, 1, 2, { filename: 'a.txt', content_b64: 'YQ==' }), /không an toàn/);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});
