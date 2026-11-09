import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Load the actual browser camera class with only its absolute HTTP imports
// resolved locally. Canvas/video and worker/ACK latency are controlled below.
const source = (await readFile(new URL('../client/capture/camera.js', import.meta.url), 'utf8'))
  .replace("'/shared/live.js'", JSON.stringify(new URL('../shared/live.js', import.meta.url).href))
  .replace("'/shared/camera-settings.js'", JSON.stringify(new URL('../shared/camera-settings.js', import.meta.url).href))
  .replace("'./track-controls.js'", JSON.stringify(new URL('../client/capture/track-controls.js', import.meta.url).href));
const { Camera } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

test('camera waits for detector and relay ACK, preserves the 80ms period and sends same-frame 1280px detail', async t => {
  const oldDocument = globalThis.document, draws = [];
  globalThis.document = { createElement() {
    const canvas = { width: 0, height: 0 };
    canvas.getContext = () => ({ drawImage: (...args) => draws.push({ canvas, args }),
      getImageData: (_x, _y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) });
    return canvas;
  } };
  t.after(() => { globalThis.document = oldDocument; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, finishDetection, finishAck, relayed = 0;
  t.mock.method(performance, 'now', () => now);
  const video = { readyState: 2, videoWidth: 1920, videoHeight: 1080 };
  const camera = new Camera(video, { geometry: () => ({ revision: 1 }), error: assert.fail,
    frame: () => { relayed++; return new Promise(resolve => { finishAck = resolve; }); } });
  const jobs = [];
  camera.runWorker = (_type, image, geometry, detail) => {
    jobs.push({ image, geometry, detail });
    return new Promise(resolve => { finishDetection = resolve; });
  };
  camera.mode = 'live';
  const first = camera.loop(0);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].image.width, 640); assert.equal(jobs[0].detail, undefined);
  now = 5; t.mock.timers.tick(5); finishDetection({ tracked: 4 }); await flush();
  assert.equal(relayed, 1); assert.equal(jobs.length, 1);
  now = 20; t.mock.timers.tick(15); assert.equal(jobs.length, 1);
  finishAck(); await first;
  now = 79; t.mock.timers.tick(59); assert.equal(jobs.length, 1);
  now = 80; t.mock.timers.tick(1);
  assert.equal(jobs.length, 2); assert.equal(jobs[1].image.width, 640); assert.equal(jobs[1].detail.width, 1280);
  assert.equal(draws.at(-2).args[0], video); assert.equal(draws.at(-1).args[0], camera.detailCanvas);
  // A slow detector/ACK never overlaps the next job, even after many periods.
  now = 500; t.mock.timers.tick(420); assert.equal(jobs.length, 2);
  finishDetection({ tracked: 4 }); await flush(); assert.equal(relayed, 2);
  now = 1000; t.mock.timers.tick(500); assert.equal(jobs.length, 2);
  camera.resetTracking(); assert.equal(camera.roiActive, false);
  camera.stop(); finishAck(); await flush();
});
