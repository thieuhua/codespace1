import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_TYPES, SAMPLE_CONFIG, normalizeFields, validateContent, validateFieldMap } from '../shared/content/schema.js';
import { formatValue, jsonPointer, mapFields, selectorSteps } from '../shared/content/mapping.js';

const source = (adapterId, config) => ({ ...SAMPLE_CONFIG, adapterId, config });

test('schema bounds fields and only accepts known adapters, templates, config and formatters', () => {
  const value = validateContent(SAMPLE_CONFIG);
  assert.notEqual(value.config, SAMPLE_CONFIG.config);
  assert.equal(value.fieldMap.title.maxLength, FIELD_TYPES.multiline);
  for (const raw of [
    { ...value, version: 2 }, { ...value, adapterId: '__proto__' }, { ...value, templateId: 'script' },
    source('manual', { fields: {}, headers: { Authorization: 'secret' } }),
    { ...value, fieldMap: { title: { source: '/x', type: 'html' } } },
    { ...value, fieldMap: { title: { source: '/x', formatters: ['eval'] } } },
    { ...value, fieldMap: { title: { source: '/x', attribute: 'onerror' } } },
    { ...value, fieldMap: { title: { source: '/x', maxLength: 100001 } } },
    { ...value, fieldMap: JSON.parse('{"__proto__":{"source":"/x"}}') },
    { ...value, fieldMap: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, { source: '' }])) }
  ]) assert.throws(() => validateContent(raw), error => error.status === 400);
  assert.throws(() => validateContent(source('manual', { fields: { title: 'ế'.repeat(21000) } })), /byte UTF-8/);
});

test('URL and polling validation rejects credentials, fragments, scripts and secret values in config', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', '/relative', 'https://u:p@example.com', 'https://example.com/#key']) {
    assert.throws(() => validateContent(source('json', { url })));
  }
  for (const [adapterId, config] of [
    ['json', { url: 'https://example.com', interval: 4 }],
    ['json', { url: 'https://example.com', proxy: true, interval: 14 }],
    ['rss', { url: 'https://example.com', interval: 14 }],
    ['rss', { url: 'https://example.com', item: -1 }],
    ['json', { url: 'https://example.com', secretRef: 'api' }],
    ['json', { url: 'https://example.com', apiKey: 'secret' }],
    ['websocket', { url: 'https://example.com' }]
  ]) assert.throws(() => validateContent(source(adapterId, config)));
  assert.equal(validateContent(source('json', { url: 'https://example.com', interval: 5 })).config.interval, 5);
  assert.equal(validateContent(source('json', { url: 'https://example.com', proxy: true, interval: 15, secretRef: 'api' })).config.secretRef, 'api');
  assert.equal(validateContent(source('websocket', { url: 'wss://example.com/feed' })).config.url, 'wss://example.com/feed');
});

test('JSON Pointer handles arrays, escaped keys, missing fields and prototype access', () => {
  const data = { 'a/b': { '~key': ['đúng'] }, nested: { value: 12 }, nil: null };
  assert.equal(jsonPointer(data, '/a~1b/~0key/0'), 'đúng');
  assert.equal(jsonPointer(data, ''), data);
  assert.equal(jsonPointer(data, '/nil/a'), '');
  assert.equal(jsonPointer(data, '/absent'), '');
  for (const pointer of ['a', '/~2', '/constructor', '/__proto__/x']) assert.throws(() => jsonPointer(data, pointer));
});

test('mapping formats and bounds plain text, keeps markup literal and validates image URLs', () => {
  const mapping = {
    title: { source: '/title', formatters: ['trim', 'upper'], maxLength: 12 },
    literal: { source: '/literal', type: 'multiline' },
    image: { source: '/image', type: 'imageUrl' },
    missing: { source: '/missing' }
  };
  const result = mapFields({ title: '  tiếng Việt dài hơn  ', literal: '<script>alert(1)</script>', image: '/cover.png' }, mapping, { baseURL: 'https://example.com/news' });
  assert.equal(result.title, 'TIẾNG VIỆT D');
  assert.equal(result.literal, '<script>alert(1)</script>');
  assert.equal(result.image, 'https://example.com/cover.png');
  assert.equal(result.missing, '');
  for (const image of ['javascript:alert(1)', 'data:image/svg+xml,x', 'https://u:p@example.com/x', 'blob:https://example.com/id']) {
    assert.equal(normalizeFields({ image }, validateFieldMap(mapping)).image, '');
  }
  assert.equal(formatValue(' 1234.5 ', ['number']), new Intl.NumberFormat('vi-VN').format(1234.5));
  assert.equal(formatValue('bad', ['number']), '');
  assert.equal(formatValue('bad', ['date']), '');
  assert.match(formatValue('2026-01-02T12:30:00Z', ['date']), /2026/);
  assert.throws(() => formatValue('x', ['constructor']));
  assert.throws(() => selectorSteps('div:has(script)'));
});
