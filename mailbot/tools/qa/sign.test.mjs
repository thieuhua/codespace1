// Pure, offline tests: ephemeral keys in memory; no config, file writes, SMTP or CLI.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import PostalMime from '../../worker/node_modules/postal-mime/src/postal-mime.js';
import { buildMessage, parseOptions } from './sign.mjs';

const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
const input = { to: 'codex@xuanthieu.site', subject: 'QA nonce-123', body: 'Xin chào\\nline 2', key: good.privateKey };

// Verify the serialized wire message rather than the builder's intermediate data.
function verifyDkim(raw, publicKey) {
  const split = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ').split('\r\n').map((line) => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1)];
  });
  const signature = headers.find(([name]) => name === 'dkim-signature')[1];
  const tags = Object.fromEntries(signature.split(';').map((tag) => {
    const equals = tag.indexOf('=');
    return [tag.slice(0, equals).trim(), tag.slice(equals + 1).trim()];
  }));
  assert.equal(tags.d, 'qa.xuanthieu.site');
  assert.equal(tags.s, 'mb1');
  assert.equal(tags.c, 'relaxed/relaxed');
  const body = raw.slice(split + 4).split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').trimEnd());
  while (body.length && body.at(-1) === '') body.pop();
  const canonicalBody = body.length ? body.join('\r\n') + '\r\n' : '';
  assert.equal(tags.bh, createHash('sha256').update(canonicalBody).digest('base64'));
  const canonical = (name, value) => name + ':' + value.replace(/[ \t]+/g, ' ').trim();
  const signed = tags.h.split(':').map((name) => {
    const match = headers.findLast(([key]) => key === name);
    assert.ok(match, `Missing signed header ${name}`);
    return canonical(name, match[1]);
  });
  signed.push(canonical('dkim-signature', signature.replace(/\bb=[\s\S]*$/, 'b=')));
  return verify('RSA-SHA256', Buffer.from(signed.join('\r\n')), publicKey, Buffer.from(tags.b.replace(/\s/g, ''), 'base64'));
}

test('legacy defaults: UTF-8, literal backslash-n, CRLF and verifiable DKIM', async () => {
  const raw = buildMessage(input);
  const mail = await PostalMime.parse(raw);
  assert.equal(mail.from.address, 'qa@qa.xuanthieu.site');
  assert.equal(mail.to[0].address, input.to);
  assert.equal(mail.subject, input.subject);
  assert.equal(mail.text.trim(), 'Xin chào\nline 2');
  assert.match(mail.messageId, /^<qa-[a-f0-9-]+@qa\.xuanthieu\.site>$/);
  assert.doesNotMatch(raw, /(?<!\r)\n/);
  assert.ok(verifyDkim(raw, good.publicKey));
});

test('custom From, auto header and threading headers survive parsing and are signed', async () => {
  const raw = buildMessage({ ...input, options: {
    from: 'qa-stranger@qa.xuanthieu.site',
    extraHeaders: { 'Auto-Submitted': 'auto-replied', 'X-QA': 'nonce-123' },
    inReplyTo: '<answer@example.com>', references: '<first@example.com> <answer@example.com>',
  } });
  const mail = await PostalMime.parse(raw);
  assert.equal(mail.from.address, 'qa-stranger@qa.xuanthieu.site');
  assert.equal(mail.inReplyTo, '<answer@example.com>');
  assert.equal(mail.references, '<first@example.com> <answer@example.com>');
  assert.ok(mail.headers.some((header) => header.key === 'auto-submitted' && header.value === 'auto-replied'));
  assert.ok(verifyDkim(raw, good.publicKey));
  assert.equal(verifyDkim(raw.replace('Auto-Submitted: auto-replied', 'Auto-Submitted: no'), good.publicKey), false);
});

test('wrong key signs validly but fails verification against the intended key', () => {
  const raw = buildMessage({ ...input, key: wrong.privateKey, options: { dkimKeyFile: 'temporary-wrong.pem' } });
  assert.ok(verifyDkim(raw, wrong.publicKey));
  assert.equal(verifyDkim(raw, good.publicKey), false);
  assert.equal(parseOptions('{"dkimKeyFile":"temporary-wrong.pem"}').dkimKeyFile, 'temporary-wrong.pem');
});

test('skipDkim builds without any key', async () => {
  const raw = buildMessage({ ...input, key: undefined, options: { skipDkim: true } });
  assert.doesNotMatch(raw, /^DKIM-Signature:/m);
  assert.equal((await PostalMime.parse(raw)).from.address, 'qa@qa.xuanthieu.site');
});

test('relaxed body hashing covers empty, whitespace and trailing blank lines', () => {
  for (const body of ['', ' \t\n', 'a  b \t\n\n', 'a\r\nb\n']) {
    assert.ok(verifyDkim(buildMessage({ ...input, body }), good.publicKey));
  }
});

test('message ids are distinct', async () => {
  const first = await PostalMime.parse(buildMessage(input));
  const second = await PostalMime.parse(buildMessage(input));
  assert.notEqual(first.messageId, second.messageId);
});

test('options reject malformed JSON, injection, duplicate/reserved headers and invalid types', () => {
  for (const json of ['{', 'null', '[]', '"text"', '{"skipDkim":"true"}', '{"unknown":1}']) {
    assert.throws(() => parseOptions(json));
  }
  for (const options of [
    { from: 'qa@example.com\r\nBcc: evil@example.com' },
    { from: 'Name <qa@example.com>' }, { inReplyTo: 'not-a-message-id' },
    { references: '<x@example.com>\n<y@example.com>' }, { dkimKeyFile: '' },
    { extraHeaders: [] }, { extraHeaders: { Subject: 'override' } },
    { extraHeaders: { 'Bad:Name': 'value' } }, { extraHeaders: { 'X-Test': 'a\r\nb' } },
    { extraHeaders: { 'X-Test': 1 } }, { extraHeaders: { 'X-Test': 'one', 'x-test': 'two' } },
  ]) assert.throws(() => parseOptions(JSON.stringify(options)));
  assert.throws(() => buildMessage({ ...input, subject: 'bad\r\nBcc: evil@example.com' }));
  assert.throws(() => buildMessage({ ...input, to: 'codex@example.com; command' }));
});
