import { $, api, json, toast, copyText } from '/assets/utils.js';
import { markerLayout, markerBlackSide, computeWarp, validateCalibration, reprojectionAcceptable, reprojectionWarning, MARKER_IDS, viewportKey } from '/shared/calibration.js';
import { emaFrame } from '/shared/live.js';
import { SessionConnection } from '/assets/connection.js';
import { ContentPanel } from '/assets/content-panel.js';
import { SAMPLE_CONFIG, isServerSource, validateContent } from '/shared/content/schema.js';
import { create as createContent } from './content/runtime.js';
import { renderFields as paintFields, waitForAssets } from './content/renderer.js';

const readViewport = () => ({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1 });
const storagePrefix = 'anamorphic:calibration:v1:';
let viewport = readViewport(), P = markerLayout(viewport), calibration = null, sessionId = null;
let config, resizeTimer, idleTimer, forceRecalibration = false, link, revision = 0, smoothed, pairing = false, syncing = false, needsConfigure = false;
const sessionKey = 'anamorphic:display-session:v2';
let mode = 'calibrating', warped = true, warpResult, rasterGeneration = 0, objectURL;
const tuning = { scale: 0.9, offset: { x: 0, y: 0 }, width: 960, height: 600, font: 76, optimizeCenter: false, alignScreen: false };
let phonePeers = { capture: 0, streaming: false }, streamTimer, summaryAt = 0;
const contentKey = 'anamorphic:content:v1';
let contentConfig = validateContent(SAMPLE_CONFIG), contentFields = contentConfig.config.fields, contentRuntime, controllerToken = '', contentDisplayKey = '', freshSession = false, restoredContent = false, qrObjectURL, lastContentStatus;
let currentContentStatus = { state: 'loading' };
function temporaryGet(key) { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } }
function temporarySet(key, value) { try { sessionStorage.setItem(key, value); } catch { /* This tab can still keep the token in memory. */ } }
const contentPanel = new ContentPanel($('#content-panel'), {
  display: true, editable: () => !!controllerToken,
  apply: value => link.command('content_config', { contentConfig: value, controllerToken }),
  preview: previewContent,
  saveSecret: value => api(`/api/session/${sessionId}/content/secrets`, { ...json(value), method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Controller-Token': controllerToken, 'X-Content-Display-Key': contentDisplayKey } })
});
function contentStatus(value) {
  const labels = { loading: 'Đang tải', ready: 'Sẵn sàng', stale: 'Dữ liệu cũ', error: 'Lỗi nguồn' };
  $('#content-status').textContent = `Nội dung: ${labels[value.state] || value.state}`;
  $('#content-status').dataset.state = value.state; $('#content-status').title = value.reason || '';
}
function reportContentStatus(value) {
  currentContentStatus = value; contentStatus(value);
  if (controllerToken && !isServerSource(contentConfig) && contentConfig.adapterId !== 'manual' && JSON.stringify(value) !== JSON.stringify(lastContentStatus)) {
    if (link?.send({ type: 'content_status', ...value, contentRevision: contentConfig.contentRevision, controllerToken })) lastContentStatus = value;
  }
}
function renderFields(fields = contentFields) {
  contentFields = fields;
  paintFields($('#content'), fields, contentConfig, { localImage: objectURL });
  $('#debug-grid').hidden = !$('#debug').checked;
  if ($('#poster-art')) $('#poster-art').hidden = tuning.width < 700;
  scheduleRaster();
}
function activateContent(raw) {
  const next = validateContent(raw); contentRuntime?.stop(); contentConfig = next; lastContentStatus = null;
  if (next.contentRevision > 0) restoredContent = true;
  contentPanel.load(next); storedSet(contentKey, JSON.stringify(next));
  $('#raster-mode').disabled = next.adapterId === 'iframe';
  if (next.adapterId === 'iframe') $('#raster-mode').checked = false;
  $('#image-picker').disabled = next.adapterId !== 'manual';
  renderFields();
  contentRuntime = createContent(next);
  contentRuntime.start({ onData: renderFields, onStatus: reportContentStatus });
}
function receiveContent(data) {
  if (data.contentConfig) {
    if (freshSession && restoredContent && data.contentConfig.contentRevision === 0) {
      freshSession = false;
      link.command('content_config', { contentConfig: { ...contentConfig, contentRevision: 0 }, controllerToken }).catch(error => contentPanel.notice(error.message));
      return;
    }
    freshSession = false;
    if (JSON.stringify(data.contentConfig) !== JSON.stringify(contentConfig)) activateContent(data.contentConfig);
  }
  const packet = data.type === 'content_data' ? data : data.contentData;
  if (packet?.contentRevision === contentConfig.contentRevision && (isServerSource(contentConfig) || contentConfig.adapterId === 'manual')) contentRuntime?.push(packet.fields);
  const state = data.type === 'content_status' ? data : data.contentStatus;
  if (state?.contentRevision === contentConfig.contentRevision && isServerSource(contentConfig)) contentRuntime?.status(state);
}
async function previewContent(value) {
  if (isServerSource(value)) return (await api(`/api/session/${sessionId}/content/preview`, { ...json(value), headers: { 'Content-Type': 'application/json', 'X-Controller-Token': controllerToken } })).fields;
  const instance = createContent(value);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { instance.stop(); reject(new Error('Chưa nhận dữ liệu sau 8 giây.')); }, 8000);
      instance.start({ onData: fields => { clearTimeout(timeout); resolve(value.adapterId === 'iframe' ? { ghiChu: 'Trang nhúng không hỗ trợ trích xuất; nhiều website chặn nhúng.' } : fields); },
        onStatus: state => { if (state.state === 'error') { clearTimeout(timeout); reject(new Error(state.reason)); } } });
    });
  } finally { instance.stop(); }
}

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
function pairingState(peers = phonePeers) {
  phonePeers = peers;
  connection(!peers.capture ? 'Chưa có điện thoại' : peers.streaming ? 'Camera đang gửi' : 'Điện thoại đã kết nối', !!peers.capture);
}
function streaming(active) {
  clearTimeout(streamTimer);
  pairingState({ ...phonePeers, streaming: active });
  if (active) streamTimer = setTimeout(() => pairingState({ ...phonePeers, streaming: false }), 2000);
}
function applied(data, ok, reason = '') {
  link?.send({ type: 'display_applied', revision: data.revision, seq: data.seq, calibrationId: data.calibrationId, ok, reason });
  $('#calibration-error').hidden = ok;
  const message = `Không áp dụng được hiệu chuẩn: ${reason} Giữ kết quả hợp lệ gần nhất.`;
  if (!ok && $('#calibration-error').textContent !== message) $('#calibration-error').textContent = message;
}
function announceLive(data) {
  const summary = `Vừa thấy ${data.detected}/4 marker, đã nhớ ${data.tracked || 0}/4. ${data.stable ? 'Điểm ổn định.' : 'Giữ camera cố định.'}`;
  if (performance.now() - summaryAt >= 2000 && $('#live-summary').textContent !== summary) {
    $('#live-summary').textContent = summary; summaryAt = performance.now();
  }
}

