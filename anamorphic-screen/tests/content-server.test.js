import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentService, authorized } from '../server/content/routes.js';
import { SessionStore } from '../server/sessions.js';
import { geometry, snapshot } from '../server/protocol.js';
import { markerLayout } from '../shared/calibration.js';
import { SAMPLE_CONFIG } from '../shared/content/schema.js';

const viewport = { vw: 1440, vh: 900, dpr: 1 };
const remote = (session, overrides = {}) => ({ ...SAMPLE_CONFIG, adapterId: 'json', config: { url: 'https://example.com/feed', proxy: true, interval: 15 }, contentRevision: session.contentConfig.contentRevision, ...overrides });
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(t, options = {}) {
  const events = [], service = createContentService({ broadcast: (_session, type, payload) => events.push({ type, ...payload }), ...options });
  const store = new SessionStore({ onExpire: session => service.stop(session) }), session = store.create(geometry(viewport, markerLayout(viewport)));
  t.after(() => service.close());
  const socket = { role: 'capture', messages: [], send(value) { this.messages.push(JSON.parse(value)); } };
  return { events, service, session, socket, store };
}

test('HTTP and WS config writes require a controller token and reject stale content revisions', async t => {
  const { service, session, socket, events } = setup(t);
  for (const token of [undefined, '', 'wrong', 'é'.repeat(session.controllerToken.length)]) {
    assert.equal(authorized(session, token), false);
    assert.throws(() => service.set(session, SAMPLE_CONFIG, token), error => error.status === 403);
  }
  service.message(session, socket, { type: 'content_config', requestId: 'denied', contentConfig: SAMPLE_CONFIG });
  assert.equal(socket.messages.at(-1).ok, false); assert.equal(events.length, 0);
  service.message(session, socket, { type: 'content_config', requestId: 'ok', contentConfig: SAMPLE_CONFIG, controllerToken: session.controllerToken });
  assert.equal(socket.messages.at(-1).ok, true); assert.equal(session.contentConfig.contentRevision, 1);
  assert.deepEqual(events.map(event => event.type), ['content_config', 'content_data', 'content_status']);
  assert.throws(() => service.set(session, SAMPLE_CONFIG, session.controllerToken), error => error.status === 409);
  const text = JSON.stringify(snapshot(session));
  assert.equal(text.includes(session.controllerToken), false); assert.equal(text.includes(session.contentDisplayKey), false);
});

test('content updates leave calibration revision, markers, live state and result untouched', t => {
  const { service, session } = setup(t);
  session.mode = 'live'; session.result = { Q: [[1, 2]], calibrationId: 9 }; session.lastFrame = { seq: 77 };
  session.tracker = { memory: 'giữ nguyên' }; session.frameOwner = {};
  const keys = ['revision', 'mode', 'result', 'viewport', 'markers', 'lastFrame', 'tracker', 'frameOwner'];
  const before = Object.fromEntries(keys.map(key => [key, session[key]]));
  service.set(session, { ...SAMPLE_CONFIG, config: { fields: { title: 'Nội dung mới' } } }, session.controllerToken);
  for (const key of keys) assert.equal(session[key], before[key], key);
  assert.equal(session.contentData.fields.title, 'Nội dung mới');
});

test('one poller per session; replacement and expiry cancel old work and ignore late data', async t => {
  const requests = [], { service, session, store, events } = setup(t, { fetchSource: (url, options) => new Promise(resolve => requests.push({ url, ...options, resolve })) });
  service.set(session, remote(session), session.controllerToken);
  service.set(session, remote(session), session.controllerToken);
  assert.equal(requests.length, 2); assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ body: '{"title":"cũ"}', url: requests[0].url }); await flush();
  assert.equal(events.some(event => event.fields?.title === 'cũ'), false);
  requests[1].resolve({ body: '{"title":"mới"}', url: requests[1].url }); await flush();
  assert.equal(session.contentData.fields.title, 'mới');
  store.delete(session.id); assert.equal(requests[1].signal.aborted, true);
});

