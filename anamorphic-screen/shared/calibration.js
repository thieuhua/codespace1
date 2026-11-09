import { homography, apply, invert, matrix3d, robustMarkerHomography } from './homography.js';
import { fitRect, isConvex, signedArea } from './fitRect.js';

export const MARKER_IDS = [17, 42, 73, 99]; // ARUCO: 5×5 payload, 7×7 including black border.
export const DICTIONARY = 'ARUCO';
export const REPROJECTION_LIMIT_PX = 2;

// SVG viewBox 0..9: quiet zone 0..1 / 8..9, black border 1..8.
export function markerBlackSide({ vw, vh }) { return Math.min(vw, vh) * 0.12; }
export function markerCorners(viewport, P = markerLayout(viewport)) {
  const half = markerBlackSide(viewport) / 2;
  return P.map((p, i) => ({ id: p.id ?? MARKER_IDS[i], corners: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
    ({ x: (Array.isArray(p) ? p[0] : p.x) + x * half, y: (Array.isArray(p) ? p[1] : p.y) + y * half })) }));
}

export function validateMarkerCorners(corners, imageSize) {
  if (corners === undefined) return;
  if (!Array.isArray(corners) || corners.length !== 4 || corners.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      p.x < 0 || p.y < 0 || p.x >= imageSize.w || p.y >= imageSize.h) ||
      !isConvex(corners.map(p => [p.x, p.y])) || signedArea(corners.map(p => [p.x, p.y])) <= 0) throw new Error('Bốn góc biên đen marker không hợp lệ.');
}

export function reprojectionAcceptable(error) { return error == null || (Number.isFinite(error) && error <= REPROJECTION_LIMIT_PX); }
export function reprojectionWarning(fit) {
  if (!reprojectionAcceptable(fit.reprojectionError)) return `Sai số chiếu lại ${fit.reprojectionError.toFixed(2)} px vượt ${REPROJECTION_LIMIT_PX} px. Giữ camera cố định, lấy nét và quan sát lại marker.`;
  return fit.rejectedIds?.length ? `Đã loại góc ngoại lai của marker ID ${fit.rejectedIds.join(', ')}.` : '';
}

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

function perspective(photo, viewport, P = markerLayout(viewport), fittedH) {
  if (![viewport?.vw, viewport?.vh, viewport?.dpr].every(v => Number.isFinite(v) && v > 0)) throw new Error('Viewport không hợp lệ.');
  const screen = P.map(p => Array.isArray(p) ? p : [p.x, p.y]);
  const H = fittedH || homography(screen, photo);
  const corners = [[0, 0], [viewport.vw, 0], [viewport.vw, viewport.vh], [0, viewport.vh]];
  const denominators = corners.map(([x, y]) => H[6] * x + H[7] * y + H[8]);
  if (denominators.some(w => !Number.isFinite(w) || Math.abs(w) < 1e-8) || !denominators.every(w => Math.sign(w) === Math.sign(denominators[0]))) {
    throw new Error('Phối cảnh quá nghiêng: đường chân trời cắt qua màn hình. Hãy chụp lại.');
  }
  return { screen, H, V: corners.map(p => apply(H, p)) };
}

export function validateCalibration(points, imageSize, viewport, P) {
  const Q = validatePoints(points, imageSize);
  points.forEach(p => validateMarkerCorners(p.corners, imageSize));
  if (viewport) perspective(Q, viewport, P);
  return Q;
}

export function fitCalibration(points, imageSize, viewport, P) {
  const Q = validateCalibration(points, imageSize, viewport, P);
  if (!viewport) return { Q, reprojectionError: null, correspondenceCount: 4, rejectedIds: [] };
  const layout = P || markerLayout(viewport), black = markerCorners(viewport, layout);
  const groups = points.filter(p => p.corners).map(p => ({ id: p.id, photo: p.corners.map(c => [c.x, c.y]),
    screen: black.find(m => m.id === p.id).corners.map(c => [c.x, c.y]) }));
  // Manual/legacy centres must still influence the fit when any corner set is
  // missing. Only a complete corner observation replaces the four-centre fit.
  const fit = groups.length === 4 ? robustMarkerHomography(groups, REPROJECTION_LIMIT_PX) : {
    M: homography(Q, layout.map(p => Array.isArray(p) ? p : [p.x, p.y])), reprojectionError: null,
    correspondenceCount: 4, inlierIds: MARKER_IDS, rejectedIds: []
  };
  fit.H ||= invert(fit.M);
  const projected = perspective(Q, viewport, layout, fit.H);
  const roll = Math.atan2(projected.V[1][1] - projected.V[0][1], projected.V[1][0] - projected.V[0][0]) * 180 / Math.PI;
  return { ...fit, Q, V: projected.V, roll };
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

export function computeWarp({ viewport, P, Q, points, imageSize, scale = 0.9, offset = { x: 0, y: 0 }, width = 960, height = 600, optimizeCenter = false, alignScreen = false }) {
  if (!(width >= 100 && width <= 4000 && height >= 100 && height <= 4000) ||
      ![viewport?.vw, viewport?.vh, viewport?.dpr].every(v => Number.isFinite(v) && v > 0)) throw new Error('Kích thước nội dung hoặc viewport không hợp lệ.');
  const fit = fitCalibration(Q.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y, corners: points?.find(p => p.id === MARKER_IDS[i])?.corners })), imageSize, viewport, P);
  const { H, M, V } = fit;
  const angle = Math.atan2(V[1][1] - V[0][1], V[1][0] - V[0][0]);
  const R = fitRect(V, width / height, scale, offset, { optimizeCenter, angle: alignScreen ? angle : 0 });
  const S = R.corners.map(p => apply(M, p));
  const G = homography([[0, 0], [width, 0], [width, height], [0, height]], S);
  return { ...fit, G, R, S, css: matrix3d(G), ...warpQuality(G, width, height) };
}

export function viewportKey({ vw, vh, dpr }) {
  return `${vw}×${vh}×${dpr}`;
}
