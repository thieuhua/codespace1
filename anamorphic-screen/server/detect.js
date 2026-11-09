import sharp from 'sharp';
import aruco from 'js-aruco2';
import { DICTIONARY, MARKER_IDS, validatePoints } from '../shared/calibration.js';
import { markerPoints } from '../shared/markers.js';

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
  const points = markerPoints(found, imageSize, { w: info.width, h: info.height });
  let reason;
  try { validatePoints(points, imageSize); } catch (error) { reason = error.message; }
  if (points.length !== 4) reason = `Tìm được ${points.length}/4 marker. Bạn có thể chạm tay vào tâm marker trên ảnh.`;
  return { ok: !reason, points, reason, imageSize, preview };
}
