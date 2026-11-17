import test from 'node:test';
import assert from 'node:assert/strict';
import PostalMime from 'postal-mime';
import { buildMail, validateAttachments } from '../src/mime.js';

const mail = { from: 'claude@example.com', to: 'owner@example.com', text: 'Xin chào 🌱', subject: 'Kết quả' };
const att = { filename: 'Kết quả (1).txt', mime_type: 'text/plain', b64: Buffer.from('kết quả\n').toString('base64') };
test('plain MIME has no undefined, safe optional threading and injection handling', async () => {
  const raw = buildMail({ ...mail, subject: 'hello\r\nInjected: bad', jobId: 42 });
  assert.match(raw, /X-Mailbot-Job: 42/);
  assert.ok(!raw.includes('undefined'));
  assert.ok(!raw.includes('\r\nInjected:'));
  assert.ok(!raw.includes('In-Reply-To:'));
  assert.equal((await PostalMime.parse(raw)).text.trim(), mail.text);
  assert.throws(() => buildMail({ ...mail, to: 'owner@example.com\r\nBcc: x@y.com' }));
});
test('multipart roundtrip preserves UTF-8 filename and binary data, wraps base64', async () => {
  const files = [att, { filename: 'x.bin', mime_type: 'application/octet-stream', b64: Buffer.alloc(500, 255).toString('base64') }];
  const raw = buildMail({ ...mail, attachments: files, inReplyTo: '<parent@x>', references: '<root@x> <parent@x>' });
  assert.match(raw, /filename="K_t qu_ \(1\).txt"; filename\*=UTF-8''K%E1%BA%BFt%20qu%E1%BA%A3%20%281%29.txt/);
  assert.ok(raw.split('\r\n').filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).every((l) => l.length <= 76));
  const parsed = await PostalMime.parse(raw);
  assert.equal(parsed.subject, mail.subject);
  assert.equal(parsed.attachments[0].filename, att.filename);
  assert.deepEqual(Buffer.from(parsed.attachments[1].content), Buffer.alloc(500, 255));
  assert.equal(parsed.inReplyTo, '<parent@x>');
});
test('attachment validation rejects count, total, base64 and MIME abuse', () => {
  assert.throws(() => validateAttachments(Array(11).fill(att)));
  assert.throws(() => validateAttachments([{ ...att, b64: 'A'.repeat(3 * 1024 * 1024) }]));
  for (const b64 of ['YQ==\r\n', 'a', '====', 'YWJj=', 'ab$c']) assert.throws(() => validateAttachments([{ ...att, b64 }]));
  assert.throws(() => validateAttachments([{ ...att, mime_type: 'text/plain\r\nX: bad' }]));
  const [safe] = validateAttachments([{ ...att, filename: '\x00"/\\' + 'a'.repeat(200) }]);
  assert.equal(safe.filename, 'a'.repeat(150));
  assert.equal(safe.size, Buffer.from(att.b64, 'base64').length);
  assert.equal(validateAttachments([{ ...att, b64: '' }])[0].size, 0);
  assert.doesNotThrow(() => buildMail({ ...mail, attachments: [{ ...att, filename: 'a'.repeat(149) + '🌱' }] }));
});
