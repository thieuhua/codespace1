import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticCornerImage } from './fixtures.js';
import { refineCorners } from '../shared/subpix.js';
import { apply, homography, invert, leastSquaresHomography } from '../shared/homography.js';
import { markerLayout, markerCorners, fitCalibration, computeWarp, validateCalibration, reprojectionAcceptable } from '../shared/calibration.js';
import { contains, fitRect } from '../shared/fitRect.js';

const viewport = { vw: 1440, vh: 900, dpr: 1 }, P = markerLayout(viewport), imageSize = { w: 2000, h: 1400 };
const H = homography([[0, 0], [1440, 0], [1440, 900], [0, 900]], [[230, 180], [1740, 380], [1680, 1090], [170, 1240]]);
const black = markerCorners(viewport);
const exact = P.map(p => {
  const [x, y] = apply(H, [p.x, p.y]);
  return { ...p, x, y, corners: black.find(m => m.id === p.id).corners.map(c => { const [x, y] = apply(H, [c.x, c.y]); return { x, y }; }) };
});
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('subpixel gradients reduce corner error on blurred, rotated raster corners', async t => {
  let before = 0, after = 0, count = 0;
  for (const angle of [0, 0.14, -0.31, 0.58]) {
    const image = await syntheticCornerImage(angle);
    const initial = image.corners.map((p, i) => ({ x: Math.round(p.x) + (i % 2 ? 1 : -1), y: Math.round(p.y) + (i < 2 ? 1 : -1) }));
    const refined = refineCorners(image.gray, image.width, image.height, initial);
    image.corners.forEach((p, i) => {
      before += distance([p.x, p.y], [initial[i].x, initial[i].y]) ** 2;
      after += distance([p.x, p.y], [refined[i].x, refined[i].y]) ** 2; count++;
    });
  }
  const raw = Math.sqrt(before / count), refined = Math.sqrt(after / count);
  t.diagnostic(`Góc tổng hợp: RMS ${raw.toFixed(3)} → ${refined.toFixed(3)} px (${(100 * (1 - refined / raw)).toFixed(1)}% giảm).`);
  assert.ok(refined < raw * 0.3); assert.ok(refined < 0.25);
  const flat = new Float32Array(40 * 40).fill(100), corners = [{ x: 20, y: 20 }, { x: 1, y: 1 }];
  assert.deepEqual(refineCorners(flat, 40, 40, corners), corners);
});

test('16-point normalised DLT beats four centres under seeded point noise', t => {
  let seed = 97531;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
  const noise = () => 0.6 * Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  let centerError = 0, cornerError = 0, count = 0;
  const probes = Array.from({ length: 35 }, (_, i) => [120 + i % 7 * 190, 100 + Math.floor(i / 7) * 170]);
  for (let trial = 0; trial < 80; trial++) {
    // Each measured point has the same 0.6px Gaussian noise; centres remain
    // independent measurements here, not an average of the four corners.
    const points = exact.map(p => ({ ...p, x: p.x + noise(), y: p.y + noise(), corners: p.corners.map(c => ({ x: c.x + noise(), y: c.y + noise() })) }));
    const centersH = homography(P.map(p => [p.x, p.y]), points.map(p => [p.x, p.y]));
    const M = leastSquaresHomography(points.flatMap(p => p.corners.map(c => [c.x, c.y])), black.flatMap(p => p.corners.map(c => [c.x, c.y])));
    const cornersH = invert(M);
    for (const p of probes) {
      centerError += distance(apply(centersH, p), apply(H, p)) ** 2;
      cornerError += distance(apply(cornersH, p), apply(H, p)) ** 2; count++;
    }
  }
  const centers = Math.sqrt(centerError / count), corners = Math.sqrt(cornerError / count);
  t.diagnostic(`Chiếu lưới: RMS ${centers.toFixed(3)} px (4 tâm) → ${corners.toFixed(3)} px (16 góc), giảm ${(100 * (1 - corners / centers)).toFixed(1)}%.`);
  assert.ok(corners < centers * 0.7);
});

