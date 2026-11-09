import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { syntheticPhoto } from './fixtures.js';
import { detectPhoto } from '../server/detect.js';
import { computeWarp, MARKER_IDS } from '../shared/calibration.js';
import { apply } from '../shared/homography.js';

test('raster photo → ArUco detection → compensation: rectangle error below one pixel', async () => {
  const fixture = await syntheticPhoto();
  const result = await detectPhoto(fixture.buffer);
  assert.ok(result.ok, result.reason);
  assert.equal(result.points.length, 4);
  const Q = MARKER_IDS.map(id => { const p = result.points.find(p => p.id === id); return [p.x, p.y]; });
  fixture.P.forEach((p, i) => {
    const truePoint = apply(fixture.H, [p.x, p.y]);
    assert.ok(Math.hypot(Q[i][0] - truePoint[0], Q[i][1] - truePoint[1]) < 1.5);
  });
  const warp = computeWarp({ ...fixture, Q, imageSize: result.imageSize, width: 960, height: 600 });
  const observed = [[0, 0], [960, 0], [960, 600], [0, 600]].map(p => apply(fixture.H, apply(warp.G, p)));
  const error = Math.max(Math.abs(observed[0][1] - observed[1][1]), Math.abs(observed[1][0] - observed[2][0]),
    Math.abs(observed[2][1] - observed[3][1]), Math.abs(observed[3][0] - observed[0][0]));
  assert.ok(error < 1, `Axis alignment error: ${error.toFixed(4)} px`);
});

test('EXIF rotations and mirrors are normalized before detection and preview', async () => {
  const fixture = await syntheticPhoto();
  for (const orientation of [3, 6, 8, 2]) {
    const encoded = await sharp(fixture.buffer).jpeg({ quality: 98 }).withMetadata({ orientation }).toBuffer();
    const result = await detectPhoto(encoded);
    if (orientation === 2) {
      assert.equal(result.ok, false); // Mirrored labels are rejected, never silently inverted.
      assert.match(result.reason, /marker|thứ tự/);
    } else assert.ok(result.ok, `Orientation ${orientation}: ${result.reason}`);
    assert.deepEqual(result.imageSize, orientation === 6 || orientation === 8 ? { w: 1400, h: 2000 } : { w: 2000, h: 1400 });
    const preview = await sharp(result.preview).metadata();
    assert.equal(preview.orientation, undefined);
    assert.equal(preview.width, result.imageSize.w);
    assert.equal(preview.height, result.imageSize.h);
  }
});

test('downscaled detection returns original oriented image coordinates', async () => {
  const fixture = await syntheticPhoto();
  const large = await sharp(fixture.buffer).resize(3200, 2240).jpeg({ quality: 96 }).toBuffer();
  const result = await detectPhoto(large);
  assert.ok(result.ok, result.reason);
  assert.deepEqual(result.imageSize, { w: 3200, h: 2240 });
  for (const p of result.points) {
    const marker = fixture.P.find(m => m.id === p.id), expected = apply(fixture.H, [marker.x, marker.y]).map(v => v * 1.6);
    assert.ok(Math.hypot(p.x - expected[0], p.y - expected[1]) < 3);
  }
  const preview = await sharp(result.preview).metadata();
  assert.equal(preview.width, 2000); assert.equal(preview.height, 1400);
});

test('missing markers retains a normalized preview for manual fallback', async () => {
  const fixture = await syntheticPhoto({ blank: true });
  const result = await detectPhoto(fixture.buffer);
  assert.equal(result.ok, false); assert.equal(result.points.length, 0);
  assert.match(result.reason, /0\/4/); assert.ok(result.preview.length);
  await assert.rejects(detectPhoto(Buffer.from('this is not an image')));
});
