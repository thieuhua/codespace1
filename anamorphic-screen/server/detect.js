import sharp from 'sharp';
import aruco from 'js-aruco2';
import { DICTIONARY, MARKER_IDS, validatePoints } from '../shared/calibration.js';

const { AR } = aruco;
const dictionary = new AR.Dictionary(DICTIONARY);

export function markerSVG(id) {
  if (!MARKER_IDS.includes(id)) throw new Error('ID marker không hợp lệ.');
  return dictionary.generateSVG(id);
}

// Image decoding is asynchronous; the CPU detector runs in detect-worker.js.
export async function detectPhoto(buffer) {
  const input = sharp(buffer, { limitInputPixels: 64_000_000, failOn: 'error' });
  const metadata = await input.metadata();
  if (!['jpeg', 'png', 'webp', 'heif', 'avif', 'tiff'].includes(metadata.format)) {
    throw new Error('Hãy dùng ảnh JPEG, PNG, WebP hoặc HEIF/AVIF được server hỗ trợ.');
  }
  const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
  const imageSize = { w: swapped ? metadata.height : metadata.width, h: swapped ? metadata.width : metadata.height };
  if (imageSize.w < 32 || imageSize.h < 32) throw new Error('Ảnh quá nhỏ. Hãy chụp lại.');
  const pipeline = input.autoOrient().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').flatten({ background: '#fff' });
  const { data, info } = await pipeline.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const preview = await pipeline.clone().jpeg({ quality: 94 }).toBuffer();
  const detector = new AR.Detector({ dictionaryName: DICTIONARY, maxHammingDistance: 2 });
  const found = detector.detect({ data, width: info.width, height: info.height });
  const matches = found.filter(m => MARKER_IDS.includes(m.id));
  const points = MARKER_IDS.flatMap(id => {
    const candidates = matches.filter(m => m.id === id);
    if (candidates.length !== 1) return [];
    const marker = candidates[0];
    // Intersection of the diagonals is the projective image of the square's
    // centre. A corner average has a measurable bias at steep viewing angles.
    const [a, b, c, d] = marker.corners;
    const dx = c.x - a.x, dy = c.y - a.y, ex = d.x - b.x, ey = d.y - b.y;
    const cross = dx * ey - dy * ex;
    if (Math.abs(cross) < 1e-8) return [];
    const t = ((b.x - a.x) * ey - (b.y - a.y) * ex) / cross;
    return [{ id, x: (a.x + t * dx) * imageSize.w / info.width, y: (a.y + t * dy) * imageSize.h / info.height }];
  });
  let reason;
  try { validatePoints(points, imageSize); } catch (error) { reason = error.message; }
  if (points.length !== 4) reason = `Tìm được ${points.length}/4 marker. Bạn có thể chạm tay vào tâm marker trên ảnh.`;
  return { ok: !reason, points, reason, imageSize, preview };
}
