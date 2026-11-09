import test from 'node:test';
import assert from 'node:assert/strict';
import { TemporalMarkers } from '../shared/temporal-markers.js';
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