function renderMarkers() {
  $('#markers').replaceChildren();
  const side = markerBlackSide(viewport);
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
  const visible = next === 'display' || next === 'live';
  document.body.dataset.state = next;
  $('#calibration-card').hidden = visible;
  $('#markers').hidden = next === 'display';
  $('#warp').hidden = !visible;
  $('#live-hud').hidden = next !== 'live';
  $('#pair-button').hidden = !visible;
  $('#preview').hidden = visible;
  $('#controls-toggle').hidden = !visible;
  $('#uncalibrated').hidden = !!calibration;
  if (!visible) { $('#controls').hidden = true; $('#controls-toggle').setAttribute('aria-expanded', 'false'); }
  $('#footer-note').textContent = next === 'live' ? 'Giữ camera tại vị trí mắt · Chốt trên điện thoại' : next === 'display' ? (calibration ? 'Điểm nhìn đã khóa · Hiệu chỉnh lại không cần quét QR' : 'Nội dung mẫu · Chưa hiệu chuẩn') : 'Quét QR một lần · Giữ phiên để hiệu chỉnh lại';
  if (!visible) $('#debug-outline').setAttribute('hidden', '');
  revealChrome();
}

function remember() {
  if (!calibration || mode !== 'display') return;
  const key = viewportKey(viewport);
  storedSet(storagePrefix + key, JSON.stringify({ ...calibration, ...tuning, savedAt: Date.now() }));
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
  $('#optimize-center').checked = tuning.optimizeCenter; $('#align-screen').checked = tuning.alignScreen;
}

