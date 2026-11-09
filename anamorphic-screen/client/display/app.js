import { $, api, json, toast, copyText } from '/assets/utils.js';
import { markerLayout, computeWarp, viewportKey } from '/shared/calibration.js';

const readViewport = () => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1 });
const storagePrefix = 'anamorphic:calibration:v1:';
let viewport = readViewport(), P = markerLayout(viewport), calibration = null, sessionId = null;
let generation = 0, socket, reconnectTimer, retryCount = 0, config, resizeTimer, idleTimer, forceRecalibration = false;
let mode = 'calibrating', warped = true, warpResult, rasterGeneration = 0, objectURL;
const tuning = { scale: 0.9, offset: { x: 0, y: 0 }, width: 960, height: 600, font: 76 };

function storedGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storedSet(key, value) { try { localStorage.setItem(key, value); } catch { toast('Không lưu được trong trình duyệt. Phiên hiện tại vẫn dùng được.'); } }
function status(text, busy = false, error = false) {
  $('#status-text').textContent = text;
  $('#status-text').classList.toggle('error', error);
  $('#status-icon').className = busy ? 'spinner' : 'dot';
  $('#retry').hidden = !error;
}
function connection(text, connected = false) {
  $('#connection-text').textContent = text;
  $('#connection .dot').style.background = connected ? '#8cab52' : '#c99845';
}

function renderMarkers() {
  $('#markers').replaceChildren();
  const side = Math.min(viewport.vw, viewport.vh) * 0.12;
  for (const [index, marker] of P.entries()) {
    const node = document.createElement('div');
    node.className = `marker${index >= 2 ? ' bottom' : ''}`;
    node.dataset.id = marker.id;
    // generateSVG includes one white cell around the 7×7 black marker.
    Object.assign(node.style, { left: `${marker.x}px`, top: `${marker.y}px`, width: `${side * 9 / 7}px`, height: `${side * 9 / 7}px` });
    const image = document.createElement('img'); image.src = `/api/markers/${marker.id}.svg`; image.alt = `Marker ${index + 1}`;
    const label = document.createElement('span'); label.className = 'marker-label';
    const number = document.createElement('b'); number.textContent = String(index + 1).padStart(2, '0');
    label.append(number, document.createTextNode(['TRÊN TRÁI', 'TRÊN PHẢI', 'DƯỚI PHẢI', 'DƯỚI TRÁI'][index]));
    node.append(image, label); $('#markers').append(node);
  }
}

function setMode(next) {
  mode = next;
  document.body.dataset.state = next === 'display' ? 'display' : next;
  $('#calibration-card').hidden = next === 'display';
  $('#markers').hidden = next === 'display';
  $('#warp').hidden = next !== 'display';
  $('#preview').hidden = next === 'display';
  $('#controls-toggle').hidden = next !== 'display';
  $('#uncalibrated').hidden = !!calibration;
  if (next !== 'display') { $('#controls').hidden = true; $('#controls-toggle').setAttribute('aria-expanded', 'false'); }
  $('#footer-note').textContent = next === 'display' ? (calibration ? 'Điểm nhìn đã khóa · Di chuyển mắt cần hiệu chuẩn lại' : 'Nội dung mẫu · Chưa hiệu chuẩn') : '4 marker · 1 điểm nhìn · Không cần cài ứng dụng';
  if (next !== 'display') $('#debug-outline').setAttribute('hidden', '');
  revealChrome();
}

function remember() {
  if (!calibration) return;
  const key = viewportKey(viewport);
  storedSet(storagePrefix + key, JSON.stringify({ ...calibration, ...tuning, text: $('#text-input').value, savedAt: Date.now() }));
  storedSet('anamorphic:last-viewport', key);
  // Bound local cache size; no photo or image content is persisted.
  try {
    const entries = Object.keys(localStorage).filter(k => k.startsWith(storagePrefix));
    entries.filter(k => k !== storagePrefix + key).sort((a, b) => (JSON.parse(localStorage[a]).savedAt || 0) - (JSON.parse(localStorage[b]).savedAt || 0))
      .slice(0, Math.max(0, entries.length - 8)).forEach(k => localStorage.removeItem(k));
  } catch { /* An older damaged record need not prevent the current calibration. */ }
}

