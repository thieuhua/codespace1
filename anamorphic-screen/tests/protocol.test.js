import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, peers, snapshot } from '../server/protocol.js';
import { SessionStore } from '../server/sessions.js';
import { MARKER_IDS, markerLayout, markerCorners } from '../shared/calibration.js';
import { apply, homography } from '../shared/homography.js';
import { PHOTO_UPLOAD_MS, PHOTO_JOB_MS, PHOTO_WAITING } from '../shared/photo.js';

const viewport = { vw: 1440, vh: 900, dpr: 1 }, imageSize = { w: 640, h: 400 };
const points = MARKER_IDS.map((id, i) => ({ id, x: [52, 588, 588, 52][i], y: [32, 32, 368, 368][i] }));
const screenToPhoto = homography(markerLayout(viewport).map(p => [p.x, p.y]), points.map(p => [p.x, p.y]));
const cornerPoints = points.map(p => ({ ...p, corners: markerCorners(viewport).find(m => m.id === p.id).corners.map(c => {
  const [x, y] = apply(screenToPhoto, [c.x, c.y]); return { x, y };
}) }));
function setup(markerMaxAgeMs) {
  let time = 0, seq = 0;
  const session = new SessionStore().create({ viewport, markers: markerLayout(viewport) });
  const socket = role => ({ role, readyState: 1, messages: [], send(value) { this.messages.push(JSON.parse(value)); } });
  const phone = socket('capture'), display = socket('display');
  session.clients.add(phone); session.clients.add(display);
  const broadcast = (_session, type, payload) => { for (const ws of session.clients) ws.send(JSON.stringify({ type, ...payload })); };
  const send = (data, ws = phone) => {
    handleMessage(session, ws, data, { broadcast, now: () => time, markerMaxAgeMs });
    return ws.messages.at(-1);
  };
  send({ type: 'start_live' });
  return { session, phone, display, send, advance(ms) { time += ms; },
    frame(observations = points, extra = {}) { return send({ type: observations.length ? 'live_points' : 'live_status', seq: ++seq,
      revision: session.revision, imageSize, points: observations, fps: 12.5, ...extra }); },
    freeze() { return send({ type: 'freeze', revision: session.revision, lastSeq: session.lastFrame?.seq }); } };
}

test('empty packets after 60 seconds cannot revive the four stale IDs', () => {
  const app = setup(); app.frame(); app.advance(60_000);
  const ack = app.frame([]);
  assert.equal(ack.ok, true); assert.equal(ack.ready, false); assert.equal(ack.tracked, 4);
  assert.equal(ack.markerStats[17].ageMs, 60_000); assert.equal(ack.sampleCounts[17], 1);
  const freeze = app.freeze(); assert.equal(freeze.ok, false);
  for (const id of MARKER_IDS) assert.match(freeze.reason, new RegExp(String(id)));
  assert.equal(app.session.result, null);
  app.frame([points[0]]);
  const partial = app.freeze(); assert.equal(partial.ok, false); assert.match(partial.reason, /42, 73, 99/);
});

test('freeze recalculates ages without needing an empty frame; configured boundary is inclusive', () => {
  const app = setup(200); app.frame(); app.advance(201);
  assert.equal(app.freeze().ok, false);
  const fresh = setup(200); fresh.frame(); fresh.advance(200);
  assert.equal(fresh.freeze().ok, true);
});

test('partial frames have server sample counts, spread and the exact median later frozen', () => {
  const app = setup();
  for (const p of points) { app.advance(100); app.frame([p]); }
  app.advance(100);
  const ack = app.frame([{ ...points[0], x: 54 }]);
  assert.equal(ack.ready, true); assert.equal(ack.stable, false);
  assert.equal(ack.freezeQ[0][0], 53); assert.equal(ack.sampleCounts[17], 2); assert.equal(ack.sampleCounts[42], 1);
  assert.equal(ack.markerStats[17].jitter, 2); assert.equal(ack.markerStats[42].ageMs, 300);
  const live = app.display.messages.findLast(m => m.type === 'live_points');
  assert.deepEqual(live.freezeQ, ack.freezeQ); assert.deepEqual(live.markerStats, ack.markerStats);
  const rejected = app.frame([{ ...points[0], x: -1 }]);
  assert.equal(rejected.ok, false); assert.deepEqual(rejected.freezeQ, ack.freezeQ);
  assert.equal(rejected.sampleCounts[17], 2);
  assert.equal(app.freeze().ok, true); assert.deepEqual(app.session.result.Q, ack.freezeQ);
});

test('live and freeze use the same horizon validator; optional viewport permits legacy geometry-only sessions', () => {
  const app = setup(), H = [0.02, 0, 0, 0, 0.02, 0, -1 / 1400, 0, 1];
  const horizon = markerLayout(viewport).map(p => { const [x, y] = apply(H, [p.x, p.y]); return { id: p.id, x, y }; });
  const ack = app.frame(horizon);
  assert.equal(ack.ready, false); assert.match(ack.warning, /chân trời/);
  assert.equal(app.session.lastFrame, null); assert.match(app.freeze().reason, /chân trời/);
  app.session.viewport = null;
  assert.equal(app.frame(horizon).ready, true); assert.equal(app.freeze().ok, true);
});