function measureLayout() {
  const content = $('#content'), wrap = $('#warp');
  content.style.width = wrap.style.width = `${tuning.width}px`;
  content.style.height = wrap.style.height = `${tuning.height}px`;
  content.style.setProperty('--content-font', `${tuning.font}px`);
  if ($('#poster-art')) $('#poster-art').hidden = tuning.width < 700;
  $('#debug-grid').hidden = !$('#debug').checked;
  wrap.style.willChange = $('#gpu-mode').checked ? 'transform' : 'auto';
}
function updateWarp() {
  if (calibration) {
    warpResult = computeWarp({ ...calibration, ...tuning });
    $('#compression-warning').hidden = warpResult.compression >= 0.35;
  } else { warpResult = null; $('#compression-warning').hidden = true; }
  paintTransform();
}
function saveSettings() { remember(); }

function paintTransform() {
  const wrap = $('#warp');
  if (warped && warpResult) wrap.style.transform = warpResult.css;
  else {
    const scale = Math.min(viewport.vw * 0.84 / tuning.width, viewport.vh * 0.74 / tuning.height) * tuning.scale;
    const x = (viewport.vw - tuning.width * scale) / 2, y = (viewport.vh - tuning.height * scale) / 2;
    wrap.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
  }
  $('#warp-toggle').setAttribute('aria-pressed', String(warped));
  $('#warp-toggle').replaceChildren(document.createTextNode(`Bù góc: ${warped ? 'Bật' : 'Tắt'} `));
  const kbd = document.createElement('kbd'); kbd.textContent = 'W'; $('#warp-toggle').append(kbd);
  $('#debug-outline').toggleAttribute('hidden', !($('#debug').checked && warpResult && warped && ['display', 'live'].includes(mode)));
  if (warpResult) $('#debug-outline polygon').setAttribute('points', warpResult.S.map(p => p.join(',')).join(' '));
  $('#live-compression').textContent = warpResult ? `Nén: ${Math.round(warpResult.compression * 100)}%` : 'Nén: —';
  const accuracy = !warpResult ? 'Sai số: —' : warpResult.reprojectionError == null ? 'Sai số: — (4 tâm)' : `Sai số: ${warpResult.reprojectionError.toFixed(2)} px · ${warpResult.correspondenceCount} góc`;
  $('#live-reprojection').textContent = accuracy;
  $('#calibration-quality').textContent = warpResult ? `${accuracy} · Góc xoay camera: ${warpResult.roll.toFixed(1)}°${reprojectionWarning(warpResult) ? ` · ${reprojectionWarning(warpResult)}` : ''}` : 'Chưa có hiệu chuẩn.';
  $('#calibration-quality').classList.toggle('error', !!warpResult && !reprojectionAcceptable(warpResult.reprojectionError));
  $('#compression-warning').hidden = !warpResult || warpResult.compression >= 0.35;
}

