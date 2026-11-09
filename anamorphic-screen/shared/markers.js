import { MARKER_IDS } from './calibration.js';

export function markerPoints(found, imageSize, detectedSize = imageSize) {
  return MARKER_IDS.flatMap(id => {
    const candidates = found.filter(m => m.id === id);
    if (candidates.length !== 1) return [];
    const [a, b, c, d] = candidates[0].corners;
    const dx = c.x - a.x, dy = c.y - a.y, ex = d.x - b.x, ey = d.y - b.y;
    const cross = dx * ey - dy * ex;
    if (Math.abs(cross) < 1e-8) return [];
    // Intersection of diagonals is the projective image of the marker centre.
    const t = ((b.x - a.x) * ey - (b.y - a.y) * ex) / cross;
    const sx = imageSize.w / detectedSize.w, sy = imageSize.h / detectedSize.h;
    return [{ id, x: (a.x + t * dx) * sx, y: (a.y + t * dy) * sy,
      corners: [a, b, c, d].map(p => ({ x: p.x * sx, y: p.y * sy })) }];
  });
}
