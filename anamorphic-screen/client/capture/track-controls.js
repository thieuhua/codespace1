import { settingRange, snapSetting } from '../../shared/camera-settings.js';

const read = fn => { try { return fn() || {}; } catch { return {}; } };

// Serialize/coalesce lens requests. applyConstraints replaces previous advanced
// constraints, so every update includes the other active lens settings as well.
export class TrackControls {
  constructor(track, { supported = {}, state = () => {}, busy = () => {}, changed = async () => {}, notice = () => {} } = {}) {
    Object.assign(this, { track, supported, state, onBusy: busy, changed, notice, pending: null, waiters: [], busy: false, disposed: false });
    this.capabilities = read(() => track.getCapabilities());
    this.zoom = settingRange(this.capabilities.zoom);
    if (this.zoom?.min <= 0) this.zoom = null;
    this.focusDistance = settingRange(this.capabilities.focusDistance);
    this.focusModes = Array.isArray(this.capabilities.focusMode) ? this.capabilities.focusMode.filter(m => ['continuous', 'single-shot', 'manual'].includes(m)) : [];
    this.tap = supported.pointsOfInterest === true && this.focusModes.some(m => ['continuous', 'single-shot'].includes(m));
    this.requested = {};
    const settings = this.settings();
    if (this.zoom && Number.isFinite(settings.zoom)) this.requested.zoom = snapSetting(settings.zoom, this.zoom);
    if (this.focusModes.includes(settings.focusMode)) this.requested.focusMode = settings.focusMode;
    if (settings.focusMode === 'manual' && this.focusDistance && Number.isFinite(settings.focusDistance)) this.requested.focusDistance = snapSetting(settings.focusDistance, this.focusDistance);
  }
  settings() { return read(() => this.track.getSettings()); }
  emit() { if (!this.disposed) this.state({ zoom: this.zoom, focusDistance: this.focusDistance, focusModes: this.focusModes, tap: this.tap, settings: this.settings(), busy: this.busy }); }
  async initialize(savedZoom) {
    const patch = {};
    if (this.zoom && Number.isFinite(savedZoom)) patch.zoom = snapSetting(savedZoom, this.zoom);
    if (this.focusModes.includes('continuous')) patch.focusMode = 'continuous';
    if (Object.keys(patch).length) {
      try { await this.apply(patch); } catch { this.notice('Không đặt được cấu hình ban đầu. Camera vẫn dùng thiết lập hiện tại.'); }
    }
    this.emit();
  }
  normalize(patch) {
    const next = { ...this.requested };
    if ('zoom' in patch) {
      if (!this.zoom) throw new Error('Camera này không cung cấp điều khiển zoom.');
      next.zoom = snapSetting(Number(patch.zoom), this.zoom);
    }
    if ('focusMode' in patch) {
      if (!this.focusModes.includes(patch.focusMode)) throw new Error('Camera không hỗ trợ chế độ lấy nét này.');
      next.focusMode = patch.focusMode;
      if (patch.focusMode !== 'manual') delete next.focusDistance;
    }
    if ('focusDistance' in patch) {
      if (!this.focusDistance || !this.focusModes.includes('manual')) throw new Error('Camera không cung cấp lấy nét tay.');
      next.focusMode = 'manual'; next.focusDistance = snapSetting(Number(patch.focusDistance), this.focusDistance);
    }
    if ('pointsOfInterest' in patch) {
      if (!this.tap) throw new Error('Trình duyệt/camera không hỗ trợ chạm lấy nét.');
      next.pointsOfInterest = patch.pointsOfInterest.map(p => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }));
    }
    return next;
  }
  async apply(patch) {
    const next = this.normalize(patch);
    const constraints = read(() => this.track.getConstraints());
    await this.track.applyConstraints({ ...constraints, advanced: [next] });
    if (this.disposed) return;
    this.requested = next;
    const actual = this.settings();
    if ('zoom' in patch && (!Number.isFinite(actual.zoom) || Math.abs(actual.zoom - next.zoom) > Math.max(this.zoom.step / 2, 1e-5))) {
      this.notice('Thiết bị chưa xác nhận mức zoom yêu cầu; số hiển thị là mức camera báo lại.');
    }
  }
  update(patch) {
    if (this.disposed) return Promise.reject(new Error('Camera đã dừng.'));
    this.pending = { ...this.pending, ...patch };
    const result = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (!this.busy) { this.busy = true; this.onBusy(true); this.emit(); this.timer = setTimeout(() => this.drain(), 70); }
    return result;
  }
  async drain() {
    let error, applied = false;
    while (!this.disposed && this.pending) {
      const patch = this.pending; this.pending = null;
      try { await this.apply(patch); applied = true; }
      catch (err) { error = err; this.notice(`Không đổi được camera: ${err.message}`); }
      this.emit();
    }
    if (applied && !this.disposed) {
      try { await this.changed(); } catch (err) { error = err; this.notice(err.message); }
    }
    if (this.disposed) return;
    if (this.pending) { this.drain(); return; }
    this.busy = false; this.onBusy(false); this.emit();
    for (const waiter of this.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve(this.settings());
  }
  focusAt(point) {
    return this.update({ focusMode: this.focusModes.includes('single-shot') ? 'single-shot' : 'continuous', pointsOfInterest: [point] });
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer); this.pending = null;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Camera đã dừng.'));
  }
}
