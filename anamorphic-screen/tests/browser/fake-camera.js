import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

// Feed an actual video track to getUserMedia. ArUco/jsQR and the Web Worker are
// untouched; only the physical camera is replaced with a repeatable Y4M source.
export async function cameraBrowser(png, file, { width = 640, height = 448, repeat = 8 } = {}) {
  const images = Array.isArray(png) ? png : [png];
  const frames = [];
  for (const input of images) {
  const rgb = await sharp(input).resize(width, height, { fit: 'contain', background: '#fff' }).removeAlpha().raw().toBuffer();
  const frame = Buffer.alloc(width * height * 3 / 2);
  const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    frame[y * width + x] = clamp(16 + 0.257 * r + 0.504 * g + 0.098 * b);
    if (!(x % 2) && !(y % 2)) {
      const c = y / 2 * (width / 2) + x / 2;
      frame[width * height + c] = clamp(128 - 0.148 * r - 0.291 * g + 0.439 * b);
      frame[width * height * 5 / 4 + c] = clamp(128 + 0.439 * r - 0.368 * g - 0.071 * b);
    }
  }
  frames.push(...Array.from({ length: repeat }, () => Buffer.concat([Buffer.from('FRAME\n'), frame])));
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`] });
}
