import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApplication } from '../server/index.js';
import { publicURL } from '../server/public-url.js';
import { markerLayout, MARKER_IDS } from '../shared/calibration.js';
import { emaFrame } from '../shared/live.js';

const viewport = { vw: 1440, vh: 900, dpr: 1 };
const points = (dx = 0) => MARKER_IDS.map((id, i) => ({ id, x: [52, 588, 588, 52][i] + dx, y: [32, 32, 368, 368][i] }));
const imageSize = { w: 640, h: 400 };
async function setup(t, extra = {}) {
  let time = Date.now();
  const runtime = createApplication({ now: () => time, ...extra });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening'); t.after(() => runtime.close());
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  const created = await fetch(url + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewport, markers: markerLayout(viewport) }) });
  const { sessionId: id } = await created.json();
  async function connect(role) {
    const socket = new WebSocket(`${url.replace('http', 'ws')}/ws?session=${id}&role=${role}`);
    const messages = [];
    socket.on('message', buffer => messages.push(JSON.parse(buffer)));
    t.after(() => socket.terminate());
    await once(socket, 'open');
    const wait = async predicate => {
      for (let n = 0; n < 200; n++) { const found = messages.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 5)); }
      throw new Error(`Missing event; received: ${JSON.stringify(messages)}`);
    };
    await wait(m => m.type === 'connected');
    return { socket, messages, wait, send(data) { socket.send(JSON.stringify(data)); },
      async command(type, payload = {}) {
        const requestId = Math.random().toString(); socket.send(JSON.stringify({ type, requestId, ...payload }));
        return wait(m => m.type === 'command_ack' && m.requestId === requestId);
      }, async frame(seq, revision, extra = {}) {
        time += 80;
        const after = messages.length;
        socket.send(JSON.stringify({ type: 'live_points', seq, revision, points: points(), imageSize, fps: 12.5, ...extra }));
        return wait((m, i) => i >= after && m.type === 'frame_ack' && m.seq === seq);
      }
    };
  }
  return { ...runtime, id, url, connect, advance(ms) { time += ms; } };
}

test('Codespaces URL is automatic; PUBLIC_URL remains the explicit override', () => {
  assert.equal(publicURL(3000, { CODESPACE_NAME: 'supreme-acorn-69g4wgg9qx75hrj44', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }), 'https://supreme-acorn-69g4wgg9qx75hrj44-3000.app.github.dev');
  assert.equal(publicURL(8080, { CODESPACE_NAME: 'test', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'preview.example', PUBLIC_URL: 'https://override.example/' }), 'https://override.example');
  assert.equal(publicURL(3000, {}), null);
});

test('legacy EMA is gradual and resets across image-size changes', () => {
  const original = { Q: [[1, 2], [3, 4], [5, 6], [7, 8]], imageSize };
  const next = { Q: original.Q.map(p => p.map(v => v + 10)), imageSize };
  const smooth = emaFrame(original, next, 0.3);
  assert.equal(smooth.Q[0][0], 4); assert.equal(original.Q[0][0], 1);
  assert.deepEqual(emaFrame(original, { ...next, imageSize: { w: 400, h: 640 } }).Q, next.Q);
});

test('live relay, per-marker median, freeze/recalibrate and viewport updates preserve pairing', async t => {
  let detectorCalls = 0;
  const app = await setup(t, { detector: () => { detectorCalls++; throw new Error('No images in live mode'); } });
  const display = await app.connect('display'), phone = await app.connect('capture');
  const started = await phone.command('start_live'); assert.equal(started.ok, true);
  const revision = started.revision;
  assert.equal((await phone.command('freeze', { revision, lastSeq: 0 })).ok, false);
  for (let seq = 1; seq <= 15; seq++) {
    const ack = await phone.frame(seq, revision, { points: points(seq === 7 ? 20 : 0) });
    assert.equal(ack.ok, true); assert.equal(ack.samples, seq);
  }
  assert.equal((await phone.frame(15, revision)).ok, false); // Duplicate is never relayed.
  const locked = await phone.command('freeze', { revision, lastSeq: 15 }); assert.equal(locked.ok, true);
  const calibration = await display.wait(m => m.type === 'calibrated' && m.source === 'live');
  assert.deepEqual(calibration.Q, points().map(p => [p.x, p.y])); assert.equal(calibration.samples, 15);
  assert.equal(detectorCalls, 0); assert.equal(app.store.get(app.id).photo, null);
  const second = await display.command('start_live'); assert.ok(second.revision > revision);
  assert.equal((await phone.frame(16, revision)).ok, false);
  assert.equal((await phone.frame(17, second.revision)).ok, true);
  const nextViewport = { vw: 1280, vh: 720, dpr: 2 };
  const configured = await display.command('configure', { viewport: nextViewport, markers: markerLayout(nextViewport) });
  assert.equal(configured.ok, true);
  const snapshot = await (await fetch(`${app.url}/api/session/${app.id}`)).json();
  assert.deepEqual(snapshot.viewport, nextViewport); assert.equal(snapshot.peers.capture, 1); assert.equal(snapshot.peers.display, 1);
  assert.equal(app.store.sessions.size, 1); assert.equal(app.store.get(app.id).mode, 'live');
});

