// Row-major 3×3 matrices; points are [x, y]. No DOM or Node dependencies.
export function solve8(A, b) {
  if (A.length !== 8 || b.length !== 8 || A.some(row => row.length !== 8)) {
    throw new Error('Cần hệ phương trình 8 × 8.');
  }
  const rows = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) {
      if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    }
    if (!Number.isFinite(rows[pivot][c]) || Math.abs(rows[pivot][c]) < 1e-12) {
      throw new Error('Các điểm suy biến hoặc gần thẳng hàng. Hãy chọn lại marker.');
    }
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const divisor = rows[c][c];
    for (let k = c; k <= 8; k++) rows[c][k] /= divisor;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const factor = rows[r][c];
      for (let k = c; k <= 8; k++) rows[r][k] -= factor * rows[c][k];
    }
  }
  return rows.map(row => row[8]);
}

export function multiply(A, B) {
  return Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3), c = i % 3;
    return A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  });
}

export function invert(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const terms = [a * e * i, b * f * g, c * d * h, -c * e * g, -b * d * i, -a * f * h];
  const det = terms.reduce((s, v) => s + v, 0);
  const magnitude = terms.reduce((s, v) => s + Math.abs(v), 0);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * Math.max(magnitude, 1e-300)) {
    throw new Error('Phép biến đổi suy biến, không thể đảo.');
  }
  return [e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d].map(v => v / det);
}

export function apply(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  const magnitude = Math.abs(H[6] * x) + Math.abs(H[7] * y) + Math.abs(H[8]);
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12 * Math.max(magnitude, 1e-300)) {
    throw new Error('Điểm nằm trên đường chân trời của phép chiếu.');
  }
  const result = [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  if (!result.every(Number.isFinite)) throw new Error('Tọa độ chiếu không hợp lệ.');
  return result;
}

function normalize(points) {
  if (points.length !== 4 || points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
    throw new Error('Cần đúng 4 điểm có tọa độ hữu hạn.');
  }
  const center = [0, 1].map(axis => points.reduce((s, p) => s + p[axis], 0) / 4);
  const distance = points.reduce((s, p) => s + Math.hypot(p[0] - center[0], p[1] - center[1]), 0) / 4;
  if (distance < 1e-12) throw new Error('Các điểm trùng nhau.');
  const scale = Math.SQRT2 / distance;
  const T = [scale, 0, -scale * center[0], 0, scale, -scale * center[1], 0, 0, 1];
  const normalized = points.map(p => apply(T, p));
  // Every triple must span a triangle, including non-neighbouring triples.
  for (let a = 0; a < 2; a++) for (let b = a + 1; b < 3; b++) for (let c = b + 1; c < 4; c++) {
    const u = normalized[a], v = normalized[b], w = normalized[c];
    if (Math.abs((v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])) < 1e-9) {
      throw new Error('Ba marker thẳng hàng hoặc quá gần nhau.');
    }
  }
  return { T, points: normalized };
}

export function homography(source, target) {
  const s = normalize(source), t = normalize(target);
  const A = [], b = [];
  s.points.forEach(([x, y], index) => {
    const [u, v] = t.points[index];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u], [0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(u, v);
  });
  const normalized = [...solve8(A, b), 1];
  invert(normalized); // Reject nearly singular transformations before denormalising.
  const H = multiply(multiply(invert(t.T), normalized), s.T);
  const divisor = Math.abs(H[8]) > 1e-12 ? H[8] : Math.hypot(...H);
  return H.map(v => v / divisor);
}

export function matrix3d(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  return `matrix3d(${[a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, i].join(',')})`;
}