test('marker-level rejection recovers all viewport corners after a whole marker shifts', () => {
  const points = structuredClone(exact);
  points[0].corners.forEach(c => { c.x += 42; c.y -= 25; });
  const fit = fitCalibration(points, imageSize, viewport);
  assert.deepEqual(fit.rejectedIds, [17]); assert.equal(fit.correspondenceCount, 12);
  assert.ok(fit.reprojectionError < 1e-6);
  for (const p of [[0, 0], [1440, 0], [1440, 900], [0, 900], [720, 450]]) assert.ok(distance(apply(H, p), apply(fit.H, p)) < 1e-6);
  const fallback = fitCalibration(exact.map(({ corners, ...p }) => p), imageSize, viewport);
  assert.equal(fallback.correspondenceCount, 4); assert.equal(fallback.reprojectionError, null);
  const mixed = structuredClone(exact); delete mixed[1].corners;
  assert.equal(fitCalibration(mixed, imageSize, viewport).correspondenceCount, 4);
  assert.equal(reprojectionAcceptable(2.01), false); assert.equal(reprojectionAcceptable(2), true);
  const bad = structuredClone(exact); bad[0].corners[0].x = NaN;
  assert.throws(() => validateCalibration(bad, imageSize, viewport), /biên đen/);
  assert.throws(() => leastSquaresHomography([[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [1, 0], [2, 0], [3, 0]]), /suy biến/);
});

test('black border geometry, corner fit, camera roll and aligned compensation share the same coordinates', () => {
  assert.ok(Math.abs(black[0].corners[1].x - black[0].corners[0].x - 108) < 1e-10);
  assert.equal(black[0].corners[0].x, P[0].x - 54);
  const Q = exact.map(p => [p.x, p.y]);
  const warp = computeWarp({ viewport, Q, points: exact, imageSize, alignScreen: true, optimizeCenter: true });
  assert.equal(warp.correspondenceCount, 16); assert.ok(warp.reprojectionError < 1e-6);
  const angle = Math.atan2(warp.V[1][1] - warp.V[0][1], warp.V[1][0] - warp.V[0][0]);
  assert.ok(Math.abs(warp.roll - angle * 180 / Math.PI) < 1e-9);
  const observed = [[0, 0], [960, 0], [960, 600], [0, 600]].map(p => apply(H, apply(warp.G, p)));
  assert.ok(Math.abs(Math.atan2(observed[1][1] - observed[0][1], observed[1][0] - observed[0][0]) - angle) < 1e-9);
  assert.ok(observed.every(p => contains(warp.V, p)));
});

test('optimising centre maximises fixed-aspect area and all offsets stay inside either winding', t => {
  const quads = [[[0, 0], [1000, 0], [450, 800], [350, 800]], [[0, 0], [1000, 100], [700, 800], [50, 700]], [[0, 0], [1200, 0], [1200, 600], [0, 600]]];
  let gain = 0;
  for (const quad of quads.flatMap(q => [q, [...q].reverse()])) for (const aspect of [0.6, 1, 1.6, 2.4]) for (const scale of [0.9, 1]) {
    const spec = fitRect(quad, aspect, scale), best = fitRect(quad, aspect, scale, { x: 0, y: 0 }, { optimizeCenter: true });
    assert.ok(best.width * best.height >= spec.width * spec.height - 1e-6);
    assert.ok(best.corners.every(p => contains(quad, p)));
    assert.ok(Math.abs(best.width / best.height - aspect) < 1e-9);
    gain = Math.max(gain, best.width * best.height / (spec.width * spec.height) - 1);
    for (const offset of [{ x: 1, y: -1 }, { x: -1, y: 1 }]) {
      const moved = fitRect(quad, aspect, scale, offset, { optimizeCenter: true });
      assert.ok(moved.corners.every(p => contains(quad, p)));
    }
  }
  t.diagnostic(`Diện tích tăng tối đa trong các trường hợp thử: ${(gain * 100).toFixed(1)}%.`);
  assert.ok(gain > 0.1);
  const trapezoid = [[0, 0], [1000, 0], [600, 600], [400, 600]];
  const optimum = fitRect(trapezoid, 1.6, 1, { x: 0, y: 0 }, { optimizeCenter: true });
  assert.ok(Math.abs(optimum.height - 1000 / (1.6 + 4 / 3)) < 1e-6);
});
