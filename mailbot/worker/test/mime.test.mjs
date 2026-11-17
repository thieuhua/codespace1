import test from 'node:test';
import assert from 'node:assert/strict';
import PostalMime from 'postal-mime';
import { buildMail, validateAttachments, validateBase64Lines } from '../src/mime.js';

const mail = { from: 'claude@example.com', to: 'owner@example.com', text: 'Xin chào 🌱', subject: 'Kết quả' };
const att = { filename: 'Kết quả (1).txt', mime_type: 'text/plain', b64_lines: Buffer.from('kết quả\n').toString('base64') };
test('plain MIME has no undefined, safe optional threading and injection handling', async () => {
  const raw = buildMail({ ...mail, subject: 'hello\r\nInjected: bad', jobId: 42 });
  assert.match(raw, /X-Mailbot-Job: 42/);
  assert.match(raw, /Auto-Submitted: auto-replied/);
  assert.ok(!raw.includes('undefined'));
  assert.ok(!raw.includes('\r\nInjected:'));
  assert.ok(!raw.includes('In-Reply-To:'));
  assert.equal((await PostalMime.parse(raw)).text.trim(), mail.text);
  assert.throws(() => buildMail({ ...mail, to: 'owner@example.com\r\nBcc: x@y.com' }));
});

test('C6 prewrapped base64 has strict CRLF/76/padding; validated arrays cannot be forged or mutated', () => {
  const full = 'A'.repeat(76);
  for (const invalid of [full + 'AAAA', full + '\nAAAA', full + '\rAAAA', full + '\r\n',
    'AAAA\r\nAAAA', full + '\r\nA=AA', full + '\r\nAA===', full + '\r\nA\nAA',
    'AA==AAAA', 'A===', '====']) assert.throws(() => validateBase64Lines(invalid), undefined, invalid.slice(-15));
  assert.equal(validateBase64Lines(full + '\r\nYQ=='), 58);
  const files = validateAttachments([att]);
  assert.equal(validateAttachments(files), files);
  assert.throws(() => { files[0].b64_lines = 'bad'; }, TypeError);
  assert.throws(() => buildMail({ ...mail, attachments: [{ ...att, b64_lines: 'bad' }], validated: true }));
  const raw = buildMail({ ...mail, attachments: files });
  assert.ok(raw.includes(att.b64_lines));
});

test('C6 local 2 MB string-processing CPU benchmark (no JSON, I/O or network)', (t) => {
  const b64_lines = Buffer.alloc(2 * 1024 * 1024, 123).toString('base64').match(/.{1,76}/g).join('\r\n');
  // Flatten before timing, as request.json supplies an already materialized string.
  b64_lines.charCodeAt(b64_lines.length - 1);
  for (let i = 0; i < 3; i++) validateBase64Lines(b64_lines);
  const times = [], wall = [], iterations = 40;
  for (let i = 0; i < 5; i++) {
    const start = process.cpuUsage();
    const clock = performance.now();
    for (let n = 0; n < iterations; n++) {
      const files = validateAttachments([{ ...att, b64_lines }]);
      assert.equal(validateAttachments(files), files); // buildMail reuses this exact capability.
      assert.equal(files[0].size, 2 * 1024 * 1024);
    }
    wall.push((performance.now() - clock) / iterations);
    const elapsed = process.cpuUsage(start);
    times.push((elapsed.user + elapsed.system) / 1000 / iterations);
  }
  const median = [...times].sort((a, b) => a - b)[2];
  t.diagnostic(`2 MB validate once + trusted reuse CPU ms/op (${iterations} iterations/batch for Windows timer precision): ${times.join(', ')}; median=${median}; wall ms/op=${wall.map((n) => n.toFixed(3)).join(', ')}; target <5 ms (local only)`);
});
test('multipart roundtrip preserves UTF-8 filename and binary data, wraps base64', async () => {
  const files = [att, { filename: 'x.bin', mime_type: 'application/octet-stream', b64_lines: Buffer.alloc(500, 255).toString('base64').match(/.{1,76}/g).join('\r\n') }];
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
  assert.throws(() => validateAttachments([{ ...att, b64_lines: 'A'.repeat(3 * 1024 * 1024) }]));
  for (const b64_lines of ['YQ==\r\n', 'a', '====', 'YWJj=', 'ab$c']) assert.throws(() => validateAttachments([{ ...att, b64_lines }]));
  assert.throws(() => validateAttachments([{ ...att, mime_type: 'text/plain\r\nX: bad' }]));
  const [safe] = validateAttachments([{ ...att, filename: '\x00"/\\' + 'a'.repeat(200) }]);
  assert.equal(safe.filename, 'a'.repeat(150));
  assert.equal(safe.size, Buffer.from(att.b64_lines, 'base64').length);
  assert.equal(validateAttachments([{ ...att, b64_lines: '' }])[0].size, 0);
  assert.doesNotThrow(() => buildMail({ ...mail, attachments: [{ ...att, filename: 'a'.repeat(149) + '🌱' }] }));
});
