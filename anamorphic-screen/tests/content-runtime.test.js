import test from 'node:test';
import assert from 'node:assert/strict';
import { create, register } from '../client/display/content/runtime.js';
import { adapters } from '../client/display/content/adapters/index.js';
import { SAMPLE_CONFIG } from '../shared/content/schema.js';

function controlled(t, options) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instances = [];
  register('manual', () => {
    const instance = { start(callbacks) { Object.assign(this, callbacks); }, stop() { this.stopped = true; } };
    instances.push(instance); return instance;
  });
  t.after(() => register('manual', adapters.manual));
  const runtime = create(SAMPLE_CONFIG, { coalesceMs: 100, ...options });
  t.after(() => runtime.stop());
  const values = [], states = [];
  const start = signal => runtime.start({ signal, onData: value => values.push(value), onStatus: value => states.push(value) });
  start();
  return { runtime, instances, values, states, start };
}

test('runtime coalesces a burst in a fixed window so a fast feed cannot starve delivery', t => {
  const { instances, values, runtime } = controlled(t), adapter = instances[0];
  for (let i = 0; i < 10; i++) { adapter.onData({ title: String(i) }); t.mock.timers.tick(10); }
  assert.equal(values.length, 1); assert.equal(values[0].title, '9');
  adapter.onData({ title: 'cuối' }); t.mock.timers.tick(100);
  assert.equal(values.length, 2); assert.equal(runtime.lastGood.title, 'cuối');
});

test('runtime keeps the last good fields on error and recovers without clearing the screen', t => {
  const { instances, values, states, runtime } = controlled(t), adapter = instances[0];
  adapter.onStatus({ state: 'error', reason: 'Lỗi đầu' }); assert.equal(states.at(-1).state, 'error');
  adapter.onData({ title: 'hợp lệ' }); t.mock.timers.tick(100);
  adapter.onStatus({ state: 'error', reason: 'Mất mạng' });
  assert.equal(states.at(-1).state, 'stale'); assert.equal(runtime.lastGood.title, 'hợp lệ'); assert.equal(values.length, 1);
  adapter.onData({ title: 'mới' }); adapter.onStatus({ state: 'error', reason: 'Lỗi sau dữ liệu' }); t.mock.timers.tick(100);
  assert.equal(values.at(-1).title, 'mới'); assert.equal(states.at(-1).state, 'stale');
  adapter.onData({ title: 'phục hồi' }); t.mock.timers.tick(100); assert.equal(states.at(-1).state, 'ready');
});

test('stop, external abort and restart drop callbacks and pending data from old instances', t => {
  const { instances, values, states, runtime, start } = controlled(t), old = instances[0];
  old.onData({ title: 'đang chờ' }); runtime.stop(); t.mock.timers.tick(100);
  assert.equal(old.signal.aborted, true); assert.equal(old.stopped, true); assert.equal(values.length, 0);
  const controller = new AbortController(); start(controller.signal);
  old.onData({ title: 'cũ' }); old.onStatus({ state: 'error', reason: 'cũ' });
  t.mock.timers.tick(100); assert.equal(values.length, 0); assert.equal(states.at(-1).state, 'loading');
  instances[1].onData({ title: 'hiện tại' }); t.mock.timers.tick(100); assert.equal(values.at(-1).title, 'hiện tại');
  controller.abort(); instances[1].onData({ title: 'sau hủy' }); t.mock.timers.tick(100); assert.equal(values.length, 1);
  start(AbortSignal.abort()); assert.equal(instances.length, 2);
});

test('factory errors and late rejected starts become safe status events', async t => {
  const states = [];
  t.after(() => register('manual', adapters.manual));
  let rejectStart;
  register('manual', () => ({ start() { return new Promise((_, reject) => { rejectStart = reject; }); }, stop() {} }));
  const runtime = create(SAMPLE_CONFIG);
  runtime.start({ onStatus: state => states.push(state) }); runtime.stop(); rejectStart(new Error('trễ')); await Promise.resolve();
  assert.equal(states.at(-1).state, 'loading');
  register('manual', () => { throw new Error('Không tạo được nguồn'); });
  const broken = create(SAMPLE_CONFIG);
  broken.start({ onStatus: state => states.push(state) }); broken.stop();
  assert.equal(states.at(-1).state, 'error'); assert.match(states.at(-1).reason, /tạo/);
});

test('aborting during loading does not start the source', t => {
  let started = false;
  register('manual', () => ({ start() { started = true; }, stop() {} }));
  t.after(() => register('manual', adapters.manual));
  const runtime = create(SAMPLE_CONFIG), controller = new AbortController();
  runtime.start({ signal: controller.signal, onStatus: () => controller.abort() });
  assert.equal(started, false); runtime.stop();
});

test('manual and clock adapters need no network; clock stops its timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const manual = create(SAMPLE_CONFIG, { coalesceMs: 1 }), values = [];
  manual.start({ onData: fields => values.push(fields) }); t.mock.timers.tick(1); manual.stop();
  assert.equal(values[0].title, SAMPLE_CONFIG.config.fields.title);
  const clock = create({ ...SAMPLE_CONFIG, adapterId: 'clock', config: {} }, { coalesceMs: 1 });
  clock.start({ onData: fields => values.push(fields) }); t.mock.timers.tick(1);
  assert.match(values.at(-1).title, /\d/);
  clock.stop(); const count = values.length; t.mock.timers.tick(5000); assert.equal(values.length, count);
});

test('JSON adapter maps public CORS data and aborts its fetch when stopped', async t => {
  let requestOptions;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestOptions = options; return new Response(JSON.stringify({ title: 'Từ JSON', image: '/cover.png' }), { headers: { 'Content-Type': 'application/json' } });
  });
  const runtime = create({ ...SAMPLE_CONFIG, adapterId: 'json', config: { url: 'https://example.com/feed', interval: 5 } }, { coalesceMs: 1 });
  t.after(() => runtime.stop());
  const value = await new Promise(resolve => runtime.start({ onData: resolve }));
  assert.equal(value.title, 'Từ JSON'); assert.equal(requestOptions.credentials, 'omit'); assert.equal(requestOptions.mode, 'cors');
  assert.equal(value.image, 'https://example.com/cover.png');
  runtime.stop(); assert.equal(requestOptions.signal.aborted, true);
});

test('WebSocket adapter maps JSON, reports malformed frames, closes and ignores late data', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = globalThis.WebSocket, sockets = [];
  globalThis.WebSocket = class { constructor(url) { this.url = url; sockets.push(this); } close() { this.closed = true; this.onclose?.(); } };
  t.after(() => { globalThis.WebSocket = previous; });
  const runtime = create({ ...SAMPLE_CONFIG, adapterId: 'websocket', config: { url: 'wss://example.com/feed' } }, { coalesceMs: 1 }), values = [], states = [];
  t.after(() => runtime.stop());
  runtime.start({ onData: data => values.push(data), onStatus: state => states.push(state) });
  sockets[0].onmessage({ data: '{"title":"tin mới"}' }); t.mock.timers.tick(1); assert.equal(values[0].title, 'tin mới');
  sockets[0].onmessage({ data: '<html>' }); assert.equal(states.at(-1).state, 'stale');
  runtime.stop(); sockets[0].onmessage({ data: '{"title":"trễ"}' }); t.mock.timers.tick(10000);
  assert.equal(sockets[0].closed, true); assert.equal(sockets.length, 1); assert.equal(values.length, 1);
});