function safeRender() { try { measureLayout(); updateWarp(); syncControls(); saveSettings(); scheduleRaster(); } catch (error) { toast(error.message); } }
let rasterTimer, rasterBusy = false, rasterDirty = false, rasterLastAt = -Infinity;
function scheduleRaster() {
  if (!$('#raster-mode').checked || mode !== 'display' || contentConfig.adapterId === 'iframe') {
    rasterGeneration++; clearTimeout(rasterTimer); rasterTimer = null; rasterDirty = false;
    $('#content').hidden = false; $('#raster').hidden = true; return;
  }
  rasterDirty = true;
  if (rasterBusy || rasterTimer) return;
  // Render an untransformed clone: rasterising the warped element would apply G twice.
  rasterTimer = setTimeout(async () => {
    rasterTimer = null; rasterBusy = true; rasterDirty = false; rasterLastAt = performance.now();
    const generation = rasterGeneration;
    const { width, height } = tuning;
    let host;
    try {
      if (!window.html2canvas) throw new Error('Chưa tải được bộ render canvas.');
      if (tuning.width * tuning.height * 4 > 20_000_000) throw new Error('Canvas 2× cần vùng nội dung dưới 5 triệu pixel. Hãy giảm kích thước.');
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none';
      const clone = $('#content').cloneNode(true); clone.hidden = false;
      host.append(clone); document.body.append(host);
      await waitForAssets(clone);
      const rendered = await window.html2canvas(clone, { scale: 2, useCORS: true, imageTimeout: 5000, logging: false, backgroundColor: null, width, height, windowWidth: Math.max(innerWidth, width) });
      if (generation !== rasterGeneration || !$('#raster-mode').checked || mode !== 'display') return;
      const canvas = $('#raster'); canvas.width = rendered.width; canvas.height = rendered.height;
      canvas.getContext('2d').drawImage(rendered, 0, 0);
      canvas.hidden = false; $('#content').hidden = true;
    } catch (error) {
      if (generation === rasterGeneration) { $('#raster-mode').checked = false; $('#content').hidden = false; $('#raster').hidden = true; toast(error.message); }
    } finally { host?.remove(); rasterBusy = false; if (rasterDirty) scheduleRaster(); }
  }, Math.max(0, 650 - (performance.now() - rasterLastAt)));
}

function showContent() {
  setMode('display');
  try { measureLayout(); updateWarp(); syncControls(); scheduleRaster(); } catch (error) {
    calibration = null; setMode('calibrating'); status(error.message, false, true);
  }
}

function captureURL() {
  const base = new URL($('#server-url').value);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Dùng URL HTTP hoặc HTTPS hợp lệ.');
  const url = new URL(`/capture/${sessionId}`, base);
  if (controllerToken) url.hash = new URLSearchParams({ k: controllerToken }).toString();
  return url.href;
}
async function updateQR() {
  if (!sessionId) return;
  const url = captureURL();
  const target = new URL(url), local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  $('#camera-security').hidden = target.protocol !== 'http:' || local;
  const image = $('#qr');
  image.onload = () => { image.hidden = false; $('#qr-loading').hidden = true; };
  image.onerror = () => { image.hidden = true; $('#qr-loading').hidden = true; status('Không tạo được QR. Hãy thử lại phiên.', false, true); };
  image.dataset.sessionId = sessionId;
  try {
    if (controllerToken) {
      const response = await fetch(`/api/session/${sessionId}/qr`, { ...json({ url }), headers: { 'Content-Type': 'application/json', 'X-Controller-Token': controllerToken } });
      if (!response.ok) throw new Error('Không tạo được QR điều khiển.');
      const previous = qrObjectURL; qrObjectURL = URL.createObjectURL(await response.blob()); image.src = qrObjectURL;
      if (previous) URL.revokeObjectURL(previous);
    } else image.src = `/api/session/${sessionId}/qr?url=${encodeURIComponent(url)}`;
  } catch (error) { status(error.message, false, true); }
  $('#copy-link').disabled = false;
  $('#copy-link').title = url;
  const hostname = new URL(url).hostname;
  $('#network-hint').textContent = ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
    ? 'localhost chỉ mở được trên máy tính. Hãy đổi sang IP LAN hoặc URL cổng đã chuyển tiếp để điện thoại truy cập.'
    : location.hostname.endsWith('.app.github.dev') ? 'Trong Codespaces, điện thoại phải truy cập được cổng chuyển tiếp này (đăng nhập GitHub nếu cổng để riêng tư).' : 'Điện thoại cần cùng LAN/Wi-Fi và truy cập được cổng server này.';
}

