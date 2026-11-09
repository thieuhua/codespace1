import { $ } from '/assets/utils.js';
import { sliderZoom, zoomSlider, snapSetting, cameraPoint } from '/shared/camera-settings.js';

const labels = { continuous: 'Tự động liên tục', 'single-shot': 'Lấy nét một lần', manual: 'Chỉnh tay' };
const zoomLabel = value => `${Number(value.toFixed(2))}×`;

export class LensUI {
  constructor(camera) {
    this.camera = camera;
    $('#camera-device').onchange = event => camera.selectDevice(event.target.value).catch(error => this.notice(error.message));
    $('#camera-zoom').oninput = event => {
      if (this.current?.zoom) this.update({ zoom: sliderZoom(Number(event.target.value), this.current.zoom) });
    };
    $('#camera-focus-mode').onchange = event => this.update({ focusMode: event.target.value });
    $('#camera-focus-distance').oninput = event => this.update({ focusDistance: Number(event.target.value) });
    $('#camera-refocus').onclick = () => {
      const modes = this.current?.focusModes || [];
      this.update({ focusMode: modes.includes('single-shot') ? 'single-shot' : 'continuous' });
    };
    const video = $('#camera-video');
    video.onclick = async event => {
      if (!this.current?.tap) return;
      const point = cameraPoint(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, event.clientX, event.clientY);
      if (!point) return;
      try {
        await camera.trackControls.focusAt(point);
        const target = $('#focus-target'), rect = video.getBoundingClientRect();
        target.style.left = `${event.clientX - rect.left}px`; target.style.top = `${event.clientY - rect.top}px`; target.hidden = false;
        clearTimeout(this.targetTimer); this.targetTimer = setTimeout(() => { target.hidden = true; }, 1600);
        this.notice('Đã gửi điểm lấy nét tới camera.');
      } catch (error) { this.notice(error.message); }
    };
  }
  update(patch) {
    this.notice('Đang chỉnh camera…');
    this.camera.trackControls?.update(patch).catch(error => this.notice(error.message));
  }
  notice(text) { $('#lens-status').textContent = text; }
  busy(active) {
    $('#camera-device').disabled = active;
    $('#camera-refocus').disabled = active || !this.current?.focusModes.some(mode => mode !== 'manual');
    if (active) $('#focus-target').hidden = true;
  }
  render(state) {
    this.current = state;
    $('#lens-controls').hidden = !state;
    if (!state) { $('#focus-target').hidden = true; return; }
    const select = $('#camera-device');
    const available = state.devices.length ? state.devices : [{ deviceId: state.deviceId, label: state.label || 'Camera hiện tại' }];
    const deviceKey = available.map(d => d.deviceId + d.label).join('|');
    if (this.deviceKey !== deviceKey) {
      select.replaceChildren(...available.map((device, i) => new Option(device.label || `Camera ${i + 1}`, device.deviceId)));
      this.deviceKey = deviceKey;
    }
    select.value = state.deviceId;
    $('#camera-zoom-controls').hidden = !state.zoom;
    if (state.zoom) {
      const actual = state.settings.zoom;
      $('#camera-zoom-value').value = Number.isFinite(actual) ? zoomLabel(actual) : 'Chưa báo mức zoom';
      if (Number.isFinite(actual)) {
        $('#camera-zoom').setAttribute('aria-valuetext', zoomLabel(actual));
        if (!state.busy || document.activeElement !== $('#camera-zoom')) $('#camera-zoom').value = zoomSlider(actual, state.zoom);
      }
      const presets = [...new Set([state.zoom.min, 1, 1.5, 2, 3].filter(v => v >= state.zoom.min && v <= state.zoom.max).map(v => snapSetting(v, state.zoom)))];
      const key = presets.join(',');
      if (key !== this.presetKey) {
        $('#camera-zoom-presets').replaceChildren(...presets.map(value => {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = zoomLabel(value); button.dataset.zoom = value;
          button.onclick = () => this.update({ zoom: value }); return button;
        }));
        this.presetKey = key;
      }
      $('#camera-zoom-presets').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.zoom) - actual) < state.zoom.step / 2 + 1e-6)));
    }
    $('#camera-focus-controls').hidden = !state.focusModes.length;
    const focus = $('#camera-focus-mode');
    if (this.modeKey !== state.focusModes.join('|')) { focus.replaceChildren(...state.focusModes.map(mode => new Option(labels[mode], mode))); this.modeKey = state.focusModes.join('|'); }
    focus.value = state.settings.focusMode || '';
    $('#camera-focus-distance-controls').hidden = !state.focusDistance || state.settings.focusMode !== 'manual';
    if (state.focusDistance) {
      const input = $('#camera-focus-distance'), range = state.focusDistance;
      input.min = range.min; input.max = range.max; input.step = range.step;
      if (Number.isFinite(state.settings.focusDistance)) {
        if (!state.busy || document.activeElement !== input) input.value = state.settings.focusDistance;
        $('#camera-focus-distance-value').value = String(Number(state.settings.focusDistance.toFixed(3)));
      } else $('#camera-focus-distance-value').value = 'Chưa báo khoảng nét';
    }
    $('#camera-capability-note').textContent = [state.zoom ? 'Zoom tính theo camera đang chọn.' : 'Camera không cung cấp điều khiển zoom.',
      state.tap ? 'Chạm ảnh để lấy nét.' : state.focusModes.length ? 'Camera không cung cấp chạm lấy nét.' : 'Trình duyệt tự quản lý lấy nét; có thể dùng chụp ảnh hệ thống nếu ảnh mờ.'].join(' ');
    this.busy(state.busy || this.camera.switching);
    try { localStorage.setItem('anamorphic:camera:v1', JSON.stringify(state.preference)); } catch { /* Camera still works without persistent preferences. */ }
  }
}
