import sharp from 'sharp';
import { markerSVG } from '../server/detect.js';
import { markerLayout, markerBlackSide } from '../shared/calibration.js';
import { homography, invert } from '../shared/homography.js';

// A real raster image with real ArUco markers, resampled through a known projective
// camera. Detection tests never substitute precomputed marker coordinates.
export async function syntheticPhoto({ vw = 1440, vh = 900, w = 2000, h = 1400, quad, blank = false, markerIds } = {}) {
  const viewport = { vw, vh, dpr: 1 };
  const P = markerLayout(viewport);
  const side = markerBlackSide(viewport) * 9 / 7;
  // Preserve the fractional CSS size and centre, including the exact black
  // border. Rounding the SVG cell size changes the calibration correspondences.
  const markers = blank ? '' : P.filter(p => !markerIds || markerIds.includes(p.id)).map(p =>
    markerSVG(p.id).replace('<svg ', `<svg x="${p.x - side / 2}" y="${p.y - side / 2}" width="${side}" height="${side}" `)).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}"><rect width="100%" height="100%" fill="white"/>${markers}</svg>`;
  const { data } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const target = quad || [[230, 180], [1740, 380], [1680, 1090], [170, 1240]];
  const H = homography([[0, 0], [vw, 0], [vw, vh], [0, vh]], target);
  const inverse = invert(H);
  const output = Buffer.alloc(w * h * 3, 225);
  // Bilinear inverse resampling, using coordinates at pixel centres.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const denominator = inverse[6] * x + inverse[7] * y + inverse[8];
    // Sharp samples CSS pixel centres at n+0.5; detector pixel centres use n.
    const sx = (inverse[0] * x + inverse[1] * y + inverse[2]) / denominator - 0.5;
    const sy = (inverse[3] * x + inverse[4] * y + inverse[5]) / denominator - 0.5;
    if (sx < 0 || sy < 0 || sx >= vw - 1 || sy >= vh - 1) continue;
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    const source = (iy * vw + ix) * 3, dest = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) output[dest + c] = Math.round(
      data[source + c] * (1 - fx) * (1 - fy) + data[source + 3 + c] * fx * (1 - fy) +
      data[source + vw * 3 + c] * (1 - fx) * fy + data[source + vw * 3 + 3 + c] * fx * fy);
  }
  return { buffer: await sharp(output, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), viewport, P, H, imageSize: { w, h } };
}

// Anti-aliased, blurred black square with known fractional, rotated corners.
export async function syntheticCornerImage(angle = 0) {
  const width = 128, height = 128, cx = 64.2, cy = 63.7, half = 34.4;
  const rotate = ([x, y]) => ({ x: cx + x * Math.cos(angle) - y * Math.sin(angle), y: cy + x * Math.sin(angle) + y * Math.cos(angle) });
  const corners = [[-half, -half], [half, -half], [half, half], [-half, half]].map(rotate);
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let black = 0;
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      const u = x + (dx + 0.5) / 8 - 0.5 - cx, v = y + (dy + 0.5) / 8 - 0.5 - cy;
      if (Math.abs(u * Math.cos(angle) + v * Math.sin(angle)) < half && Math.abs(-u * Math.sin(angle) + v * Math.cos(angle)) < half) black++;
    }
    raw[y * width + x] = Math.round(255 * (1 - black / 64));
  }
  const gray = await sharp(raw, { raw: { width, height, channels: 1 } }).blur(0.6).greyscale().raw().toBuffer();
  return { gray, width, height, corners };
}