function liveWarning(text = '') { $('#live-warning').textContent = text; $('#live-warning').classList.toggle('error', !!text); }

function receive(data) {
  receiveContent(data);
  if (data.type.startsWith('content_')) return;
  if (data.type === 'peers') { phonePeers = data; streaming(data.streaming); }
  if (data.type === 'connected') {
    if (!isServerSource(contentConfig) && contentConfig.adapterId !== 'manual') {
      lastContentStatus = null; reportContentStatus(currentContentStatus);
    }
    phonePeers = data.peers; streaming(data.peers.streaming);
    if ($('#qr').hidden) updateQR();
    if (needsConfigure || viewportKey(data.viewport) !== viewportKey(viewport)) { configure(true); return; }
    revision = data.revision;
    if (data.mode === 'live') enterLive(data);
    else if (data.mode === 'display' && data.result) applyCalibration(data.result);
    else if (!calibration || data.revision > 1) setMode('calibrating');
  }
  if (data.type === 'live_started') {
    if (viewportKey(data.viewport) !== viewportKey(viewport)) return;
    revision = data.revision; enterLive(data);
  }
  if (data.type === 'capture_started') {
    revision = data.revision; smoothed = null; setMode('calibrating'); status('Chụp ảnh hoặc chọn điểm trên điện thoại.');
  }
  if (data.type === 'live_points' && !syncing && data.revision === revision) {
    streaming(true); announceLive(data);
    $('#live-detected').textContent = `${data.detected ?? 4}/4 marker`; $('#live-tracked').textContent = `Nhớ ${data.tracked ?? 4}/4`; $('#live-fps').textContent = `${data.fps.toFixed(1)} fps`;
    $('#live-detection').textContent = data.detectionMs == null ? 'Dò: —' : `Dò: ${data.detectionMs.toFixed(1)} ms`;
    try {
      const candidate = { viewport, P, Q: data.Q, points: data.points, imageSize: data.imageSize };
      validateCalibration(data.Q.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), data.imageSize, viewport, P);
      computeWarp({ ...candidate, ...tuning }); // Reject bad raw frames before smoothing.
      // Temporal packets already contain the latest observation of each ID.
      // Render that frame directly so unseen corners never drift via EMA.
      const next = data.algorithm === 'temporal' ? { Q: data.Q, points: data.points, imageSize: data.imageSize } : emaFrame(smoothed, data);
      const nextCalibration = { viewport, P, ...next };
      const nextWarp = computeWarp({ ...nextCalibration, ...tuning });
      smoothed = next; calibration = nextCalibration; warpResult = nextWarp;
      if (mode !== 'live') { setMode('live'); measureLayout(); paintTransform(); } else paintTransform();
      liveWarning(reprojectionWarning(nextWarp) || data.warning || '');
      applied(data, true);
    } catch (error) { liveWarning(`${error.message} Giữ kết quả hợp lệ gần nhất.`); applied(data, false, error.message); }
  }
  if (data.type === 'live_status' && data.revision === revision) {
    streaming(!!data.imageSize); announceLive(data);
    $('#live-detected').textContent = `${data.detected}/4 marker`; $('#live-tracked').textContent = `Nhớ ${data.tracked || 0}/4`; $('#live-fps').textContent = `${data.fps.toFixed(1)} fps`; liveWarning(data.warning);
    $('#live-detection').textContent = data.detectionMs == null ? 'Dò: —' : `Dò: ${data.detectionMs.toFixed(1)} ms`;
  }
  if (data.type === 'photo_received') { setMode('waiting'); status('Đã nhận ảnh · Đang nhận diện 4 marker…', true); }
  if (data.type === 'photo_status' && data.revision === revision) status(data.state === 'queued' ? `Ảnh đang xếp hàng · vị trí ${data.position}` : 'Đang nhận diện marker…', true);
  if (data.type === 'detect_failed' && (!data.revision || data.revision === revision)) { setMode('calibrating'); status(data.reason || 'Hãy chọn điểm thủ công trên điện thoại.'); }
  if (data.type === 'calibrated' && !syncing && data.revision === revision) applyCalibration(data);
}

