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

function normalize(points, exact = true) {
  if (points.length < 4 || (exact && points.length !== 4) || points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
    throw new Error('Cần ít nhất 4 điểm có tọa độ hữu hạn.');
  }
  const center = [0, 1].map(axis => points.reduce((s, p) => s + p[axis], 0) / points.length);
  const distance = points.reduce((s, p) => s + Math.hypot(p[0] - center[0], p[1] - center[1]), 0) / points.length;
  if (distance < 1e-12) throw new Error('Các điểm trùng nhau.');
  const scale = Math.SQRT2 / distance;
  const T = [scale, 0, -scale * center[0], 0, scale, -scale * center[1], 0, 0, 1];
  const normalized = points.map(p => apply(T, p));
  // Every triple must span a triangle, including non-neighbouring triples.
  if (exact) for (let a = 0; a < 2; a++) for (let b = a + 1; b < 3; b++) for (let c = b + 1; c < 4; c++) {
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

// Hartley-normalised homogeneous DLT. Jacobi diagonalises the small symmetric
// AᵀA matrix; its least eigenvector avoids fixing h33 near a projective horizon.
export function leastSquaresHomography(source, target) {
  if (source.length !== target.length) throw new Error('Số cặp điểm không khớp.');
  const s = normalize(source, false), t = normalize(target, false);
  const A = Array.from({ length: 9 }, () => Array(9).fill(0));
  s.points.forEach(([x, y], i) => {
    const [u, v] = t.points[i];
    for (const row of [[-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]]) {
      for (let j = 0; j < 9; j++) for (let k = 0; k < 9; k++) A[j][k] += row[j] * row[k];
    }
  });
  const vectors = Array.from({ length: 9 }, (_, i) => Array.from({ length: 9 }, (_, j) => Number(i === j)));
  for (let iteration = 0; iteration < 2000; iteration++) {
    let p = 0, q = 1;
    for (let j = 0; j < 9; j++) for (let k = j + 1; k < 9; k++) if (Math.abs(A[j][k]) > Math.abs(A[p][q])) { p = j; q = k; }
    const magnitude = Math.max(...A.map((row, i) => Math.abs(row[i])));
    if (Math.abs(A[p][q]) <= magnitude * 1e-14) break;
    const angle = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
    const c = Math.cos(angle), sn = Math.sin(angle), pp = A[p][p], qq = A[q][q], pq = A[p][q];
    for (let k = 0; k < 9; k++) {
      if (k !== p && k !== q) {
        const kp = A[k][p], kq = A[k][q];
        A[k][p] = A[p][k] = c * kp - sn * kq;
        A[k][q] = A[q][k] = sn * kp + c * kq;
      }
      const vp = vectors[k][p], vq = vectors[k][q];
      vectors[k][p] = c * vp - sn * vq; vectors[k][q] = sn * vp + c * vq;
    }
    A[p][p] = c * c * pp - 2 * sn * c * pq + sn * sn * qq;
    A[q][q] = sn * sn * pp + 2 * sn * c * pq + c * c * qq;
    A[p][q] = A[q][p] = 0;
  }
  const order = Array.from({ length: 9 }, (_, i) => i).sort((a, b) => A[a][a] - A[b][b]);
  if (A[order[1]][order[1]] < 1e-10 * A[order[8]][order[8]]) throw new Error('Các cặp điểm suy biến hoặc gần thẳng hàng.');
  const normalized = vectors.map(row => row[order[0]]);
  invert(normalized);
  const H = multiply(multiply(invert(t.T), normalized), s.T);
  const divisor = Math.abs(H[8]) > 1e-12 ? H[8] : Math.hypot(...H);
  return H.map(v => v / divisor);
}

// Deterministic marker-level RANSAC: all markers, plus every leave-one-out
// triple. A marker is accepted only when its four-corner RMS is within threshold.
export function robustMarkerHomography(groups, threshold = 2) {
  const fit = selected => leastSquaresHomography(selected.flatMap(g => g.photo), selected.flatMap(g => g.screen));
  const errors = M => {
    const H = invert(M);
    return groups.map(g => Math.sqrt(g.screen.reduce((sum, p, i) => {
      const q = apply(H, p); return sum + (q[0] - g.photo[i][0]) ** 2 + (q[1] - g.photo[i][1]) ** 2;
    }, 0) / 4));
  };
  const candidates = [groups];
  if (groups.length === 4) groups.forEach((_, i) => candidates.push(groups.filter((_, j) => j !== i)));
  let best;
  for (const selected of candidates) {
    try {
      const M = fit(selected), residuals = errors(M), inliers = groups.filter((_, i) => residuals[i] <= threshold);
      const score = residuals.reduce((sum, e) => sum + Math.min(e * e, threshold * threshold), 0);
      if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && score < best.score)) best = { M, inliers, score };
    } catch { /* A degenerate candidate cannot win. */ }
  }
  if (!best) throw new Error('Không tìm được phép chiếu từ góc marker.');
  const selected = best.inliers.length >= 3 ? best.inliers : groups;
  const M = fit(selected), residuals = errors(M);
  const reprojectionError = Math.sqrt(selected.reduce((sum, g) => sum + residuals[groups.indexOf(g)] ** 2, 0) / selected.length);
  return { M, H: invert(M), reprojectionError, correspondenceCount: selected.length * 4,
    inlierIds: selected.map(g => g.id), rejectedIds: groups.filter(g => !selected.includes(g)).map(g => g.id) };
}

export function matrix3d(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  return `matrix3d(${[a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, i].join(',')})`;
}