test('server polls at 15 seconds and keeps last good data on a later error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { service, session } = setup(t, { fetchSource: async url => { if (++calls > 1) throw new Error('Mất nguồn'); return { body: '{"title":"Hợp lệ"}', url }; } });
  service.set(session, remote(session), session.controllerToken); await flush();
  assert.equal(session.contentStatus.state, 'ready');
  t.mock.timers.tick(14999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  assert.equal(session.contentStatus.state, 'stale'); assert.equal(session.contentData.fields.title, 'Hợp lệ');
  service.stop(session); t.mock.timers.tick(60000); await flush(); assert.equal(calls, 2);
});

test('mounted endpoints protect previews and keep named API headers in server RAM for one origin', async t => {
  const requests = [], { service, session } = setup(t, { fetchSource: async (url, options) => { requests.push(options); return { body: '{"title":"Đọc có khóa"}', url }; } });
  const routes = new Map(), app = Object.fromEntries(['get', 'put', 'post'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]));
  service.mount(app, () => {});
  const invoke = async (name, body, headers = {}) => {
    const req = { session, body, get: key => Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] };
    let response; await routes.get(name)(req, { json: value => { response = value; } }); return response;
  };
  const preview = 'post /api/session/:id/content/preview', secret = 'put /api/session/:id/content/secrets', config = 'put /api/session/:id/content/config';
  await assert.rejects(invoke(config, SAMPLE_CONFIG), error => error.status === 403);
  await assert.rejects(invoke(preview, remote(session)), error => error.status === 403);
  const controller = { 'X-Controller-Token': session.controllerToken };
  const key = { name: 'nguon', header: 'X-Api-Key', value: 'gia-tri-bi-mat', url: 'https://example.com/feed' };
  await assert.rejects(invoke(secret, key, controller), error => error.status === 403);
  await invoke(secret, key, { ...controller, 'X-Content-Display-Key': session.contentDisplayKey });
  const raw = remote(session); raw.config.secretRef = 'nguon';
  const result = await invoke(preview, raw, controller);
  assert.equal(result.fields.title, 'Đọc có khóa'); assert.deepEqual(requests[0].headers, { 'X-Api-Key': key.value });
  assert.equal(JSON.stringify(snapshot(session)).includes(key.value), false);
  assert.equal(JSON.stringify(result).includes(key.value), false);
  await assert.rejects(invoke(preview, { ...raw, config: { ...raw.config, url: 'https://other.example/feed' } }, controller), /origin/);
  await assert.rejects(invoke(config, { ...SAMPLE_CONFIG, fieldMap: {} }, controller), error => error.status === 400);
});

test('preview parses JSON, RSS and HTML without changing content or calibration', async t => {
  const { service, session } = setup(t, { fetchSource: async url => ({ body: url.endsWith('rss') ? '<rss><channel><item><title>Tin RSS</title></item></channel></rss>' : url.endsWith('html') ? '<h1>Tin HTML</h1>' : '{"title":"Tin JSON"}', url }) });
  const before = JSON.stringify(snapshot(session));
  for (const [adapterId, source, expected] of [['json', '/title', 'Tin JSON'], ['rss', 'title', 'Tin RSS'], ['html', 'h1', 'Tin HTML']]) {
    const raw = remote(session, { adapterId, config: { url: `https://example.com/${adapterId}`, ...(adapterId === 'json' ? { proxy: true } : {}) }, fieldMap: { title: { source } } });
    assert.equal((await service.preview(session, raw)).title, expected);
  }
  assert.equal(JSON.stringify(snapshot(session)), before);
});

test('per-session rate limits do not share budgets; client status requires current display authority', t => {
  const { service, session, store, socket } = setup(t);
  for (let i = 0; i < 20; i++) service.set(session, { ...SAMPLE_CONFIG, contentRevision: i }, session.controllerToken);
  assert.throws(() => service.set(session, { ...SAMPLE_CONFIG, contentRevision: 20 }, session.controllerToken), error => error.status === 429);
  const second = store.create(geometry(viewport, markerLayout(viewport)));
  service.set(second, { ...SAMPLE_CONFIG, adapterId: 'clock', config: {} }, second.controllerToken);
  const update = { type: 'content_status', controllerToken: second.controllerToken, contentRevision: 1, state: 'ready' };
  service.message(second, socket, update); assert.equal(socket.messages.at(-1).ok, false);
  socket.role = 'display'; service.message(second, socket, update); assert.equal(second.contentStatus.state, 'ready');
  service.message(second, socket, { ...update, contentRevision: 0, state: 'error' }); assert.equal(second.contentStatus.state, 'ready');
});