function applyCalibration(data) {
  const candidate = { viewport, P, Q: data.Q, points: data.points, imageSize: data.imageSize };
  try {
    validateCalibration(data.Q.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), data.imageSize, viewport, P);
    computeWarp({ ...candidate, ...tuning });
  }
  catch (error) { liveWarning(`${error.message} Giữ kết quả hợp lệ gần nhất.`); applied(data, false, error.message); return; }
  calibration = candidate; smoothed = null; warped = true;
  $('#viewport-notice').hidden = true;
  showContent();
  saveSettings();
  streaming(false); applied(data, true);
}
function enterLive(data) {
  smoothed = null;
  if (data.result && !calibration) {
    try { const candidate = { viewport, P, ...data.result }; computeWarp({ ...candidate, ...tuning }); calibration = candidate; } catch { /* Wait for the first good frame. */ }
  }
  setMode('live'); safeRender();
  $('#live-detected').textContent = '0/4 marker'; $('#live-tracked').textContent = 'Nhớ 0/4'; $('#live-fps').textContent = '0 fps';
  liveWarning(data.reason === 'viewport_changed' ? 'Viewport đã đổi. Giữ camera mở để hiệu chỉnh lại trong cùng phiên.' : 'Mở camera trên điện thoại đã ghép đôi. Không cần quét lại QR.');
}
async function configure(force = false) {
  needsConfigure ||= force;
  if (!link?.open) return;
  const requestedViewport = viewport;
  syncing = true;
  try {
    const ack = await link.command('configure', { viewport: requestedViewport, markers: P, force: needsConfigure });
    if (viewportKey(requestedViewport) === viewportKey(viewport)) { revision = ack.revision; needsConfigure = false; }
  }
  catch (error) { status(error.message, false, true); }
  finally { syncing = false; }
}
async function beginCalibration() {
  if (!sessionId) { await pair(); return; }
  try { await link.command('start_live'); }
  catch (error) { toast(error.message); }
}
async function pair() {
  if (pairing) return;
  pairing = true;
  try {
    const saved = storedGet(sessionKey);
    let data;
    if (saved) {
      sessionId = saved;
      try { data = await api(`/api/session/${saved}`); }
      catch (error) {
        if (error.status === 404) sessionId = null;
        else data = {}; // Reconnect the remembered session even if reload began offline.
      }
    }
    if (!data) {
      const created = await api('/api/session', json({ viewport, markers: P })); sessionId = created.sessionId;
      controllerToken = created.controllerToken; contentDisplayKey = created.contentDisplayKey; freshSession = true;
      temporarySet(`anamorphic:controller:${sessionId}`, controllerToken); temporarySet(`anamorphic:content-display:${sessionId}`, contentDisplayKey);
    } else { controllerToken = temporaryGet(`anamorphic:controller:${sessionId}`); contentDisplayKey = temporaryGet(`anamorphic:content-display:${sessionId}`); }
    storedSet(sessionKey, sessionId);
    $('#new-content-session').hidden = !!controllerToken;
    $('#session-label').textContent = `PHIÊN ${sessionId.slice(0, 8).toUpperCase()}`;
    updateQR(); link?.stop();
    link = new SessionConnection(sessionId, 'display', { message: receive,
      state: state => { if (state === 'open') pairingState(); else { clearTimeout(streamTimer); connection('Đang kết nối lại'); } },
      expired: () => { sessionId = null; storedSet(sessionKey, ''); status('Phiên đã hết hạn sau khi cả hai thiết bị rời đi. Đang tạo phiên mới…'); pair(); }
    });
    status('Sẵn sàng · Ghép đôi một lần, hiệu chỉnh nhiều lần');
  } catch (error) { connection('Chưa kết nối'); status(error.message, false, true); }
  finally { pairing = false; }
}

