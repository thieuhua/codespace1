// Gradient-line least squares, in pixel-centre coordinates. No DOM/Node APIs.
export function grayscale({ data, width, height }) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) / 256;
  return gray;
}

export function refineCorners(gray, width, height, corners, { radius = 5, iterations = 8, epsilon = 0.01 } = {}) {
  const sample = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, i = iy * width + ix;
    return gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy) +
      gray[i + width] * (1 - fx) * fy + gray[i + width + 1] * fx * fy;
  };
  return corners.map(original => {
    let { x, y } = original;
    for (let iteration = 0; iteration < iterations; iteration++) {
      if (x < radius + 2 || y < radius + 2 || x >= width - radius - 2 || y >= height - radius - 2) return { ...original };
      let a = 0, b = 0, c = 0, u = 0, v = 0;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const px = x + dx, py = y + dy;
        const gx = (sample(px + 1, py) - sample(px - 1, py)) / 2;
        const gy = (sample(px, py + 1) - sample(px, py - 1)) / 2;
        const weight = Math.exp(-(dx * dx + dy * dy) / (radius * radius));
        const xx = weight * gx * gx, xy = weight * gx * gy, yy = weight * gy * gy;
        a += xx; b += xy; c += yy; u += xx * dx + xy * dy; v += xy * dx + yy * dy;
      }
      const det = a * c - b * b;
      if (!Number.isFinite(det) || det <= 1e-6 * (a + c) ** 2 || det < 1e-12) return { ...original };
      const dx = (c * u - b * v) / det, dy = (a * v - b * u) / det;
      x += dx; y += dy;
      if (!Number.isFinite(x + y) || Math.hypot(x - original.x, y - original.y) > radius) return { ...original };
      if (Math.hypot(dx, dy) < epsilon) break;
    }
    return { x, y };
  });
}

export function refineMarkers(image, markers) {
  if (!markers.length) return [];
  const gray = grayscale(image);
  return markers.map(marker => {
    // Keep the window inside the black border on small/coarse markers.
    const edge = Math.min(...marker.corners.map((p, i) => Math.hypot(p.x - marker.corners[(i + 1) % 4].x, p.y - marker.corners[(i + 1) % 4].y)));
    const radius = Math.max(1, Math.min(5, Math.floor(edge / 7 * 0.7)));
    return { ...marker, corners: refineCorners(gray, image.width, image.height, marker.corners, { radius }) };
  });
}
