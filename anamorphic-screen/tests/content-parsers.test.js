import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseRSS } from '../server/content/adapters/rss.js';
import { extractHTML, parseHTML } from '../server/content/adapters/html.js';
import { mapFields } from '../shared/content/mapping.js';

const fixture = name => readFile(new URL(`./fixtures/content.${name}`, import.meta.url), 'utf8');

test('RSS 2.0 supports item N, CDATA, entities, namespaced elements and images', async () => {
  const source = await fixture('rss.xml'), item = parseRSS(source);
  assert.equal(item.title, 'Tin & ảnh 📷');
  assert.equal(item.description, 'Đoạn nội dung');
  assert.equal(item['content:encoded'], 'Nội dung đầy đủ');
  assert.equal(parseRSS(source, 1).title, 'Mục thứ hai');
  assert.equal(parseRSS(source, 1).description, 'Hai chữ');
  assert.throws(() => parseRSS(source, 2), /Không tìm thấy/);
  assert.deepEqual(mapFields(item, { date: { source: 'pubDate' }, image: { source: 'enclosure', type: 'imageUrl' } }, { kind: 'rss', baseURL: 'https://example.com/rss' }), { date: 'Mon, 09 Nov 2026 08:30:00 GMT', image: 'https://example.com/cover.png' });
});

test('Atom supports alternate links, summary, updated and media thumbnails', async () => {
  const item = parseRSS(await fixture('atom.xml'));
  assert.equal(item.title, 'Ngày mới');
  assert.equal(item.link, '/bai-viet');
  assert.equal(item.description, 'Nắng & gió');
  assert.equal(item.pubdate, '2026-11-09T08:30:00Z');
  assert.equal(item.thumbnail, '/atom.png');
});

test('static HTML selectors support tag, ID, class, attributes, descendants and direct children', async () => {
  const tree = parseHTML(await fixture('html'));
  assert.equal(extractHTML(tree, '#news > article.card.active h1'), 'Xin chào & hẹn gặp');
  assert.equal(extractHTML(tree, 'article[data-kind="news"] > p.summary'), 'Dòng đầu Dòng sau');
  assert.equal(extractHTML(tree, 'meta[name=description]', 'content'), 'Một bản tin & ảnh');
  assert.equal(extractHTML(tree, 'a', 'href'), '/doc');
  assert.equal(extractHTML(tree, '.absent'), '');
  const fields = mapFields(tree, { title: { source: 'h1' }, image: { source: '#news img', attribute: 'src', type: 'imageUrl' } }, { kind: 'html', extract: extractHTML, baseURL: 'https://example.com/feed' });
  assert.deepEqual(fields, { title: 'Xin chào & hẹn gặp', image: 'https://example.com/photo.png' });
  for (const selector of ['p:first-child', 'h1,p', 'a + p', '> p', 'main >', 'main >> p', '']) assert.throws(() => extractHTML(tree, selector));
});

test('parsers reject XML entity declarations and bound depth, node count and size', () => {
  assert.throws(() => parseRSS('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'), /XML/);
  assert.throws(() => parseHTML('<div>'.repeat(130)), /sâu/);
  assert.throws(() => parseHTML('<br>'.repeat(50001)), /phần tử/);
  assert.throws(() => parseHTML('x'.repeat(2 * 1024 * 1024 + 1)), /lớn/);
});

test('HTML ignores tags inside script text and overlapping ancestor selectors stay bounded', () => {
  const tree = parseHTML('<script>const fake = "<h1>Giả</h1>";</script><h1>Thật</h1>');
  assert.equal(extractHTML(tree, 'h1'), 'Thật');
  const nested = parseHTML('<div>'.repeat(100) + '<p>Cuối</p>' + '</div>'.repeat(100));
  assert.equal(extractHTML(nested, 'div div div div div div div div div div p'), 'Cuối');
});