function invalidate(force = false) {
  forceRecalibration ||= force;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const forced = forceRecalibration; forceRecalibration = false;
    if (!forced && viewportKey(readViewport()) === viewportKey(viewport)) return;
    $('#viewport-notice').textContent = 'Kích thước hiển thị hoặc chế độ toàn màn hình đã đổi. Hãy chụp lại để hiệu chuẩn.';
    $('#viewport-notice').hidden = false;
    viewport = readViewport(); P = markerLayout(viewport); calibration = null; smoothed = null; renderMarkers();
    setMode('live'); safeRender(); configure(true);
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

// Keep fixed panels above the footer even when its buttons wrap to several rows.
new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--footer-h', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`))
  .observe(document.querySelector('.display-footer'));

function revealChrome() {
  document.body.classList.remove('idle'); clearTimeout(idleTimer);
  if (mode === 'display' && $('#controls').hidden && $('#content-controls').hidden) idleTimer = setTimeout(() => {
    if (!document.activeElement?.closest('.chrome')) document.body.classList.add('idle');
  }, 4500);
}
function toggleControls(open = $('#controls').hidden) {
  if (open) { $('#content-controls').hidden = true; $('#content-toggle').setAttribute('aria-expanded', 'false'); }
  $('#controls').hidden = !open; $('#controls-toggle').setAttribute('aria-expanded', String(open)); revealChrome();
}
addEventListener('pointermove', revealChrome); addEventListener('pointerdown', revealChrome); addEventListener('focusin', revealChrome);
addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches('input,textarea,select,[contenteditable]')) return;
  revealChrome();
  const key = event.key.toLowerCase();
  if (key === 'f') fullscreen();
  if (key === 'c' && ['display', 'live'].includes(mode)) toggleControls();
  if (key === 'w' && ['display', 'live'].includes(mode)) { warped = !warped; safeRender(); }
  if (key === 'd' && ['display', 'live'].includes(mode)) { $('#debug').checked = !$('#debug').checked; safeRender(); }
  if (key === 'escape') toggleControls(false);
  if (key === '?') $('#shortcut-help').click();
});
$('#fullscreen').onclick = fullscreen;
$('#content-toggle').onclick = () => {
  const open = $('#content-controls').hidden; $('#content-controls').hidden = !open;
  if (open) { $('#controls').hidden = true; $('#controls-toggle').setAttribute('aria-expanded', 'false'); }
  $('#content-toggle').setAttribute('aria-expanded', String(open)); revealChrome();
};
$('#content-close').onclick = () => { $('#content-controls').hidden = true; $('#content-toggle').setAttribute('aria-expanded', 'false'); };
$('#new-content-session').onclick = () => { storedSet(sessionKey, ''); pair(); };
$('#shortcut-help').onclick = () => { const dialog = $('#shortcut-dialog'); if (dialog.open) dialog.close(); else dialog.showModal(); };
$('#shortcut-close').onclick = () => $('#shortcut-dialog').close();
$('#image-picker').onclick = () => $('#image-input').click();
$('#controls-toggle').onclick = () => toggleControls(); $('#controls-close').onclick = () => toggleControls(false);
$('#preview').onclick = () => { if (!restoredContent && contentConfig.contentRevision === 0) activateContent(SAMPLE_CONFIG); showContent(); toggleControls(true); };
$('#recalibrate').onclick = () => { $('#viewport-notice').hidden = true; beginCalibration(); };
$('#start-live').onclick = () => beginCalibration();
$('#pair-button').onclick = () => { $('#calibration-card').hidden = !$('#calibration-card').hidden; };
$('#retry').onclick = () => { if (link?.open) configure(); else pair(); };
$('#warp-toggle').onclick = () => { warped = !warped; safeRender(); };
$('#reset-position').onclick = () => { tuning.scale = 0.9; tuning.offset = { x: 0, y: 0 }; safeRender(); };
$('#scale').oninput = event => { tuning.scale = Number(event.target.value); safeRender(); };
for (const axis of ['x', 'y']) $(`#offset-${axis}`).oninput = event => { tuning.offset[axis] = Number(event.target.value); safeRender(); };
for (const [selector, property] of [['#content-width', 'width'], ['#content-height', 'height']]) $(selector).onchange = event => {
  if (!event.target.checkValidity()) { toast('Kích thước nội dung từ 100 đến 4000 px.'); syncControls(); return; }
  tuning[property] = Number(event.target.value); safeRender();
};
$('#font-size').oninput = event => { tuning.font = Number(event.target.value); safeRender(); };
for (const selector of ['#debug', '#raster-mode', '#gpu-mode']) $(selector).onchange = safeRender;
for (const [selector, property] of [['#optimize-center', 'optimizeCenter'], ['#align-screen', 'alignScreen']]) $(selector).onchange = event => {
  tuning[property] = event.target.checked; safeRender();
};
$('#image-input').onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast('Hãy chọn ảnh dưới 20 MB.'); return; }
  const url = URL.createObjectURL(file);
  const previous = objectURL;
  try { const probe = new Image(); probe.src = url; await probe.decode(); }
  catch { URL.revokeObjectURL(url); toast('Không đọc được ảnh này. Hãy dùng JPEG/PNG/WebP.'); return; }
  objectURL = url; if (previous) URL.revokeObjectURL(previous);
  $('#remove-image').hidden = false; renderFields();
};
$('#remove-image').onclick = () => {
  if (objectURL) URL.revokeObjectURL(objectURL); objectURL = null;
  $('#remove-image').hidden = true; $('#image-input').value = ''; renderFields();
};
$('#apply-url').onclick = () => {
  try { updateQR(); storedSet('anamorphic:server-url', $('#server-url').value); toast('Đã cập nhật QR cho địa chỉ mới.'); }
  catch (error) { toast(error.message); }
};
$('#copy-link').onclick = async () => {
  try { await copyText(captureURL()); toast('Đã sao chép đường dẫn chụp ảnh.'); } catch (error) { toast(error.message); }
};

