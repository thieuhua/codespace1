import { parentPort } from 'node:worker_threads';
import { detectPhoto } from './detect.js';

parentPort.on('message', async ({ id, buffer }) => {
  try {
    parentPort.postMessage({ id, result: await detectPhoto(Buffer.from(buffer)) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
