import { FRAME_INTERVAL } from '/shared/live.js';
import { preferredRearCamera } from '/shared/camera-settings.js';
import { TrackControls } from './track-controls.js';

export function cameraError(error) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return 'Camera trực tiếp cần HTTPS hoặc localhost. Bạn vẫn có thể chụp ảnh rồi tải lên.';
  if (error.name === 'NotAllowedError') return 'Chưa được phép dùng camera. Cho phép camera trong trình duyệt rồi thử lại, hoặc chụp ảnh tải lên.';
  if (error.name === 'NotFoundError') return 'Không tìm thấy camera. Bạn có thể chọn ảnh trong thư viện.';
  return `Không mở được camera: ${error.message}. Bạn có thể dùng chụp ảnh/tải lên.`;
}

export class Camera {
  constructor(video, { frame, qr, geometry, ready = () => {}, error, controls = () => {}, changing = () => {}, changed = async () => {}, notice = () => {}, preference = {} }) {
    Object.assign(this, { video, frame, qr, geometry, ready, error, controls, changing, changed, notice, generation: 0, jobId: 0, pending: new Map(), mode: null, lensEpoch: 0, trackingEpoch: 0 });
    this.deviceId = preference.deviceId || null; this.zooms = preference.zooms || {};
    this.canvas = document.createElement('canvas'); this.context = this.canvas.getContext('2d', { willReadFrequently: true });
  }
  async start(mode, { deviceId } = {}) {
    if (this.mode === mode && this.stream && (!deviceId || deviceId === this.deviceId)) { await this.video.play(); return; }
    this.stop(); this.mode = mode;
    const generation = this.generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera không khả dụng.');
      let requested = deviceId || this.deviceId;
      const open = id => navigator.mediaDevices.getUserMedia({ video: {
        ...(id ? { deviceId: { exact: id } } : { facingMode: { ideal: 'environment' } }),
        ...(navigator.mediaDevices.getSupportedConstraints?.().zoom ? { zoom: true } : {}),
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 }
      }, audio: false });
      let stream;
      try { stream = await open(requested); }
      catch (error) {
        if (deviceId || !requested || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
        requested = null; stream = await open();
      }
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const devices = await navigator.mediaDevices.enumerateDevices?.().then(list => list.filter(d => d.kind === 'videoinput')).catch(() => []) || [];
      if (!requested) {
        const current = stream.getVideoTracks()[0].getSettings().deviceId;
        const preferred = preferredRearCamera(devices, current);
        if (preferred && preferred !== current) {
          stream.getTracks().forEach(track => track.stop());
          try { stream = await open(preferred); } catch { stream = await open(); }
          this.stream = stream;
        }
      }
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.video.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      this.deviceId = track.getSettings().deviceId || requested;
      track.onended = () => { if (generation === this.generation) { this.stop(); this.error('Camera đã dừng. Nhấn mở camera để tiếp tục.'); } };
      this.trackControls = new TrackControls(track, {
        supported: navigator.mediaDevices.getSupportedConstraints?.() || {},
        state: state => {
          if (generation !== this.generation) return;
          if (Number.isFinite(state.settings.zoom) && this.deviceId) this.zooms[this.deviceId] = state.settings.zoom;
          this.controls({ ...state, devices, deviceId: this.deviceId, label: track.label, preference: { deviceId: this.deviceId, zooms: this.zooms } });
        },
        busy: active => { if (generation === this.generation) { if (active) this.lensEpoch++; this.changing(active); } },
        changed: () => generation === this.generation ? this.changed() : undefined,
        notice: message => { if (generation === this.generation) this.notice(message); }
      });
      await this.trackControls.initialize(this.zooms[this.deviceId]);
      await this.video.play();
      if (generation !== this.generation) return;
      if (mode === 'qr' && 'BarcodeDetector' in window) {
        try { if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) this.barcode = new BarcodeDetector({ formats: ['qr_code'] }); }
        catch { this.barcode = null; }
      }
      this.ready(mode); this.loop(generation);
    } catch (error) { if (generation === this.generation) { this.stop(); this.error(cameraError(error)); } }
  }
  async selectDevice(deviceId) {
    if (this.switching || !this.mode || deviceId === this.deviceId) return;
    const mode = this.mode;
    this.switching = true; this.lensEpoch++; this.changing(true);
    try { await this.start(mode, { deviceId }); if (this.stream) await this.changed(); }
    finally { this.switching = false; this.changing(false); }
  }
  runWorker(type, image, geometry) {
    if (!this.worker) {
      const worker = new Worker('/capture-assets/vision-worker.js'); this.worker = worker;
      worker.onmessage = ({ data }) => {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id); clearTimeout(pending.timer);
        data.error ? pending.reject(new Error(data.error)) : pending.resolve(data);
      };
      worker.onerror = () => { this.cancelJobs(new Error('Không tải được bộ dò marker/QR. Hãy tải lại trang hoặc dùng chụp ảnh.')); worker.terminate(); if (this.worker === worker) this.worker = null; };
    }
    return new Promise((resolve, reject) => {
      const id = ++this.jobId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Dò khung hình quá lâu. Hãy mở lại camera.')); this.worker?.terminate(); this.worker = null; }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, buffer: image.data.buffer, width: image.width, height: image.height, ...geometry }, [image.data.buffer]);
    });
  }
  async loop(generation) {
    if (generation !== this.generation) return;
    const started = performance.now();
    const lensEpoch = this.lensEpoch;
    const trackingEpoch = this.trackingEpoch;
    try {
      const geometry = this.geometry();
      if (!this.switching && !this.trackControls?.busy && this.video.readyState >= 2 && this.video.videoWidth && (this.mode === 'qr' || geometry)) {
        const maxSide = this.mode === 'qr' ? 960 : 640;
        const scale = Math.min(1, maxSide / Math.max(this.video.videoWidth, this.video.videoHeight));
        const w = Math.round(this.video.videoWidth * scale), h = Math.round(this.video.videoHeight * scale);
        if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
        this.context.drawImage(this.video, 0, 0, w, h);
        if (this.mode === 'qr') {
          let code;
          if (this.barcode) {
            try { code = (await this.barcode.detect(this.canvas))[0]?.rawValue; }
            catch { this.barcode = null; }
          }
          if (!this.barcode) code = (await this.runWorker('qr', this.context.getImageData(0, 0, w, h))).code;
          if (code && generation === this.generation && lensEpoch === this.lensEpoch) await this.qr(code);
        } else {
          const result = await this.runWorker('markers', this.context.getImageData(0, 0, w, h), { ...geometry, trackingKey: `${geometry.revision}:${trackingEpoch}` });
          if (generation === this.generation && lensEpoch === this.lensEpoch && trackingEpoch === this.trackingEpoch) await this.frame({ ...result, revision: geometry.revision, trackingEpoch });
        }
      }
    } catch (error) { if (generation === this.generation) { this.stop(); this.error(error.message); return; } }
    if (generation === this.generation) this.timer = setTimeout(() => this.loop(generation), Math.max(0, (this.mode === 'qr' ? 200 : FRAME_INTERVAL) - (performance.now() - started)));
  }
  resetTracking() { this.trackingEpoch++; }
  cancelJobs(error = new Error('Camera đã dừng.')) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  stop() {
    this.generation++; this.mode = null; clearTimeout(this.timer);
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null;
    this.trackControls?.dispose(); this.trackControls = null; this.controls(null);
    this.changing(false);
    this.video.srcObject = null; this.barcode = null;
    this.cancelJobs(); this.worker?.terminate(); this.worker = null;
  }
}