function syncControls() {
  $('#scale').value = tuning.scale; $('#scale-value').value = `${Math.round(tuning.scale * 100)}%`;
  for (const axis of ['x', 'y']) { $(`#offset-${axis}`).value = tuning.offset[axis]; $(`#offset-${axis}-value`).value = `${Math.round(tuning.offset[axis] * 100)}%`; }
  $('#content-width').value = tuning.width; $('#content-height').value = tuning.height;
  $('#font-size').value = tuning.font; $('#font-value').value = `${tuning.font} px`;
}

function renderWarp() {
  const content = $('#content'), wrap = $('#warp');
  content.style.width = wrap.style.width = `${tuning.width}px`;
  content.style.height = wrap.style.height = `${tuning.height}px`;
  $('#poster-text').style.fontSize = `${tuning.font}px`;
  $('#poster-text').textContent = $('#text-input').value;
  $('#poster-art').hidden = tuning.width < 700;
  $('#debug-grid').hidden = !$('#debug').checked;
  wrap.style.willChange = $('#gpu-mode').checked ? 'transform' : 'auto';
  if (calibration) {
    warpResult = computeWarp({ ...calibration, ...tuning });
    $('#compression-warning').hidden = warpResult.compression >= 0.35;
  } else { warpResult = null; $('#compression-warning').hidden = true; }
  if (warped && warpResult) wrap.style.transform = warpResult.css;
  else {
    const scale = Math.min(viewport.vw * 0.84 / tuning.width, viewport.vh * 0.74 / tuning.height) * tuning.scale;
    const x = (viewport.vw - tuning.width * scale) / 2, y = (viewport.vh - tuning.height * scale) / 2;
    wrap.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  }
  $('#warp-toggle').setAttribute('aria-pressed', String(warped));
  $('#warp-toggle').replaceChildren(document.createTextNode(`Bù góc: ${warped ? 'Bật' : 'Tắt'} `));
  const kbd = document.createElement('kbd'); kbd.textContent = 'W'; $('#warp-toggle').append(kbd);
  $('#debug-outline').toggleAttribute('hidden', !($('#debug').checked && warpResult && warped && mode === 'display'));
  if (warpResult) $('#debug-outline polygon').setAttribute('points', warpResult.S.map(p => p.join(',')).join(' '));
  syncControls(); remember();
  scheduleRaster();
}

function safeRender() { try { renderWarp(); } catch (error) { toast(error.message); } }
let rasterTimer;
function scheduleRaster() {
  const revision = ++rasterGeneration;
  clearTimeout(rasterTimer);
  $('#content').hidden = false; $('#raster').hidden = true;
  if (!$('#raster-mode').checked || mode !== 'display') return;
  // Render an untransformed clone: rasterising the warped element would apply G twice.
  rasterTimer = setTimeout(async () => {
    let host;
    try {
      if (!window.html2canvas) throw new Error('Chưa tải được bộ render canvas.');
      if (tuning.width * tuning.height * 4 > 20_000_000) throw new Error('Canvas 2× cần vùng nội dung dưới 5 triệu pixel. Hãy giảm kích thước.');
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none';
      const clone = $('#content').cloneNode(true); clone.hidden = false;
      host.append(clone); document.body.append(host);
      const rendered = await window.html2canvas(clone, { scale: 2, logging: false, backgroundColor: null, width: tuning.width, height: tuning.height, windowWidth: Math.max(innerWidth, tuning.width) });
      if (revision !== rasterGeneration || !$('#raster-mode').checked || mode !== 'display') return;
      const canvas = $('#raster'); canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext('2d').drawImage(rendered, 0, 0);
      canvas.hidden = false; $('#content').hidden = true;
    } catch (error) {
      if (revision === rasterGeneration) { $('#raster-mode').checked = false; toast(error.message); }
    } finally { host?.remove(); }
  }, 180);
}

function showContent() {
  setMode('display');
  try { renderWarp(); } catch (error) {
    calibration = null; setMode('calibrating'); status(error.message, false, true);
  }
}

