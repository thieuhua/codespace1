import test from 'node:test';
import assert from 'node:assert/strict';
import { TemporalMarkers, markerStability } from '../shared/temporal-markers.js';
import { MARKER_IDS, validatePoints } from '../shared/calibration.js';

const imageSize = { w: 640, h: 400 };
const points = MARKER_IDS.map((id, i) => ({ id, x: [50, 590, 590, 50][i], y: [30, 30, 370, 370][i] }));

test('four markers can be collected in four separate frames; empty frames preserve all points', () => {
  const tracker = new TemporalMarkers();
  let memory;
  for (let i = 0; i < 4; i++) {
    memory = tracker.update([points[i]], imageSize, 'live-1', i * 5000);
    assert.equal(memory.tracked, i + 1); assert.equal(memory.freezeQ !== null, i === 3);
  }
  assert.deepEqual(memory.points, points); assert.equal(memory.samples, 1);
  for (let i = 0; i < 40; i++) memory = tracker.update([], imageSize, 'live-1', 60_000 + i);
  assert.deepEqual(memory.points, points); assert.equal(memory.samples, 1); assert.deepEqual(memory.updatedIds, []);
});

test('each new observation replaces just its ID in the latest quad; freeze counts only real sightings', () => {
  const tracker = new TemporalMarkers(); tracker.update(points, imageSize, 1);
  let memory = tracker.update([{ ...points[0], x: 70 }], imageSize, 1);
  assert.equal(memory.points[0].x, 70); assert.equal(memory.points[1].x, 590); assert.equal(memory.freezeQ[0][0], 60);
  assert.equal(memory.sampleCounts[17], 2); assert.equal(memory.sampleCounts[42], 1);
  for (let i = 0; i < 30; i++) memory = tracker.update([points[0]], imageSize, 1);
  assert.equal(memory.sampleCounts[17], 15); assert.equal(memory.sampleCounts[42], 1); assert.equal(memory.freezeQ[0][0], 50);
});

test('revision, camera tracking key and image dimensions start a fresh memory', () => {
  const tracker = new TemporalMarkers(); tracker.update(points, imageSize, '1:0');
  assert.equal(tracker.update([points[0]], imageSize, '2:0').tracked, 1);
  tracker.update(points, imageSize, '2:0'); assert.equal(tracker.update([points[1]], imageSize, '2:1').tracked, 1);
  tracker.update(points, imageSize, '2:1'); assert.equal(tracker.update([points[2]], { w: 641, h: 400 }, '2:1').tracked, 1);
});

test('invalid observations leave memory intact; a bad aggregate can recover with later individual updates', () => {
  const tracker = new TemporalMarkers(); tracker.update(points, imageSize, 1);
  assert.throws(() => tracker.update([{ ...points[0], x: -1 }], imageSize, 1));
  assert.throws(() => tracker.update([points[0], points[0]], imageSize, 1));
  assert.deepEqual(tracker.update([], imageSize, 1).points, points);
  const wrong = tracker.update([{ ...points[0], x: 620, y: 380 }], imageSize, 1);
  assert.throws(() => validatePoints(wrong.points, imageSize));
  const recovered = tracker.update([points[0]], imageSize, 1);
  assert.equal(validatePoints(recovered.points, imageSize).length, 4);
});

test('ages come from actual sightings; jitter is the spread of real samples and full does not mean stable', () => {
  const tracker = new TemporalMarkers();
  let memory = tracker.update(points, imageSize, 1, 100);
  assert.equal(memory.fresh, true); assert.equal(memory.stable, false);
  tracker.update(points, imageSize, 1, 200);
  memory = tracker.update(points.map(p => ({ ...p, x: p.x + 1, y: p.y + 2 })), imageSize, 1, 300);
  assert.equal(memory.stable, true);
  assert.equal(memory.markerStats[17].jitter, Math.sqrt(5));
  memory = tracker.update([], imageSize, 1, 3301);
  assert.equal(memory.markerStats[17].ageMs, 3001); assert.equal(memory.markerStats[17].sampleCount, 3);
  assert.equal(memory.fresh, false); assert.equal(memory.stable, false);
  assert.deepEqual(memory.staleIds, MARKER_IDS);
  memory = tracker.update([points[0]], imageSize, 1, 3302);
  assert.equal(memory.sampleCounts[17], 1); // Reacquisition starts a new observation window.
  assert.deepEqual(memory.staleIds, [42, 73, 99]);
  assert.equal(tracker.markers.get(42).seenAt, 300);
});

test('freshness window is configurable and excessive motion blocks the stability hint', () => {
  const tracker = new TemporalMarkers({ maxAgeMs: 50 });
  tracker.update(points, imageSize, 1, 0); tracker.update(points, imageSize, 1, 1);
  const memory = tracker.update(points.map(p => ({ ...p, x: p.x + 5 })), imageSize, 1, 2);
  assert.equal(memory.markerStats[17].jitter, 5); assert.equal(markerStability(memory.markerStats, 50), false);
  assert.equal(tracker.snapshot(52).fresh, true); assert.equal(tracker.snapshot(53).fresh, false);
  assert.throws(() => new TemporalMarkers({ maxAgeMs: 0 }));
});

test('corner jitter contributes to stability; invalid corners are atomic and centre-only updates drop old corners', () => {
  const tracker = new TemporalMarkers();
  const corners = points.map(p => ({ ...p, corners: [[-8, -8], [8, -8], [8, 8], [-8, 8]].map(([x, y]) => ({ x: p.x + x, y: p.y + y })) }));
  tracker.update(corners, imageSize, 1, 0); tracker.update(corners, imageSize, 1, 1);
  const moving = structuredClone(corners); moving[0].corners[0].x += 6;
  const memory = tracker.update(moving, imageSize, 1, 2);
  assert.equal(memory.markerStats[17].jitter, 6); assert.equal(memory.stable, false);
  assert.deepEqual(memory.freezePoints[0].corners, corners[0].corners);
  const invalid = structuredClone(corners); invalid[2].corners[0].x = NaN;
  assert.throws(() => tracker.update(invalid, imageSize, 1, 3));
  assert.deepEqual(tracker.snapshot(3).points, memory.points);
  const legacy = tracker.update(points, imageSize, 1, 4);
  assert.ok(legacy.points.every(p => !p.corners)); assert.ok(legacy.freezePoints.every(p => !p.corners));
  const reacquired = tracker.update(corners, imageSize, 1, 3005);
  assert.equal(reacquired.markerStats[17].cornerSampleCount, 1);
  assert.equal(reacquired.stable, false);
});
