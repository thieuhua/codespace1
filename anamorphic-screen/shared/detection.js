import { markerPoints } from './markers.js';
import { refineMarkers } from './subpix.js';

// Coordinates stay in the coarse (<=640px) frame, regardless of ROI resolution.
export function markerROIs(previous, size, detailSize) {
  const sx = detailSize.w / size.w, sy = detailSize.h / size.h;
  return previous.filter(p => p.corners).map(p => {
    const xs = p.corners.map(c => c.x), ys = p.corners.map(c => c.y);
    const pad = Math.max(12, (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)) * 0.4);
    const x = Math.max(0, Math.floor((Math.min(...xs) - pad) * sx)), y = Math.max(0, Math.floor((Math.min(...ys) - pad) * sy));
    const right = Math.min(detailSize.w, Math.ceil((Math.max(...xs) + pad) * sx));
    const bottom = Math.min(detailSize.h, Math.ceil((Math.max(...ys) + pad) * sy));
    return { id: p.id, x, y, width: right - x, height: bottom - y };
  });
}

export function detectMarkers(detector, image, detail, previous = []) {
  const size = { w: image.width, h: image.height };
  const coarse = markerPoints(refineMarkers(image, detector.detect(image)), size);
  const merged = new Map(coarse.map(p => [p.id, p]));
  if (detail && (detail.width > image.width || detail.height > image.height)) {
    const detailSize = { w: detail.width, h: detail.height };
    for (const roi of markerROIs(previous, size, detailSize)) {
      const data = new Uint8ClampedArray(roi.width * roi.height * 4);
      for (let y = 0; y < roi.height; y++) {
        const start = ((roi.y + y) * detail.width + roi.x) * 4;
        data.set(detail.data.subarray(start, start + roi.width * 4), y * roi.width * 4);
      }
      const crop = { data, width: roi.width, height: roi.height };
      const markers = refineMarkers(crop, detector.detect(crop).filter(m => m.id === roi.id));
      markers.forEach(m => { m.corners = m.corners.map(c => ({ x: c.x + roi.x, y: c.y + roi.y })); });
      for (const point of markerPoints(markers, size, detailSize)) merged.set(point.id, point);
    }
  }
  return [...merged.values()];
}