test('a valid latest frame renders immediately even while its historical median has an invalid horizon', () => {
  const app = setup(), H = [0.02, 0, 0, 0, 0.02, 0, -1 / 1400, 0, 1];
  const horizon = markerLayout(viewport).map(p => { const [x, y] = apply(H, [p.x, p.y]); return { id: p.id, x, y }; });
  app.frame(horizon); app.frame(horizon);
  const ack = app.frame(points);
  assert.equal(ack.ok, true); assert.equal(ack.ready, false); assert.match(ack.warning, /chân trời/);
  assert.deepEqual(app.session.lastFrame.Q, points.map(p => [p.x, p.y]));
  assert.equal(app.display.messages.findLast(m => m.type === 'live_points').ready, false);
});

test('display application acknowledgements are relayed, protected from old results, and recover via snapshot', () => {
  const app = setup(); app.frame(); assert.equal(app.freeze().ok, true);
  const result = app.session.result;
  const applied = { type: 'display_applied', revision: result.revision, calibrationId: result.calibrationId, ok: false, reason: 'Phối cảnh bị từ chối.' };
  assert.equal(app.send(applied).ok, false);
  assert.equal(app.send({ ...applied, revision: result.revision - 1 }, app.display).ok, false);
  assert.equal(app.send(applied, app.display).ok, true);
  assert.equal(app.phone.messages.findLast(m => m.type === 'display_applied').reason, applied.reason);
  assert.equal(snapshot(app.session).displayApplied.ok, false);
  app.send({ type: 'sync' });
  assert.equal(app.phone.messages.findLast(m => m.type === 'snapshot').displayApplied.reason, applied.reason);
  app.send({ type: 'start_live' }); app.frame(); app.freeze();
  assert.equal(app.send(applied, app.display).ok, false);
  assert.equal(app.session.displayApplied, null);
});

test('pairing distinguishes phone connection from streaming and snapshots include late photo results', () => {
  const app = setup(); assert.equal(peers(app.session).capture, 1); assert.equal(peers(app.session).streaming, false);
  app.frame(); assert.equal(peers(app.session).streaming, true);
  app.send({ type: 'pause' }); assert.equal(peers(app.session).streaming, false);
  app.session.photo = { id: 'late', imageSize, points: points.slice(0, 3), ok: false, reason: 'Thiếu một marker', preview: Buffer.from('preview') };
  app.send({ type: 'sync' });
  const photo = app.phone.messages.findLast(m => m.type === 'snapshot').photo;
  assert.equal(photo.points.length, 3); assert.equal(photo.preview, undefined); assert.match(photo.previewUrl, /photoId=late$/);
  assert.ok(PHOTO_UPLOAD_MS > (PHOTO_WAITING + 1) * PHOTO_JOB_MS);
});

test('partial corner observations survive relay, per-corner median freeze, snapshot and legacy fallback', () => {
  const app = setup(); let ack;
  for (const delta of [-1, 1, 0]) for (const point of cornerPoints) {
    app.advance(20);
    ack = app.frame([{ ...point, x: point.x + delta, y: point.y + delta,
      corners: point.corners.map(c => ({ x: c.x + delta, y: c.y + delta })) }], { detectionMs: 7.25 });
  }
  assert.equal(ack.ok, true); assert.equal(ack.stable, true); assert.equal(ack.ready, true);
  assert.equal(ack.detectionMs, 7.25); assert.ok(ack.freezeReprojectionError < 1e-6);
  assert.deepEqual(ack.freezePoints, cornerPoints); assert.deepEqual(ack.freezeQ, points.map(p => [p.x, p.y]));
  const live = app.display.messages.findLast(m => m.type === 'live_points');
  assert.deepEqual(live.points, cornerPoints); assert.equal(live.correspondenceCount, 16);
  assert.equal(app.freeze().ok, true);
  assert.deepEqual(app.session.result.points, ack.freezePoints);
  assert.ok(app.session.result.reprojectionError < 1e-6);
  assert.deepEqual(snapshot(app.session).result.points, ack.freezePoints);
  app.send({ type: 'start_live' });
  const legacy = app.frame(points);
  assert.equal(legacy.reprojectionError, null); assert.equal(legacy.correspondenceCount, 4);
  assert.equal(app.freeze().ok, true);
});

test('large corner residual blocks readiness/freeze; a whole-marker outlier is rejected as one group', () => {
  const app = setup();
  const inconsistent = cornerPoints.map(p => ({ ...p, corners: p.corners.map((c, i) => ({ ...c, x: c.x + (i === 0 ? 12 : 0) })) }));
  const ack = app.frame(inconsistent);
  assert.equal(ack.ok, true); assert.equal(ack.ready, false); assert.equal(ack.stable, false);
  assert.ok(ack.reprojectionError > 2); assert.match(ack.warning, /Sai số.*px/);
  assert.equal(app.freeze().ok, false);
  app.send({ type: 'start_live' });
  const outlier = structuredClone(cornerPoints);
  outlier[0].x += 20; outlier[0].y += 12;
  outlier[0].corners.forEach(c => { c.x += 20; c.y += 12; });
  const recovered = app.frame(outlier);
  assert.equal(recovered.ready, true); assert.deepEqual(recovered.rejectedIds, [17]);
  assert.equal(recovered.correspondenceCount, 12); assert.ok(recovered.reprojectionError < 1e-6);
  assert.equal(app.freeze().ok, true); assert.deepEqual(app.session.result.rejectedIds, [17]);
});
