import test from 'node:test';
import assert from 'node:assert/strict';
import { homography, apply, invert, multiply, matrix3d, solve8 } from '../shared/homography.js';
import { contains, fitRect, isConvex } from '../shared/fitRect.js';
import { computeWarp, validatePoints, markerLayout, MARKER_IDS } from '../shared/calibration.js';

const source = [[0, 0], [3840, 0], [3840, 2160], [0, 2160]];
const target = [[1460.7, 703.2], [3500.3, 870.6], [3150.9, 2940.2], [650.2, 3210.8]];
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('Hartley-normalized homography recovers pixel coordinates within 1e-6', () => {
  const H = homography(source, target);
  source.forEach((p, i) => apply(H, p).forEach((v, axis) => near(v, target[i][axis])));
  const identity = multiply(H, invert(H));
  identity.forEach((v, i) => near(v, i % 4 === 0 ? 1 : 0));
  [[1023.2, 1987], [3000, 1], [-1, 100]].forEach(p => apply(invert(H), apply(H, p)).forEach((v, i) => near(v, p[i])));
});

test('normalization is stable for large coordinate offsets and small working regions', () => {
  const points = source.map(([x, y]) => [x + 1e7, y - 1e7]);
  const H = homography(points, target);
  points.forEach((p, i) => apply(H, p).forEach((v, axis) => near(v, target[i][axis], 1e-5)));
});

test('rejects coincident points, every collinear triple, nonfinite and singular matrices', () => {
  for (const bad of [[[0, 0], [1, 0], [2, 0], [1, 1]], [[0, 0], [1, 0], [1, 1], [0, 0]], [[0, 0], [NaN, 1], [2, 2], [3, 4]]]) {
    assert.throws(() => homography(bad, target));
  }
  assert.throws(() => invert([1, 2, 3, 2, 4, 6, 0, 0, 1]));
  assert.throws(() => apply([1, 0, 0, 0, 1, 0, 1, 0, -1], [1, 0]));
  assert.throws(() => solve8([[0]], [0]));
  assert.throws(() => solve8(Array.from({ length: 8 }, () => Array(8).fill(0)), Array(8).fill(0)));
});

test('matrix3d uses CSS column order and reproduces the homography', () => {
  const H = homography(source, target);
  const css = matrix3d(H).slice(9, -1).split(',').map(Number);
  for (const [x, y] of source) {
    const w = css[3] * x + css[7] * y + css[15];
    const actual = [(css[0] * x + css[4] * y + css[12]) / w, (css[1] * x + css[5] * y + css[13]) / w];
    actual.forEach((v, i) => near(v, apply(H, [x, y])[i]));
  }
});

test('fitRect preserves aspect, maximizes at centroid and safely clamps all offsets', () => {
  const quad = [[0, 0], [1000, 100], [700, 800], [50, 700]];
  for (const polygon of [quad, [...quad].reverse()]) {
    const rect = fitRect(polygon, 1.6, 1);
    near(rect.width / rect.height, 1.6);
    assert.ok(rect.corners.every(p => contains(polygon, p)));
    assert.ok(!fitRect(polygon, 1.6).corners.some(p => !contains(polygon, p)));
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) assert.ok(fitRect(polygon, 1.6, 0.9, { x, y }).corners.every(p => contains(polygon, p)));
    const grown = rect.corners.map(p => p.map((v, i) => rect.center[i] + (v - rect.center[i]) * 1.0001));
    assert.ok(grown.some(p => !contains(polygon, p)));
  }
  assert.ok(!isConvex([[0, 0], [1, 1], [1, 0], [0, 1]]));
  assert.throws(() => fitRect(quad, 0)); assert.throws(() => fitRect(quad, 1, 1.1));
});

test('marker validation rejects swapped labels, duplicates, out-of-image and tiny regions', () => {
  const size = { w: 1000, h: 1000 };
  const points = MARKER_IDS.map((id, i) => ({ id, x: [100, 900, 900, 100][i], y: [100, 100, 900, 900][i] }));
  assert.equal(validatePoints(points.reverse(), size).length, 4); // ID order, not submission order.
  assert.throws(() => validatePoints(points.map(p => ({ ...p, id: 17 })), size));
  assert.throws(() => validatePoints(points.map(p => ({ ...p, x: -1 })), size));
  assert.throws(() => validatePoints(points.map(p => ({ ...p, x: p.x / 100, y: p.y / 100 })), size));
  const reversed = [...points].reverse().map((p, i) => ({ ...p, id: MARKER_IDS[(4 - i) % 4] }));
  assert.throws(() => validatePoints(reversed, size));
});

test('complete exact point pipeline projects compensated content to an axis-aligned rectangle', () => {
  const viewport = { vw: 1920, vh: 1080, dpr: 2 }, P = markerLayout(viewport);
  const H = homography([[0, 0], [1920, 0], [1920, 1080], [0, 1080]], target);
  const Q = P.map(p => apply(H, [p.x, p.y]));
  for (const offset of [{ x: 0, y: 0 }, { x: 1, y: -1 }]) {
    const warp = computeWarp({ viewport, P, Q, imageSize: { w: 4000, h: 4000 }, width: 960, height: 600, offset });
    const observed = [[0, 0], [960, 0], [960, 600], [0, 600]].map(p => apply(H, apply(warp.G, p)));
    observed.forEach((p, i) => p.forEach((v, axis) => near(v, warp.R.corners[i][axis])));
    near(observed[0][1], observed[1][1]); near(observed[1][0], observed[2][0]);
    assert.ok(warp.S.every(p => contains([[0, 0], [1920, 0], [1920, 1080], [0, 1080]], p)));
  }
});
