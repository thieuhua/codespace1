import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { markerSVG } from './detect.js';
import { SessionStore } from './sessions.js';
import { MARKER_IDS, validateCalibration } from '../shared/calibration.js';
import { PHOTO_WAITING, PHOTO_JOB_MS } from '../shared/photo.js';
import { geometry, snapshot, peers, resetStream, handleMessage } from './protocol.js';
import { publicURL } from './public-url.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const PHOTO_LIMIT = 20 * 1024 * 1024;

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
function broadcast(session, type, payload = {}) {
  const message = JSON.stringify({ type, ...payload });
  for (const socket of session.clients) if (socket.readyState === WebSocket.OPEN) socket.send(message);
}
export function lanAddresses(port) {
  return Object.values(networkInterfaces()).flat().filter(item => item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${port}`);
}

// One reusable worker and a bounded queue keep image detection off the HTTP/WS thread.
function detectorQueue() {
  let worker, active;
  let stopped = false;
  const queue = [];
  const positions = () => queue.forEach((job, i) => job.status({ state: 'queued', position: i + 1 }));
  const start = () => {
    if (stopped || active || !queue.length) return;
    if (!worker) {
      const instance = new Worker(new URL('./detect-worker.js', import.meta.url));
      worker = instance;
      instance.on('message', message => {
        if (worker !== instance || !active || message.id !== active.id) return;
        clearTimeout(active.timeout);
        const job = active; active = null;
        if (message.error) job.reject(bad(`Không đọc được ảnh. Hãy dùng JPEG/PNG. ${message.error}`, 422));
        else job.resolve({ ...message.result, preview: Buffer.from(message.result.preview) });
        start();
      });
      const failed = message => {
        if (worker !== instance) return;
        if (active) { clearTimeout(active.timeout); active.reject(bad(`Không xử lý được ảnh: ${message}`, 422)); active = null; }
        worker = null; start();
      };
      instance.on('error', error => failed(error.message));
      instance.on('exit', code => failed(`Worker dừng với mã ${code}.`));
    }
    active = queue.shift();
    active.status({ state: 'processing', position: 0 }); positions();
    active.timeout = setTimeout(() => {
      const job = active; active = null;
      worker.terminate(); worker = null;
      job.reject(bad('Ảnh xử lý quá lâu. Hãy thử ảnh nhỏ hơn.', 422));
      start();
    }, PHOTO_JOB_MS);
    worker.postMessage({ id: active.id, buffer: active.buffer });
  };
  return {
    run(buffer, status = () => {}) {
      if (stopped || queue.length >= PHOTO_WAITING) return Promise.reject(bad('Server đang xử lý nhiều ảnh. Hãy thử lại sau.', 503));
      return new Promise((resolve, reject) => { queue.push({ id: randomUUID(), buffer, resolve, reject, status }); positions(); start(); });
    },
    async close() {
      stopped = true;
      if (active) { clearTimeout(active.timeout); active.reject(bad('Server đã dừng.', 503)); active = null; }
      for (const job of queue.splice(0)) job.reject(bad('Server đã dừng.', 503));
      if (worker) { const instance = worker; worker = null; await instance.terminate(); }
    }
  };
}

export function createApplication({ ttl, now, detector, markerMaxAgeMs } = {}) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const processing = detectorQueue();
  const store = new SessionStore({ ttl, now, onExpire: session => {
    broadcast(session, 'session_expired');
    for (const socket of session.clients) socket.close(4001, 'Session expired');
    session.photo = null;
  } });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PHOTO_LIMIT, files: 1, fields: 0, parts: 1 } });
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  function sessionRequired(req, _res, next) {
    const session = store.get(req.params.id);
    if (!session) return next(bad('Phiên không tồn tại hoặc đã hết hạn. Quét QR mới trên máy tính.', 404));
    req.session = session;
    next();
  }
  app.get('/api/config', (req, res) => {
    const port = server.address()?.port || 3000;
    res.json({ lanUrls: lanAddresses(port), publicUrl: publicURL(port), photoLimit: PHOTO_LIMIT });
  });
  app.get('/api/markers/:id.svg', (req, res, next) => {
    const id = Number(req.params.id);
    if (!MARKER_IDS.includes(id)) return next(bad('Marker không hợp lệ.', 404));
    res.type('svg').send(markerSVG(id));
  });
  app.post('/api/session', (req, res) => {
    const { viewport, markers } = req.body || {};
    let config;
    try { config = geometry(viewport, markers); } catch (error) { throw bad(error.message); }
    const session = store.create(config);
    res.status(201).json({ sessionId: session.id, expiresIn: store.ttl });
  });
  app.get('/api/session/:id', sessionRequired, (req, res) => {
    res.json({ ...snapshot(req.session), peers: peers(req.session) });
  });
  app.delete('/api/session/:id', sessionRequired, (req, res) => { store.delete(req.session.id); res.sendStatus(204); });
  app.get('/api/session/:id/qr', sessionRequired, async (req, res) => {
    const value = req.query.url;
    let url;
    try { url = new URL(value); } catch { throw bad('URL QR không hợp lệ.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== `/capture/${req.session.id}` || value.length > 2048) throw bad('URL QR không hợp lệ.');
    res.type('svg').send(await QRCode.toString(url.href, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  });
  app.post('/api/session/:id/photo', sessionRequired, (req, res, next) => {
    if (req.session.busy) return next(bad('Ảnh trước vẫn đang xử lý. Hãy đợi một chút.', 409));
    req.session.busy = true;
    // Reserve before reading the multipart body, including concurrent uploads.
    upload.single('photo')(req, res, async error => {
      const session = req.session;
      if (session.mode !== 'calibrating') {
        resetStream(session, 'calibrating');
        broadcast(session, 'capture_started', snapshot(session));
      }
      const revision = session.revision;
      try {
        if (error) throw error;
        if (!req.file) throw bad('Chưa nhận được ảnh (trường multipart: photo).');
        session.photo = null; session.result = null; session.displayApplied = null;
        broadcast(session, 'photo_received');
        const result = await (detector || processing.run)(req.file.buffer, progress => {
          if (session.revision === revision) broadcast(session, 'photo_status', { ...progress, revision });
        });
        if (store.get(session.id, false) !== session) throw bad('Phiên đã hết hạn khi xử lý ảnh.', 404);
        if (session.revision !== revision) throw bad('Viewport hoặc lượt hiệu chỉnh đã đổi. Hãy chụp lại.', 409);
        const photoId = randomUUID();
        session.photo = { ...result, id: photoId, revision };
        let Q;
        if (result.ok) {
          try { Q = validateCalibration(result.points, result.imageSize, session.viewport); }
          catch (error) { result.ok = false; result.reason = error.message; Object.assign(session.photo, { ok: false, reason: result.reason }); }
        }
        if (result.ok) {
          session.result = { Q, imageSize: result.imageSize, photoId, revision, source: 'photo', calibrationId: session.calibrationId = (session.calibrationId || 0) + 1 };
          session.displayApplied = null;
          session.mode = 'display';
          broadcast(session, 'calibrated', session.result);
        } else broadcast(session, 'detect_failed', { reason: result.reason, revision });
        session.touched = store.now();
        session.busy = false;
        broadcast(session, 'photo_ready', { ...snapshot(session).photo, revision });
        const { preview: _preview, ...response } = result;
        res.json({ ...response, photoId, previewUrl: `/api/session/${session.id}/photo?photoId=${photoId}` });
      } catch (err) {
        session.busy = false;
        if (session.revision === revision) broadcast(session, 'detect_failed', { reason: err.message, revision, busy: false });
        next(err);
      } finally { session.busy = false; }
    });
  });
  app.get('/api/session/:id/photo', sessionRequired, (req, res) => {
    const photo = req.session.photo;
    if (!photo || (req.query.photoId && req.query.photoId !== photo.id)) throw bad('Ảnh này đã được thay thế. Hãy chụp lại.', 409);
    res.type('jpeg').send(photo.preview);
  });
  app.post('/api/session/:id/points', sessionRequired, (req, res) => {
    const session = req.session;
    if (session.busy) throw bad('Đang xử lý ảnh mới. Hãy đợi.', 409);
    if (!session.photo) throw bad('Hãy gửi ảnh trước khi chọn điểm.');
    if (session.photo.revision !== session.revision) throw bad('Lượt hiệu chỉnh đã đổi. Hãy chụp ảnh mới.', 409);
    const body = req.body;
    // photoId guards against an old tab confirming points on a newer photo.
    if (!Array.isArray(body) && body?.photoId !== session.photo.id) throw bad('Ảnh đã đổi. Hãy tải lại trang chụp.', 409);
    let Q;
    try { Q = validateCalibration(Array.isArray(body) ? body : body?.points, session.photo.imageSize, session.viewport); }
    catch (error) { throw bad(error.message); }
    session.result = { Q, imageSize: session.photo.imageSize, photoId: session.photo.id, revision: session.revision, source: 'photo',
      calibrationId: session.calibrationId = (session.calibrationId || 0) + 1 };
    session.displayApplied = null;
    session.mode = 'display';
    session.photo.points = MARKER_IDS.map((id, i) => ({ id, x: Q[i][0], y: Q[i][1] }));
    session.photo.ok = true;
    session.photo.reason = undefined;
    broadcast(session, 'calibrated', session.result);
    res.json({ ok: true, ...session.result });
  });
  app.use('/shared', express.static(path.join(root, 'shared')));
  app.use('/assets', express.static(path.join(root, 'client/common')));
  app.get('/vendor/html2canvas.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/html2canvas/dist/html2canvas.min.js')));
  app.get('/vendor/cv.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/js-aruco2/src/cv.js')));
  app.get('/vendor/aruco.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/js-aruco2/src/aruco.js')));
  app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/jsqr/dist/jsQR.js')));
  app.use('/display', express.static(path.join(root, 'client/display')));
  app.use('/capture-assets', express.static(path.join(root, 'client/capture')));
  app.get('/', (_req, res) => res.sendFile(path.join(root, 'client/display/index.html')));
  app.get(['/capture', '/capture/:id'], (req, res) => {
    // Send the UI even for expired sessions so the phone receives a useful explanation.
    res.sendFile(path.join(root, 'client/capture/index.html'));
  });
  app.use((_req, _res, next) => next(bad('Không tìm thấy đường dẫn.', 404)));
  app.use((error, _req, res, _next) => {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error instanceof multer.MulterError ? 400 : error.status || 500;
    const reason = status === 413 ? 'Ảnh vượt giới hạn 20 MB. Hãy chọn ảnh nhỏ hơn.' : status === 500 ? 'Lỗi server. Hãy thử lại.' : error.message;
    if (status === 500) console.error(error);
    res.status(status).json({ ok: false, reason });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const session = url.pathname === '/ws' && store.get(url.searchParams.get('session'));
    const role = url.searchParams.get('role') || 'display';
    if (!session || !['display', 'capture'].includes(role) || session.clients.size >= 8) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.alive = true; ws.role = role;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      session.clients.add(ws);
      ws.on('close', () => {
        session.clients.delete(ws); session.touched = store.now();
        if (session.frameOwner === ws) {
          session.frameOwner = null; session.tracker = null; session.memory = null; session.liveReady = false; session.lastFrame = null;
          if (session.mode === 'live') broadcast(session, 'live_status', { revision: session.revision, detected: 0, tracked: 0, fps: 0, warning: 'Điện thoại mất kết nối. Giữ kết quả hợp lệ gần nhất.' });
        }
        broadcast(session, 'peers', peers(session));
      });
      ws.on('message', (buffer, isBinary) => {
        let data;
        try { if (isBinary) throw new Error(); data = JSON.parse(buffer); }
        catch { ws.send(JSON.stringify({ type: 'command_ack', ok: false, reason: 'Cần thông điệp JSON hợp lệ.' })); return; }
        handleMessage(session, ws, data, { broadcast, now: store.now, markerMaxAgeMs });
      });
      ws.send(JSON.stringify({ type: 'connected', sessionId: session.id, ...snapshot(session), peers: peers(session) }));
      broadcast(session, 'peers', peers(session));
      // Recover results missed while a display was disconnected.
      if (session.mode === 'live' && session.lastFrame) ws.send(JSON.stringify({ type: 'live_points', ...session.lastFrame }));
      else if (session.mode === 'display' && session.result) ws.send(JSON.stringify({ type: 'calibrated', ...session.result }));
      else if (session.busy) ws.send(JSON.stringify({ type: 'photo_received' }));
      else if (session.photo && !session.photo.ok) ws.send(JSON.stringify({ type: 'detect_failed', reason: session.photo.reason }));
    });
  });
  const maintenance = setInterval(() => {
    store.sweep();
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
  }, 20_000);
  maintenance.unref();
  return { app, server, store, async close() {
    clearInterval(maintenance);
    for (const ws of wss.clients) ws.terminate();
    await processing.close();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const runtime = createApplication({ markerMaxAgeMs: Number(process.env.MARKER_MAX_AGE_MS || 3000) });
  runtime.server.listen(port, host, () => {
    const actual = runtime.server.address().port;
    console.log(`\nAnamorphic Screen\n  Máy tính: http://localhost:${actual}`);
    for (const url of lanAddresses(actual)) console.log(`  LAN:      ${url}`);
    if (publicURL(actual)) console.log(`  URL:      ${publicURL(actual)}`);
    console.log('  Mở trên máy tính, bật toàn màn hình, rồi quét QR bằng điện thoại cùng mạng.\n');
  });
  runtime.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await runtime.close(); process.exit(0); });
}
