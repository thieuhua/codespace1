import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubject } from '../src/subject.js';

test('repeated reply prefixes, leading commands, remaining subject', () => {
  assert.deepEqual(parseSubject('Re: FwD : TR: /new /model=opus-4.6 /effort=max Sửa lỗi /status'), {
    options: { new: true, model: 'opus-4.6', effort: 'max' }, subject: 'Sửa lỗi /status', action: null, cancelId: null, error: null,
  });
});
test('paths and malformed command tokens remain ordinary subject', () => {
  for (const s of ['/etc/fstab', '//status', '/model=-oops', '/model=' + 'a'.repeat(65), '/NEW']) {
    assert.equal(parseSubject(s).subject, s);
    assert.equal(parseSubject(s).error, null);
  }
  assert.equal(parseSubject('hello /new').subject, 'hello /new');
});
test('unknown, invalid values and ambiguous actions return help errors', () => {
  for (const s of ['/unknown', '/effort=extreme', '/new=yes', '/cancel=0', '/cancel=oops', '/cancel=9007199254740992', '/status /cancel', '/new /status']) {
    assert.ok(parseSubject(s).error, s);
  }
  assert.equal(parseSubject('/cancel=42').cancelId, 42);
  assert.equal(parseSubject('/cancel').cancelId, null);
  assert.equal(parseSubject('/status').action, 'status');
});