async function boot() {
  try { const saved = storedGet(contentKey); if (saved) { contentConfig = validateContent(JSON.parse(saved)); restoredContent = true; } } catch { toast('Cấu hình nội dung cũ không hợp lệ; đang dùng mẫu.'); }
  activateContent(contentConfig);
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
      calibration = { viewport: record.viewport, P: record.P, Q: record.Q, points: record.points, imageSize: record.imageSize };
      for (const prop of ['scale', 'width', 'height', 'font']) if (Number.isFinite(record[prop])) tuning[prop] = record[prop];
      if (record.offset) tuning.offset = record.offset;
      for (const prop of ['optimizeCenter', 'alignScreen']) if (typeof record[prop] === 'boolean') tuning[prop] = record[prop];
      showContent();
    }
  } catch { toast('Bản hiệu chuẩn cũ không hợp lệ. Hãy chụp lại.'); }
  const previous = storedGet('anamorphic:last-viewport');
  if (previous && previous !== viewportKey(viewport)) {
    $('#viewport-notice').textContent = 'Bản lưu dùng kích thước màn hình khác. Cần hiệu chuẩn cho viewport hiện tại.';
    $('#viewport-notice').hidden = false;
  }
  pair();
}
boot();
// Expose the footer height so floating panels never cover footer actions.
new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--footer-h', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`)).observe($('.display-footer'));