function captureURL() {
  const base = new URL($('#server-url').value);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Dùng URL HTTP hoặc HTTPS hợp lệ.');
  return new URL(`/capture/${sessionId}`, base).href;
}
function updateQR() {
  if (!sessionId) return;
  const url = captureURL();
  const image = $('#qr');
  image.onload = () => { image.hidden = false; $('#qr-loading').hidden = true; };
  image.onerror = () => { image.hidden = true; $('#qr-loading').hidden = true; status('Không tạo được QR. Hãy thử lại phiên.', false, true); };
  image.src = `/api/session/${sessionId}/qr?url=${encodeURIComponent(url)}`;
  $('#copy-link').disabled = false;
  $('#copy-link').title = url;
  const hostname = new URL(url).hostname;
  $('#network-hint').textContent = ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
    ? 'localhost chỉ mở được trên máy tính. Hãy đổi sang IP LAN hoặc URL cổng đã chuyển tiếp để điện thoại truy cập.'
    : location.hostname.endsWith('.app.github.dev') ? 'Trong Codespaces, điện thoại phải truy cập được cổng chuyển tiếp này (đăng nhập GitHub nếu cổng để riêng tư).' : 'Điện thoại cần cùng LAN/Wi-Fi và truy cập được cổng server này.';
}

function connect(id, currentGeneration) {
  if (currentGeneration !== generation) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws?session=${encodeURIComponent(id)}`);
  socket = ws;
  ws.onopen = () => { if (currentGeneration !== generation) return ws.close(); retryCount = 0; connection('Đã kết nối', true); };
  ws.onmessage = event => {
    if (currentGeneration !== generation) return;
    const data = JSON.parse(event.data);
    if (data.type === 'photo_received') { if (mode !== 'display') setMode('waiting'); status('Đã nhận ảnh · Đang nhận diện 4 marker…', true); }
    if (data.type === 'detect_failed') { if (mode !== 'display') setMode('calibrating'); status(data.reason || 'Hãy chọn điểm thủ công trên điện thoại.'); }
    if (data.type === 'calibrated') {
      const candidate = { viewport, P, Q: data.Q, imageSize: data.imageSize };
      try { computeWarp({ ...candidate, ...tuning }); } catch (error) { setMode('calibrating'); status(error.message, false, true); return; }
      calibration = candidate; warped = true;
      $('#viewport-notice').hidden = true;
      showContent(); toast('Đã khóa góc nhìn. Nhìn từ đúng vị trí vừa chụp để kiểm tra.');
    }
    if (data.type === 'session_expired') connection('Phiên đã hết hạn');
  };
  ws.onerror = () => connection('Mất kết nối');
  ws.onclose = async event => {
    if (currentGeneration !== generation) return;
    if (event.code === 4001) {
      sessionId = null;
      if (mode !== 'display') { status('Phiên đã hết hạn. Đang tạo QR mới…', true); beginCalibration(); }
      else connection('Đã lưu góc nhìn', true);
      return;
    }
    connection('Đang kết nối lại');
    reconnectTimer = setTimeout(async () => {
      if (currentGeneration !== generation) return;
      try { await api(`/api/session/${id}`); connect(id, currentGeneration); }
      catch (error) {
        if (currentGeneration !== generation) return;
        if (error.status === 404) {
          if (mode !== 'display') beginCalibration(); else connection('Đã lưu góc nhìn', true);
        } else { connect(id, currentGeneration); }
      }
    }, Math.min(8000, 500 * 2 ** retryCount++));
  };
}

// Browsers can retain a half-open WebSocket when the network disappears. Close
// it on the offline signal so reconnect/replay does not wait for a TCP timeout.
addEventListener('offline', () => { socket?.close(); connection('Mất mạng'); });

async function beginCalibration(message = '') {
  const currentGeneration = ++generation;
  clearTimeout(reconnectTimer); socket?.close();
  const previous = sessionId; sessionId = null;
  if (previous) api(`/api/session/${previous}`, { method: 'DELETE' }).catch(() => {});
  calibration = null; viewport = readViewport(); P = markerLayout(viewport);
  renderMarkers(); setMode('calibrating');
  $('#qr').hidden = true; $('#qr-loading').hidden = false; $('#copy-link').disabled = true;
  $('#session-label').textContent = 'Đang tạo phiên…';
  status(message || 'Đang tạo phiên hiệu chuẩn…', true); connection('Đang kết nối');
  try {
    const data = await api('/api/session', json({ viewport, markers: P }));
    if (currentGeneration !== generation) { api(`/api/session/${data.sessionId}`, { method: 'DELETE' }).catch(() => {}); return; }
    sessionId = data.sessionId;
    $('#session-label').textContent = `PHIÊN ${sessionId.slice(0, 8).toUpperCase()}`;
    updateQR(); connect(sessionId, currentGeneration);
    status(message || 'Sẵn sàng · Chờ ảnh từ điện thoại');
  } catch (error) {
    if (currentGeneration !== generation) return;
    $('#qr-loading').hidden = true; connection('Chưa kết nối');
    status(`Không tạo được phiên: ${error.message}`, false, true);
  }
}

function invalidate(force = false) {
  forceRecalibration ||= force;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const forced = forceRecalibration; forceRecalibration = false;
    if (!forced && viewportKey(readViewport()) === viewportKey(viewport)) return;
    $('#viewport-notice').textContent = 'Kích thước hiển thị hoặc chế độ toàn màn hình đã đổi. Hãy chụp lại để hiệu chuẩn.';
    $('#viewport-notice').hidden = false;
    beginCalibration('Viewport đã đổi · Quét QR mới và chụp lại');
  }, 250);
}
addEventListener('resize', () => invalidate());
let dprQuery;
function watchDPR() {
  dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  dprQuery.addEventListener('change', () => { invalidate(true); watchDPR(); }, { once: true });
}
watchDPR();
// Some browsers/emulation paths change DPR without emitting a resolution media
// query event (for example when moving between monitors). Keep a cheap fallback.
setInterval(() => { if ((devicePixelRatio || 1) !== viewport.dpr) invalidate(true); }, 1000);
let wasFullscreen = !!document.fullscreenElement;
document.addEventListener('fullscreenchange', () => {
  const active = !!document.fullscreenElement;
  $('#fullscreen').textContent = active ? '⛶ Thoát toàn màn hình' : '⛶ Toàn màn hình';
  invalidate(wasFullscreen && !active); wasFullscreen = active;
});
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { toast('Trình duyệt không cho bật toàn màn hình. Có thể dùng F11 rồi hiệu chuẩn lại.'); }
}

function revealChrome() {
  document.body.classList.remove('idle'); clearTimeout(idleTimer);
  if (mode === 'display' && $('#controls').hidden) idleTimer = setTimeout(() => {
    if (!document.activeElement?.closest('.chrome')) document.body.classList.add('idle');
  }, 4500);
}
function toggleControls(open = $('#controls').hidden) {
  $('#controls').hidden = !open; $('#controls-toggle').setAttribute('aria-expanded', String(open)); revealChrome();
}
addEventListener('pointermove', revealChrome); addEventListener('pointerdown', revealChrome); addEventListener('focusin', revealChrome);
addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches('input,textarea,select,[contenteditable]')) return;
  revealChrome();
  const key = event.key.toLowerCase();
  if (key === 'f') fullscreen();
  if (key === 'c' && mode === 'display') toggleControls();
  if (key === 'w' && mode === 'display') { warped = !warped; safeRender(); }
  if (key === 'd' && mode === 'display') { $('#debug').checked = !$('#debug').checked; safeRender(); }
  if (key === 'escape') toggleControls(false);
});
$('#fullscreen').onclick = fullscreen;
$('#controls-toggle').onclick = () => toggleControls(); $('#controls-close').onclick = () => toggleControls(false);
$('#preview').onclick = () => { showContent(); toggleControls(true); };
$('#recalibrate').onclick = () => { $('#viewport-notice').hidden = true; beginCalibration(); };
$('#retry').onclick = () => beginCalibration();
$('#warp-toggle').onclick = () => { warped = !warped; safeRender(); };
$('#reset-position').onclick = () => { tuning.scale = 0.9; tuning.offset = { x: 0, y: 0 }; safeRender(); };
$('#scale').oninput = event => { tuning.scale = Number(event.target.value); safeRender(); };
for (const axis of ['x', 'y']) $(`#offset-${axis}`).oninput = event => { tuning.offset[axis] = Number(event.target.value); safeRender(); };
for (const [selector, property] of [['#content-width', 'width'], ['#content-height', 'height']]) $(selector).onchange = event => {
  if (!event.target.checkValidity()) { toast('Kích thước nội dung từ 100 đến 4000 px.'); syncControls(); return; }
  tuning[property] = Number(event.target.value); safeRender();
};
$('#text-input').oninput = safeRender;
$('#font-size').oninput = event => { tuning.font = Number(event.target.value); safeRender(); };
for (const selector of ['#debug', '#raster-mode', '#gpu-mode']) $(selector).onchange = safeRender;
$('#image-input').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast('Hãy chọn ảnh dưới 20 MB.'); return; }
  const url = URL.createObjectURL(file), image = $('#custom-image');
  const previous = objectURL;
  try { const probe = new Image(); probe.src = url; await probe.decode(); }
  catch { URL.revokeObjectURL(url); toast('Không đọc được ảnh này. Hãy dùng JPEG/PNG/WebP.'); return; }
  image.src = url; objectURL = url; if (previous) URL.revokeObjectURL(previous);
  image.hidden = false; $('#remove-image').hidden = false;
  image.onload = safeRender; safeRender();
};
$('#remove-image').onclick = () => {
  if (objectURL) URL.revokeObjectURL(objectURL); objectURL = null;
  $('#custom-image').hidden = true; $('#custom-image').removeAttribute('src'); $('#remove-image').hidden = true; $('#image-input').value = ''; safeRender();
};
$('#apply-url').onclick = () => {
  try { updateQR(); storedSet('anamorphic:server-url', $('#server-url').value); toast('Đã cập nhật QR cho địa chỉ mới.'); }
  catch (error) { toast(error.message); }
};
$('#copy-link').onclick = async () => {
  try { await copyText(captureURL()); toast('Đã sao chép đường dẫn chụp ảnh.'); } catch (error) { toast(error.message); }
};

