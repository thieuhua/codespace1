import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFields, waitForAssets } from '../client/display/content/renderer.js';
import { SAMPLE_CONFIG, validateContent } from '../shared/content/schema.js';

// A small DOM contract: any attempt to parse HTML fails this non-browser test.
function documentStub() {
  const document = { fonts: { ready: Promise.resolve() }, createElement: tag => new Node(tag) };
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.ownerDocument = document; this._text = ''; }
    set innerHTML(_) { assert.fail('Không được phân tích HTML từ nguồn nội dung'); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    setAttribute(key, value) { this.attrs[key] = value; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
    decode() { return Promise.resolve(); }
  }
  return document;
}

test('all templates render script markup as literal text and unsafe image URLs are discarded', () => {
  const document = documentStub(), root = document.createElement('article'), attack = '<script>globalThis.hacked=1</script><img src=x onerror=alert(1)>';
  for (const templateId of ['poster', 'fields', 'ticker']) {
    const config = validateContent({ ...SAMPLE_CONFIG, templateId, config: { fields: { title: attack, image: 'javascript:alert(1)' } } });
    renderFields(root, config.config.fields, config);
    assert.ok(root.textContent.includes(attack)); assert.equal(root.querySelectorAll('script').length, 0); assert.equal(root.querySelectorAll('img').length, 0);
  }
  const textImage = validateContent({ ...SAMPLE_CONFIG, fieldMap: { image: { source: '/image', type: 'text' } }, config: { fields: { image: 'data:image/svg+xml,<svg/>' } } });
  renderFields(root, textImage.config.fields, textImage); assert.equal(root.querySelectorAll('img').length, 0);
});

test('images disable referrers and iframe mode is sandboxed with a separate document', () => {
  const document = documentStub(), root = document.createElement('article');
  renderFields(root, { image: 'https://example.com/a.png' }, validateContent(SAMPLE_CONFIG));
  assert.equal(root.querySelectorAll('img')[0].referrerPolicy, 'no-referrer');
  const config = validateContent({ ...SAMPLE_CONFIG, adapterId: 'iframe', config: { url: 'https://example.com/page' } });
  renderFields(root, {}, config);
  const frame = root.querySelectorAll('iframe')[0];
  assert.equal(frame.attrs.sandbox, ''); assert.equal(frame.referrerPolicy, 'no-referrer'); assert.equal(frame.src, config.config.url);
  renderFields(root, {}, config); assert.equal(root.querySelector('iframe'), frame);
});

test('manual local images remain usable in the fields template', () => {
  const document = documentStub(), root = document.createElement('article');
  renderFields(root, {}, validateContent({ ...SAMPLE_CONFIG, templateId: 'fields' }), { localImage: 'blob:local-image' });
  assert.equal(root.querySelectorAll('img')[0].src, 'blob:local-image');
});

test('raster asset barrier waits for fonts and images and bounds a stalled asset', async () => {
  let finishFont, finishImage, done = false;
  const container = { ownerDocument: { fonts: { ready: new Promise(resolve => { finishFont = resolve; }) } }, querySelectorAll: () => [{ decode: () => new Promise(resolve => { finishImage = resolve; }) }] };
  const waiting = waitForAssets(container, 1000).then(() => { done = true; });
  finishFont(); await Promise.resolve(); assert.equal(done, false);
  finishImage(); await waiting; assert.equal(done, true);
  container.querySelectorAll = () => [{ decode: () => new Promise(() => {}) }];
  await waitForAssets(container, 1);
});
