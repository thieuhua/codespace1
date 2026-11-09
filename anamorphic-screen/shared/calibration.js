import { homography, apply, matrix3d } from './homography.js';
import { fitRect, isConvex, signedArea } from './fitRect.js';

export const MARKER_IDS = [17, 42, 73, 99]; // ARUCO: 5×5 payload, 7×7 including black border.
export const DICTIONARY = 'ARUCO';

export function markerLayout({ vw, vh }) {
  return [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]]
    .map(([x, y], i) => ({ id: MARKER_IDS[i], x: x * vw, y: y * vh }));
}

export function validatePoints(points, imageSize) {
  if (!Array.isArray(points) || points.length !== 4 || points.some(p => !p || !MARKER_IDS.includes(p.id)) ||
      new Set(points.map(p => p.id)).size !== 4) throw new Error('Cần đủ 4 ID marker khác nhau.');
  if (!imageSize || !Number.isFinite(imageSize.w) || !Number.isFinite(imageSize.h) || imageSize.w < 32 || imageSize.h < 32) {
    throw new Error('Kích thước ảnh không hợp lệ.');
  }
  const ordered = MARKER_IDS.map(id => points.find(p => p.id === id));
  if (ordered.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= imageSize.w || p.y >= imageSize.h)) {
    throw new Error('Điểm marker phải nằm trong ảnh.');
  }
  const Q = ordered.map(p => [p.x, p.y]);
  if (!isConvex(Q) || signedArea(Q) <= 0) throw new Error('Chạm đúng thứ tự 1 → 2 → 3 → 4 theo các nhãn trên màn hình.');
  if (signedArea(Q) < imageSize.w * imageSize.h * 0.002 || Q.some((p, i) => Math.hypot(p[0] - Q[(i + 1) % 4][0], p[1] - Q[(i + 1) % 4][1]) < 8)) {
    throw new Error('Các marker quá gần nhau. Hãy chụp màn hình rõ và lớn hơn.');
  }
  return Q;
}

function perspective(photo, viewport, P = markerLayout(viewport)) {
  if (![viewport?.vw, viewport?.vh, viewport?.dpr].every(v => Number.isFinite(v) && v > 0)) throw new Error('Viewport không hợp lệ.');
  const screen = P.map(p => Array.isArray(p) ? p : [p.x, p.y]);
  const H = homography(screen, photo);
  const corners = [[0, 0], [viewport.vw, 0], [viewport.vw, viewport.vh], [0, viewport.vh]];
  const denominators = corners.map(([x, y]) => H[6] * x + H[7] * y + H[8]);
  if (denominators.some(w => !Number.isFinite(w) || Math.abs(w) < 1e-8) || !denominators.every(w => Math.sign(w) === Math.sign(denominators[0]))) {
    throw new Error('Phối cảnh quá nghiêng: đường chân trời cắt qua màn hình. Hãy chụp lại.');
  }
  return { screen, H, V: corners.map(p => apply(H, p)) };
}

export function validateCalibration(points, imageSize, viewport, P) {
  const Q = validatePoints(points, imageSize);
  if (viewport) perspective(Q, viewport, P);
  return Q;
}

// Singular values of the local content → screen Jacobian, in screen px/content px.
export function jacobianScales(G, point) {
  const [u, v] = apply(G, point), [x, y] = point, w = G[6] * x + G[7] * y + G[8];
  const a = (G[0] - u * G[6]) / w, b = (G[1] - u * G[7]) / w;
  const c = (G[3] - v * G[6]) / w, d = (G[4] - v * G[7]) / w;
  const sum = a * a + b * b + c * c + d * d;
  const max = Math.sqrt((sum + Math.hypot(a * a + c * c - b * b - d * d, 2 * (a * b + c * d))) / 2);
  return { min: max ? Math.abs(a * d - b * c) / max : 0, max };
}

export function warpQuality(G, width, height) {
  const scales = [[0, 0], [width, 0], [width, height], [0, height], [width / 2, height / 2]].map(p => jacobianScales(G, p));
  return { compression: Math.min(...scales.map(s => s.max ? s.min / s.max : 0)), minScale: Math.min(...scales.map(s => s.min)) };
}

export function computeWarp({ viewport, P, Q, imageSize, scale = 0.9, offset = { x: 0, y: 0 }, width = 960, height = 600 }) {
  if (!(width >= 100 && width <= 4000 && height >= 100 && height <= 4000) ||
      ![viewport?.vw, viewport?.vh, viewport?.dpr].every(v => Number.isFinite(v) && v > 0)) throw new Error('Kích thước nội dung hoặc viewport không hợp lệ.');
  const photo = validateCalibration(Q.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), imageSize);
  const { screen, H, V } = perspective(photo, viewport, P);
  const R = fitRect(V, width / height, scale, offset);
  const M = homography(photo, screen);
  const S = R.corners.map(p => apply(M, p));
  const G = homography([[0, 0], [width, 0], [width, height], [0, height]], S);
  return { H, M, G, V, R, S, css: matrix3d(G), ...warpQuality(G, width, height) };
}

export function viewportKey({ vw, vh, dpr }) {
  return `${vw}×${vh}×${dpr}`;
}