test('missing markers, resized frames, competing phones and stale freeze cannot corrupt the window', async t => {
  const app = await setup(t), phone = await app.connect('capture'), other = await app.connect('capture'), display = await app.connect('display');
  const { revision } = await phone.command('start_live');
  assert.equal((await display.frame(100, revision)).ok, false);
  assert.equal((await phone.frame(1, revision)).samples, 1);
  assert.equal((await other.frame(1, revision)).ok, false);
  assert.equal((await phone.frame(2, revision, { type: 'live_status', points: [], detected: 0 })).samples, 1);
  assert.equal((await phone.frame(3, revision, { points: points().map(p => ({ ...p, x: -1 })) })).ok, false);
  for (let seq = 4; seq < 19; seq++) await phone.frame(seq, revision);
  app.advance(1001);
  assert.equal((await phone.command('freeze', { revision, lastSeq: 18 })).ok, false);
  const changed = await phone.frame(19, revision, { imageSize: { w: 641, h: 400 } }); assert.equal(changed.samples, 1);
  phone.socket.close(); await once(phone.socket, 'close');
  const reconnected = await app.connect('capture');
  assert.equal((await reconnected.frame(1, revision)).samples, 1);
  const active = app.store.get(app.id); app.advance(60 * 60_000); app.store.sweep(); assert.equal(app.store.get(app.id), active);
});

test('a photo still processing when live restarts cannot replace the new live state', async t => {
  let finish;
  const app = await setup(t, { detector: () => new Promise(resolve => { finish = resolve; }) });
  const display = await app.connect('display');
  const form = new FormData(); form.append('photo', new Blob(['placeholder']), 'photo.png');
  const upload = fetch(`${app.url}/api/session/${app.id}/photo`, { method: 'POST', body: form });
  await display.wait(m => m.type === 'photo_received');
  const started = await display.command('start_live'); assert.equal(started.ok, true);
  finish({ ok: true, points: points(), imageSize, preview: Buffer.from('preview') });
  const response = await upload; assert.equal(response.status, 409);
  const session = app.store.get(app.id); assert.equal(session.mode, 'live'); assert.equal(session.result, null);
  assert.equal(display.messages.some(m => m.type === 'detect_failed'), false);
});

test('a slower remote link can still freeze 15 continuous fresh samples', async t => {
  const app = await setup(t), phone = await app.connect('capture');
  const { revision } = await phone.command('start_live');
  for (let seq = 1; seq <= 15; seq++) {
    app.advance(400); // 480ms per acknowledged frame, instead of LAN latency.
    const ack = await phone.frame(seq, revision); assert.equal(ack.samples, seq);
  }
  assert.equal((await phone.command('freeze', { revision, lastSeq: 15 })).ok, true);
});

test('partial frames assemble all IDs, update the latest quad, survive empty frames and freeze without 15 full frames', async t => {
  const app = await setup(t), phone = await app.connect('capture'), display = await app.connect('display');
  const { revision } = await phone.command('start_live');
  for (let i = 0; i < 4; i++) {
    app.advance(3000);
    const ack = await phone.frame(i + 1, revision, { points: [points()[i]] });
    assert.equal(ack.tracked, i + 1); assert.equal(ack.ready, i === 3);
  }
  const first = await display.wait(m => m.type === 'live_points' && m.seq === 4);
  assert.equal(first.detected, 1); assert.equal(first.tracked, 4); assert.deepEqual(first.Q, points().map(p => [p.x, p.y]));
  const changed = await phone.frame(5, revision, { points: [points(20)[0]] }); assert.equal(changed.ready, true);
  const second = await display.wait(m => m.type === 'live_points' && m.seq === 5);
  assert.equal(second.Q[0][0], 72); assert.equal(second.Q[1][0], 588); assert.deepEqual(second.updatedIds, [17]);
  app.advance(5000);
  const empty = await phone.frame(6, revision, { type: 'live_status', points: [] });
  assert.equal(empty.tracked, 4); assert.equal(empty.ready, true); assert.equal(empty.lastSeq, 5);
  assert.equal(empty.sampleCounts[17], 2); assert.equal(empty.sampleCounts[42], 1);
  const locked = await phone.command('freeze', { revision, lastSeq: 5 }); assert.equal(locked.ok, true);
  assert.equal(app.store.get(app.id).result.Q[0][0], 62); // Median of two actual observations, not repeated cached frames.
  assert.equal(app.store.get(app.id).result.samples, 1);
});
