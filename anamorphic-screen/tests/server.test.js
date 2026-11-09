import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import sharp from 'sharp';
import { WebSocket } from 'ws';
import { createApplication } from '../server/index.js';
import { SessionStore } from '../server/sessions.js';
import { markerLayout, MARKER_IDS } from '../shared/calibration.js';
import { syntheticPhoto } from './fixtures.js';

async function setup(t, options) {
  const runtime = createApplication(options);
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  t.after(() => runtime.close());
  const request = (route, body, method = 'POST') => fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const viewport = { vw: 1440, vh: 900, dpr: 1 }, markers = markerLayout(viewport);
  const response = await request('/api/session', { viewport, markers });
  assert.equal(response.status, 201);
  const { sessionId: id } = await response.json();
  return { ...runtime, url, request, id, viewport, markers };
}
function upload(url, data, type = 'image/png') {
  const form = new FormData(); form.append('photo', new Blob([data], { type }), 'photo.png');
  return fetch(url, { method: 'POST', body: form });
}
async function subscribe(url, id) {
  const socket = new WebSocket(url.replace('http', 'ws') + `/ws?session=${id}`), messages = [];
  socket.on('message', buffer => messages.push(JSON.parse(buffer)));
  await once(socket, 'open');
  return { socket, messages };
}
const until = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); } assert.ok(condition()); };

test('session TTL expires after 15 minutes of inactivity and enforces capacity', () => {
  let time = 0, expired = [];
  const store = new SessionStore({ now: () => time, capacity: 1, onExpire: s => expired.push(s.id) });
  const session = store.create({});
  assert.throws(() => store.create({}));
  time = 14 * 60_000; assert.equal(store.get(session.id), session);
  time += 14 * 60_000; store.sweep(); assert.equal(store.sessions.size, 1);
  time += 60_000; store.sweep(); assert.equal(store.get(session.id), null); assert.deepEqual(expired, [session.id]);
});

test('real upload detection broadcasts calibrated and reconnect replays its result', async t => {
  const app = await setup(t), fixture = await syntheticPhoto();
  const { socket, messages } = await subscribe(app.url, app.id);
  t.after(() => socket.terminate());
  const response = await upload(`${app.url}/api/session/${app.id}/photo`, fixture.buffer);
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data)); assert.equal(data.ok, true);
  await until(() => messages.some(m => m.type === 'calibrated'));
  assert.ok(messages.some(m => m.type === 'photo_received'));
  const event = messages.find(m => m.type === 'calibrated');
  assert.equal(event.Q.length, 4); assert.deepEqual(event.imageSize, fixture.imageSize);
  const preview = await fetch(app.url + data.previewUrl); assert.equal(preview.status, 200); assert.match(preview.headers.get('content-type'), /image\/jpeg/);
  socket.close();
  const second = await subscribe(app.url, app.id); t.after(() => second.socket.terminate());
  await until(() => second.messages.some(m => m.type === 'calibrated'));
  assert.deepEqual(second.messages.find(m => m.type === 'calibrated').Q, event.Q);
  const qr = await fetch(`${app.url}/api/session/${app.id}/qr?url=${encodeURIComponent(`${app.url}/capture/${app.id}`)}`);
  assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
});

test('manual fallback validates IDs, coordinate bounds, winding and stale photos', async t => {
  const app = await setup(t);
  const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#fff' } }).png().toBuffer();
  const data = await (await upload(`${app.url}/api/session/${app.id}/photo`, blank)).json();
  assert.equal(data.ok, false); assert.equal(data.points.length, 0);
  const points = MARKER_IDS.map((id, i) => ({ id, x: [80, 720, 720, 80][i], y: [60, 60, 540, 540][i] }));
  const route = `/api/session/${app.id}/points`;
  assert.equal((await app.request(route, { photoId: 'old', points })).status, 409);
  assert.equal((await app.request(route, { photoId: data.photoId, points: points.map(p => ({ ...p, id: 17 })) })).status, 400);
  assert.equal((await app.request(route, { photoId: data.photoId, points: points.map(p => ({ ...p, x: -1 })) })).status, 400);
  const reversed = points.map((p, i) => ({ ...p, id: MARKER_IDS[(4 - i) % 4] }));
  assert.equal((await app.request(route, { photoId: data.photoId, points: reversed })).status, 400);
  const response = await app.request(route, { photoId: data.photoId, points });
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  const refreshed = await (await fetch(`${app.url}/api/session/${app.id}`)).json(); assert.equal(refreshed.photo.ok, true);
  // Legacy array form described in the original specification is also supported.
  assert.equal((await app.request(route, points)).status, 200);
});

test('HTTP rejects malformed inputs, unsupported files and uploads above 20 MB; recovers afterward', async t => {
  const app = await setup(t);
  assert.equal((await app.request('/api/session', {})).status, 400);
  assert.equal((await app.request('/api/session', { viewport: app.viewport, markers: [] })).status, 400);
  assert.equal((await app.request(`/api/session/${app.id}/points`, [])).status, 400);
  assert.equal((await upload(`${app.url}/api/session/${app.id}/photo`, Buffer.from('broken'))).status, 422);
  const big = await upload(`${app.url}/api/session/${app.id}/photo`, Buffer.alloc(20 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  const blank = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
  assert.equal((await upload(`${app.url}/api/session/${app.id}/photo`, blank)).status, 200);
  assert.equal((await fetch(`${app.url}/api/session/not-a-session`)).status, 404);
  assert.equal((await fetch(`${app.url}/../package.json`)).status, 404);
  assert.equal((await app.request(`/api/session/${app.id}`, undefined, 'DELETE')).status, 204);
  assert.equal((await fetch(`${app.url}/api/session/${app.id}`)).status, 404);
});

test('expired sessions notify the display and remove image data', async t => {
  let time = Date.now();
  const app = await setup(t, { ttl: 100, now: () => time });
  const { socket, messages } = await subscribe(app.url, app.id); t.after(() => socket.terminate());
  time += 101; app.store.sweep();
  await until(() => messages.some(m => m.type === 'session_expired'));
  assert.equal((await fetch(`${app.url}/api/session/${app.id}`)).status, 404);
});