async function boot() {
  renderMarkers();
  try {
    config = await api('/api/config');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    $('#server-url').value = storedGet('anamorphic:server-url') || config.publicUrl || (loopback ? config.lanUrls[0] : location.origin) || location.origin;
    for (const url of config.lanUrls) {
      const button = document.createElement('button'); button.className = 'text-button'; button.textContent = new URL(url).host;
      button.onclick = () => { $('#server-url').value = url; $('#apply-url').click(); };
      $('#lan-options').append(button);
    }
  } catch { $('#server-url').value = location.origin; }
  try {
    const record = JSON.parse(storedGet(storagePrefix + viewportKey(viewport)));
    if (record) {
      if (viewportKey(record.viewport) !== viewportKey(viewport)) throw new Error('Viewport không khớp.');
      computeWarp(record);
      calibration = { viewport: record.viewport, P: record.P, Q: record.Q, imageSize: record.imageSize };
      for (const prop of ['scale', 'width', 'height', 'font']) if (Number.isFinite(record[prop])) tuning[prop] = record[prop];
      if (record.offset) tuning.offset = record.offset;
      if (typeof record.text === 'string') $('#text-input').value = record.text;
      showContent(); connection('Đã khôi phục', true);
      toast('Đã khôi phục góc nhìn. Nếu vị trí mắt hoặc màn hình đã đổi, hãy hiệu chuẩn lại.'); return;
    }
  } catch { toast('Bản hiệu chuẩn cũ không hợp lệ. Hãy chụp lại.'); }
  const previous = storedGet('anamorphic:last-viewport');
  if (previous && previous !== viewportKey(viewport)) {
    $('#viewport-notice').textContent = 'Bản lưu dùng kích thước màn hình khác. Cần hiệu chuẩn cho viewport hiện tại.';
    $('#viewport-notice').hidden = false;
  }
  beginCalibration();
}
boot();
