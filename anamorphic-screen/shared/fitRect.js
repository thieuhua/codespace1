export function signedArea(polygon) {
  return polygon.reduce((s, p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    return s + p[0] * q[1] - p[1] * q[0];
  }, 0) / 2;
}

export function isConvex(quad) {
  if (quad.length !== 4 || quad.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return false;
  const turns = quad.map((p, i) => {
    const q = quad[(i + 1) % 4], r = quad[(i + 2) % 4];
    return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
  });
  return turns.every(v => v > 1e-8) || turns.every(v => v < -1e-8);
}

export function contains(polygon, point, epsilon = 1e-7) {
  const sign = Math.sign(signedArea(polygon));
  return polygon.every((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    const cross = (q[0] - p[0]) * (point[1] - p[1]) - (q[1] - p[1]) * (point[0] - p[0]);
    return sign * cross >= -epsilon;
  });
}

export function rectangle([x, y], width, height) {
  return [[x - width / 2, y - height / 2], [x + width / 2, y - height / 2],
    [x + width / 2, y + height / 2], [x - width / 2, y + height / 2]];
}

// Largest rectangle of a given aspect ratio at the vertex centroid (the v1 rule).
// Offset is clamped along its direction so no corner can leave the viewport.
export function fitRect(quad, aspect, scale = 0.9, offset = { x: 0, y: 0 }, { optimizeCenter = false, angle = 0 } = {}) {
  if (!isConvex(quad) || !(aspect > 0) || !Number.isFinite(aspect) || !(scale > 0 && scale <= 1) ||
      !Number.isFinite(offset.x) || !Number.isFinite(offset.y) || !Number.isFinite(angle)) throw new Error('Vùng đích hoặc tỉ lệ không hợp lệ.');
  if (angle) {
    const rotate = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
    const result = fitRect(quad.map(p => rotate(p, -angle)), aspect, scale, offset, { optimizeCenter });
    return { ...result, center: rotate(result.center, angle), corners: result.corners.map(p => rotate(p, angle)) };
  }
  let center = [0, 1].map(axis => quad.reduce((s, p) => s + p[axis], 0) / 4);
  const widths = [0, 1].map(axis => Math.max(...quad.map(p => p[axis])) - Math.min(...quad.map(p => p[axis])));
  const fits = corners => corners.every(p => contains(quad, p));
  let low = 0, high = Math.min(widths[0], widths[1] * aspect);
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) / 2;
    if (fits(rectangle(center, mid, mid / aspect))) low = mid; else high = mid;
  }
  if (optimizeCenter) {
    // Linear program in (cx, cy, half-height). For each inward half-plane,
    // its worst rectangle corner gives a single constraint. An optimum lies
    // at the intersection of three planes, including half-height >= 0.
    const sign = Math.sign(signedArea(quad));
    const planes = quad.map((p, i) => {
      const q = quad[(i + 1) % 4], a = sign * (q[1] - p[1]), b = sign * (p[0] - q[0]);
      const length = Math.hypot(a, b);
      return [a / length, b / length, (Math.abs(a) * aspect + Math.abs(b)) / length, (a * p[0] + b * p[1]) / length];
    });
    planes.push([0, 0, -1, 0]);
    let bestHeight = low / (2 * aspect);
    for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) for (let k = j + 1; k < planes.length; k++) {
      const rows = [planes[i], planes[j], planes[k]].map(row => [...row]);
      let valid = true;
      for (let c = 0; c < 3; c++) {
        let pivot = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
        if (Math.abs(rows[pivot][c]) < 1e-12) { valid = false; break; }
        [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
        const divisor = rows[c][c];
        for (let n = c; n < 4; n++) rows[c][n] /= divisor;
        for (let r = 0; r < 3; r++) if (r !== c) {
          const factor = rows[r][c];
          for (let n = c; n < 4; n++) rows[r][n] -= factor * rows[c][n];
        }
      }
      if (!valid) continue;
      const [x, y, t] = rows.map(row => row[3]);
      if (t > bestHeight && planes.every(([a, b, c, d]) => a * x + b * y + c * t <= d + 1e-8)) {
        bestHeight = t; center = [x, y];
      }
    }
    low = bestHeight * 2 * aspect;
  }
  const width = low * scale * (1 - 1e-10), height = width / aspect;
  const delta = [offset.x * widths[0] / 2, offset.y * widths[1] / 2];
  low = 0; high = 1;
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) / 2;
    const moved = center.map((v, axis) => v + delta[axis] * mid);
    if (fits(rectangle(moved, width, height))) low = mid; else high = mid;
  }
  const fittedCenter = center.map((v, axis) => v + delta[axis] * low);
  return { corners: rectangle(fittedCenter, width, height), center: fittedCenter, width, height, offsetFraction: low };
}
