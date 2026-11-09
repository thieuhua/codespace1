import sharp from 'sharp';
import { markerSVG } from '../server/detect.js';
import { markerLayout } from '../shared/calibration.js';
import { homography, invert } from '../shared/homography.js';

// A real raster image with real ArUco markers, resampled through a known projective
// camera. Detection tests never substitute precomputed marker coordinates.
export async function syntheticPhoto({ vw = 1440, vh = 900, w = 2000, h = 1400, quad, blank = false, markerIds } = {}) {
  const viewport = { vw, vh, dpr: 1 };
  const P = markerLayout(viewport);
  const side = Math.round(Math.min(vw, vh) * 0.12 / 7) * 9; // SVG includes one quiet cell on each side.
  const layers = blank ? [] : await Promise.all(P.filter(p => !markerIds || markerIds.includes(p.id)).map(async p => ({
    input: await sharp(Buffer.from(markerSVG(p.id))).resize(side, side, { kernel: 'nearest' }).png().toBuffer(),
    left: Math.round(p.x - side / 2), top: Math.round(p.y - side / 2)
  })));
  const { data } = await sharp({ create: { width: vw, height: vh, channels: 3, background: '#fff' } }).composite(layers).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const target = quad || [[230, 180], [1740, 380], [1680, 1090], [170, 1240]];
  const H = homography([[0, 0], [vw, 0], [vw, vh], [0, vh]], target);
  const inverse = invert(H);
  const output = Buffer.alloc(w * h * 3, 225);
  // Bilinear inverse resampling, using coordinates at pixel centres.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const denominator = inverse[6] * x + inverse[7] * y + inverse[8];
    const sx = (inverse[0] * x + inverse[1] * y + inverse[2]) / denominator;
    const sy = (inverse[3] * x + inverse[4] * y + inverse[5]) / denominator;
    if (sx < 0 || sy < 0 || sx >= vw - 1 || sy >= vh - 1) continue;
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    const source = (iy * vw + ix) * 3, dest = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) output[dest + c] = Math.round(
      data[source + c] * (1 - fx) * (1 - fy) + data[source + 3 + c] * fx * (1 - fy) +
      data[source + vw * 3 + c] * (1 - fx) * fy + data[source + vw * 3 + 3 + c] * fx * fy);
  }
  return { buffer: await sharp(output, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), viewport, P, H, imageSize: { w, h } };
}
