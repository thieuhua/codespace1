import { $, api, json } from '/assets/utils.js';
import { MARKER_IDS, validateCalibration, computeWarp, reprojectionAcceptable, reprojectionWarning } from '/shared/calibration.js';
import { markerStability } from '/shared/temporal-markers.js';
import { SessionConnection } from '/assets/connection.js';
import { Camera } from './camera.js';
import { LensUI } from './lens-ui.js';
import { ContentPanel } from '/assets/content-panel.js';
import { isServerSource } from '/shared/content/schema.js';
import { create as createContent } from '/display/content/runtime.js';

const sessionId = location.pathname.split('/').filter(Boolean)[1] || null;
const base = `/api/session/${encodeURIComponent(sessionId)}`;
const sessionKey = 'anamorphic:capture-session:v2';
let link, sessionState, attemptedCamera = false, cameraAllowed = false, startingLive = false, resumeOnVisible = false, freezing = false, seq = 0, pendingFrame, latestFrame = null, trackedCount = 0, lastSeq = 0, ticks = [];
let photo, image, points = [], manual = false, busy = false, activePointer = null, pointerPoint;
let keyboardPoint = [0, 0];
let lensChanging = false, cameraDirty = false;
let serverFrame, stable = false, displayApplied, announcementAt = 0, recoveringPhoto = false;
const canvas = $('#photo-canvas'), context = canvas.getContext('2d');
const labels = ['1 · trên trái', '2 · trên phải', '3 · dưới phải', '4 · dưới trái'];
const tokenKey = `anamorphic:controller:${sessionId}`;
let controllerToken = new URLSearchParams(location.hash.slice(1)).get('k') || '';
try {
  if (controllerToken) { sessionStorage.setItem(tokenKey, controllerToken); history.replaceState(null, '', location.pathname + location.search); }
  else controllerToken = sessionStorage.getItem(tokenKey) || '';
} catch { /* The fragment or this tab's memory remains sufficient. */ }
const contentPanel = new ContentPanel($('#content-panel'), {
  editable: () => !!controllerToken,
  apply: value => link.command('content_config', { contentConfig: value, controllerToken }),
  preview: async value => {
    if (isServerSource(value)) return (await api(`${base}/content/preview`, { ...json(value), headers: { 'Content-Type': 'application/json', 'X-Controller-Token': controllerToken } })).fields;
    const instance = createContent(value);
    try { return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { instance.stop(); reject(new Error('Chưa nhận dữ liệu sau 8 giây.')); }, 8000);
      instance.start({ onData: fields => { clearTimeout(timeout); resolve(fields); }, onStatus: state => { if (state.state === 'error') { clearTimeout(timeout); reject(new Error(state.reason)); } } });
    }); } finally { instance.stop(); }
  }
});
function contentState(data) {
  if (data.contentConfig) contentPanel.load(data.contentConfig);
  const state = data.type === 'content_status' ? data : data.contentStatus;
  if (state) $('#content-status').textContent = `${({ loading: 'Đang tải', ready: 'Sẵn sàng', stale: 'Dữ liệu cũ', error: 'Lỗi nguồn' })[state.state]}${state.reason ? ` · ${state.reason}` : ''}`;
}

function status(text = '', error = false) {
  $('#status').hidden = !text;
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}
function show(section) {
  document.body.classList.toggle('camera-active', section === 'camera');
  for (const id of ['capture', 'camera', 'review', 'done', 'expired']) $(`#${id}-section`).hidden = id !== section;
  const progress = section === 'camera' ? 0 : ['capture', 'review', 'done'].indexOf(section);
  for (const [index, step] of ['photo', 'review', 'done'].entries()) $(`#step-${step}`).classList.toggle('active', index <= progress);
  $('#status').hidden = true;
}
function setBusy(value) {
  busy = value; $('#photo-input').disabled = value;
  $('#photo-label').disabled = value;
  for (const id of ['confirm', 'manual', 'undo', 'retake']) $(`#${id}`).disabled = value;
  if (!value) updateReview();
}
function expired() { setBusy(false); show('expired'); $('#phone-content').hidden = true; $('#session-badge').textContent = 'PHIÊN ĐÃ HẾT HẠN'; }

function draw() {
  if (!image) return;
  context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
  const ratio = canvas.width / photo.imageSize.w;
  const dotRadius = Math.max(9, canvas.width / 85);
  points.forEach(p => {
    const x = p.x * ratio, y = p.y * canvas.height / photo.imageSize.h;
    context.beginPath(); context.arc(x, y, dotRadius, 0, Math.PI * 2);
    context.fillStyle = '#d4f879'; context.fill(); context.lineWidth = dotRadius / 5; context.strokeStyle = '#233019'; context.stroke();
    context.fillStyle = '#233019'; context.font = `bold ${dotRadius * 1.2}px monospace`; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(String(MARKER_IDS.indexOf(p.id) + 1), x, y + dotRadius / 20);
  });
  if (manual && document.activeElement === canvas && points.length < 4) {
    const x = keyboardPoint[0] * ratio, y = keyboardPoint[1] * canvas.height / photo.imageSize.h;
    context.strokeStyle = '#ff5a3c'; context.lineWidth = Math.max(2, canvas.width / 500);
    context.beginPath(); context.moveTo(x - dotRadius, y); context.lineTo(x + dotRadius, y); context.moveTo(x, y - dotRadius); context.lineTo(x, y + dotRadius); context.stroke();
  }
}

function updateReview() {
  const missing = MARKER_IDS.findIndex(id => !points.some(p => p.id === id));
  canvas.classList.toggle('manual', manual);
  $('#point-steps').hidden = !manual; $('#point-help').hidden = !manual;
  $('#manual').hidden = manual; $('#undo').hidden = !manual; $('#undo').disabled = busy || !points.length;
  $('#confirm').disabled = busy || points.length !== 4;
  document.querySelectorAll('[data-point]').forEach((node, i) => {
    node.classList.toggle('placed', points.some(p => p.id === MARKER_IDS[i])); node.classList.toggle('current', i === missing);
  });
  if (manual) $('#review-instruction').textContent = points.length < 4
    ? `Đã giữ ${points.length}/4 điểm. Chỉ cần chạm tâm marker còn thiếu: ${labels[missing]} theo nhãn trên ảnh.`
    : 'Đã chọn 4 tâm marker. Kiểm tra rồi nhấn “Đúng” để áp dụng.';
  else $('#review-instruction').textContent = 'Đã nhận diện đủ 4 marker và gửi kết quả lên máy tính. Kiểm tra các chấm trên ảnh; chọn “Chạm tay” nếu cần sửa.';
  draw();
  describePointer();
  let quality;
  try {
    if (points.length === 4 && sessionState?.viewport) quality = computeWarp({ viewport: sessionState.viewport, P: sessionState.markers,
      Q: MARKER_IDS.map(id => { const p = points.find(p => p.id === id); return [p.x, p.y]; }), points, imageSize: photo.imageSize });
  } catch { /* The point validator gives the actionable error on confirmation. */ }
  $('#review-reprojection').textContent = quality ? accuracy(quality) : '';
}

function accuracy(quality) {
  const text = quality.reprojectionError == null ? `Sai số: —${quality.correspondenceCount === 4 ? ' (4 tâm)' : ''}` : `Sai số: ${quality.reprojectionError.toFixed(2)} px · ${quality.correspondenceCount} góc`;
  const frozen = quality.freezeReprojectionError;
  return `${text}${frozen != null && Math.abs(frozen - quality.reprojectionError) > 0.01 ? ` · Sai số chốt: ${frozen.toFixed(2)} px` : ''}${Number.isFinite(quality.roll) ? ` · Góc xoay camera: ${quality.roll.toFixed(1)}°` : ''}${reprojectionWarning(quality) ? ` · ${reprojectionWarning(quality)}` : ''}`;
}

function describePointer() {
  $('#point-position').textContent = manual && points.length < 4
    ? `Con trỏ: x ${Math.round(keyboardPoint[0])}, y ${Math.round(keyboardPoint[1])} pixel trong ảnh. ${$('#review-instruction').textContent}` : '';
}

async function loadPhoto(data, source) {
  photo = data; manual = false;
  const nextImage = new Image(); nextImage.src = source;
  await nextImage.decode();
  image = nextImage; canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  points = MARKER_IDS.map(id => data.points?.find(p => p.id === id)).filter(Boolean);
  keyboardPoint = [photo.imageSize.w / 2, photo.imageSize.h / 2];
  show('review');
  if (!data.ok) manual = true;
  updateReview();
  if (!data.ok) status(`${data.reason || 'Không tìm đủ marker.'} Đã giữ ${points.length}/4 điểm; chỉ đặt các điểm còn thiếu.`);
}

$('#photo-label').onclick = () => $('#photo-input').click();
$('#photo-input').onchange = async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || busy) return;
  if (file.size > 20 * 1024 * 1024) { status('Ảnh lớn hơn 20 MB. Hãy chọn ảnh nhỏ hơn.', true); return; }
  setBusy(true); status('Đang gửi ảnh gốc và nhận diện marker… Giữ nguyên cửa sổ máy tính.');
  camera.stop();
  const form = new FormData(); form.append('photo', file);
  try {
    const data = await api(`${base}/photo`, { method: 'POST', body: form });
    recoveringPhoto = false;
    await loadPhoto(data, data.previewUrl);
    $('#session-badge').textContent = 'ẢNH ĐÃ NHẬN';
  } catch (error) {
    if (error.status === 404) expired();
    else if (error.name === 'TimeoutError' || error.name === 'AbortError' || !error.status) {
      recoveringPhoto = true;
      status('Chưa nhận được phản hồi upload. Đang đồng bộ với server; kết quả đến muộn sẽ hiện tại đây.', true);
      link?.command('sync').catch(() => {});
    } else status(`${error.message} Bạn có thể chụp hoặc chọn ảnh khác.`, true);
  } finally { setBusy(false); }
};

$('#manual').onclick = () => { manual = true; points = []; status(); updateReview(); };
$('#undo').onclick = () => { if (!busy) { points.pop(); status(); updateReview(); } };
$('#confirm').onclick = async () => {
  if (busy || points.length !== 4) return;
  try { validateCalibration(points, photo.imageSize, sessionState?.viewport); } catch (error) { status(error.message, true); return; }
  setBusy(true); status('Đang áp dụng góc nhìn…');
  try {
    const result = await api(`${base}/points`, json({ points, photoId: photo.photoId }));
    sessionState.result = result;
    showDone();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    if (error.status === 404) expired();
    else status(error.message, true);
  } finally { setBusy(false); }
};
$('#retake').onclick = () => { goPhoto(); };
$('#review-again').onclick = () => { show('review'); updateReview(); };
$('#reload').onclick = () => location.reload();

function coordinate(event) {
  const rect = canvas.getBoundingClientRect();
  return [Math.max(0, Math.min(photo.imageSize.w - 1, (event.clientX - rect.left) / rect.width * photo.imageSize.w)),
    Math.max(0, Math.min(photo.imageSize.h - 1, (event.clientY - rect.top) / rect.height * photo.imageSize.h))];
}
function magnify(point, clientX, clientY) {
  const magnifier = $('#magnifier'), ctx = magnifier.getContext('2d');
  magnifier.hidden = false;
  const left = Math.max(8, Math.min(innerWidth - 148, clientX - 70));
  const top = clientY >= 180 ? clientY - 175 : Math.min(innerHeight - 148, clientY + 35);
  magnifier.style.left = `${left}px`; magnifier.style.top = `${top}px`;
  const x = point[0] / photo.imageSize.w * image.naturalWidth, y = point[1] / photo.imageSize.h * image.naturalHeight;
  const sample = 140 / 4 * image.naturalWidth / canvas.getBoundingClientRect().width;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 280, 280);
  ctx.drawImage(image, x - sample / 2, y - sample / 2, sample, sample, 0, 0, 280, 280);
  ctx.strokeStyle = '#dc4b22'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(115, 140); ctx.lineTo(165, 140); ctx.moveTo(140, 115); ctx.lineTo(140, 165); ctx.stroke();
  ctx.beginPath(); ctx.arc(140, 140, 6, 0, Math.PI * 2); ctx.stroke();
}
function place(point) {
  if (!manual || busy || points.length >= 4) return;
  points.push({ id: MARKER_IDS.find(id => !points.some(p => p.id === id)), x: point[0], y: point[1] });
  status(); updateReview();
}
canvas.onpointerdown = event => {
  if (!manual || busy || points.length >= 4 || !event.isPrimary || event.button !== 0) return;
  activePointer = event.pointerId; canvas.setPointerCapture(event.pointerId);
  pointerPoint = coordinate(event); keyboardPoint = pointerPoint;
  magnify(pointerPoint, event.clientX, event.clientY);
};
canvas.onpointermove = event => {
  if (event.pointerId !== activePointer) return;
  pointerPoint = coordinate(event); keyboardPoint = pointerPoint;
  magnify(pointerPoint, event.clientX, event.clientY);
};
canvas.onpointerup = event => {
  if (event.pointerId !== activePointer) return;
  activePointer = null; $('#magnifier').hidden = true; place(coordinate(event));
};
canvas.onpointercancel = () => { activePointer = null; $('#magnifier').hidden = true; };
canvas.onkeydown = event => {
  if (!manual || busy || points.length >= 4) return;
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); place(keyboardPoint); }
  else if (directions[event.key]) {
    event.preventDefault();
    const delta = directions[event.key], step = event.shiftKey ? 10 : 1;
    keyboardPoint = keyboardPoint.map((v, i) => Math.max(0, Math.min((i ? photo.imageSize.h : photo.imageSize.w) - 1, v + delta[i] * step)));
    draw(); describePointer();
  }
};
canvas.onfocus = draw; canvas.onblur = draw;

const camera = new Camera($('#camera-video'), {
  geometry: () => link?.open && sessionState?.mode === 'live' && !freezing && !lensChanging && !cameraDirty && !document.hidden
    ? { viewport: sessionState.viewport, markers: sessionState.markers, revision: sessionState.revision } : null,
  ready: mode => { cameraAllowed = true; $('#camera-warning').textContent = mode === 'qr' ? 'Hướng camera vào QR trên máy tính.' : 'Giữ camera tại vị trí mắt. Các marker được nhớ qua nhiều khung hình.'; },
  error: message => {
    if (!sessionId) { $('#camera-warning').textContent = message; $('#start-camera').hidden = true; }
    else goPhoto(message);
  },
  qr: value => join(value), frame: result => sendFrame(result),
  controls: state => lens.render(state), notice: text => lens.notice(text),
  changing: active => { lensChanging = active; if (active) resetFrames(); lens.busy(active); updateFreeze(); },
  changed: () => resetCameraCalibration(),
  preference: (() => { try { return JSON.parse(localStorage.getItem('anamorphic:camera:v1')) || {}; } catch { return {}; } })()
});
const lens = new LensUI(camera);

async function resetCameraCalibration() {
  if (!sessionId) return;
  cameraDirty = true; updateFreeze();
  if (!link?.open) { lens.notice('Đang đợi kết nối để bắt đầu lượt hiệu chỉnh với cấu hình camera mới.'); return; }
  await link.command('start_live');
  cameraDirty = false;
  lens.notice('Đã đổi camera. Đang gom lại bốn marker trong cùng phiên.');
  updateFreeze();
}

function resetFrames() {
  latestFrame = null; trackedCount = 0; ticks = []; freezing = false; lastSeq = 0;
  serverFrame = null; stable = false;
  camera.resetTracking();
  $('#phone-tracked').textContent = 'Nhớ 0/4';
  $('#phone-detection').textContent = 'Dò: —'; $('#phone-reprojection').textContent = 'Sai số: —';
  document.querySelectorAll('[data-memory-id]').forEach(node => { node.classList.remove('remembered', 'observed'); node.title = 'Chưa thấy'; });
  if (pendingFrame) { clearTimeout(pendingFrame.timer); pendingFrame.resolve({ ok: false, samples: 0 }); pendingFrame = null; }
  updateFreeze();
}
function updateFreeze() {
  $('#freeze').disabled = freezing || lensChanging || cameraDirty || !link?.open || !latestFrame || !stable;
  $('#freeze').textContent = freezing ? 'Đang chốt…' : stable ? 'Chốt · Ổn định' : trackedCount === 4 ? 'Đủ điểm · Chờ ổn định' : `Chốt · ${trackedCount}/4 điểm`;
}

function updateQuality() {
  if (!serverFrame || sessionState?.mode !== 'live') return;
  const elapsed = performance.now() - serverFrame.receivedAt;
  const stats = Object.fromEntries(MARKER_IDS.map(id => {
    const item = serverFrame.markerStats?.[id];
    return [id, item && { ...item, ageMs: item.ageMs === null ? null : item.ageMs + elapsed }];
  }));
  stable = markerStability(stats, serverFrame.maxAgeMs) && serverFrame.ready && reprojectionAcceptable(serverFrame.reprojectionError) &&
    reprojectionAcceptable(serverFrame.freezeReprojectionError) && elapsed < 2000 && !!latestFrame;
  $('#marker-quality').replaceChildren(...MARKER_IDS.map((id, i) => {
    const item = stats[id], node = document.createElement('li');
    node.textContent = item && item.ageMs !== null ? `${i + 1} (ID ${id}): ${(item.ageMs / 1000).toFixed(1)} s · ${item.sampleCount} mẫu · dao động ${item.jitter.toFixed(1)} px` : `${i + 1} (ID ${id}): chưa thấy`;
    node.classList.toggle('error', !!item && item.ageMs > serverFrame.maxAgeMs);
    return node;
  }));
  const stale = MARKER_IDS.filter(id => stats[id]?.ageMs === null || stats[id]?.ageMs > serverFrame.maxAgeMs);
  const summary = trackedCount < 4 ? `Đã nhớ ${trackedCount}/4 điểm. Tìm các marker còn thiếu.` : stale.length
    ? `Đủ điểm nhưng ID ${stale.join(', ')} đã cũ. Hướng camera vào các marker này lại.`
    : stable ? 'Đủ điểm và ổn định. Có thể Chốt.' : 'Đủ điểm, chưa ổn định. Giữ camera cố định, cần ít nhất 3 mẫu/ID và dao động không quá 4 px.';
  $('#phone-stability').textContent = stable ? 'Ổn định' : trackedCount === 4 ? 'Đủ điểm · Chưa ổn định' : 'Chưa đủ điểm';
  $('#camera-warning').textContent = serverFrame.reason || serverFrame.validationError || (serverFrame.ready ? summary : serverFrame.warning || summary);
  if (performance.now() - announcementAt >= 2000 && $('#camera-summary').textContent !== summary) {
    $('#camera-summary').textContent = summary; announcementAt = performance.now();
  }
  updateFreeze();
}
setInterval(updateQuality, 250);

function showDone() { show('done'); $('#review-again').hidden = !photo; renderApplied(); }
function renderApplied() {
  const result = sessionState?.result;
  const applied = displayApplied?.calibrationId === result?.calibrationId && displayApplied?.seq === undefined ? displayApplied : null;
  $('#done-heading').textContent = applied?.ok ? 'Góc nhìn đã được áp dụng.' : applied ? 'Máy tính từ chối hiệu chuẩn.' : 'Đang chờ máy tính xác nhận.';
  $('#done-eyebrow').textContent = applied?.ok ? 'ĐIỂM NHÌN ĐÃ KHÓA' : 'CHỜ XÁC NHẬN HIỂN THỊ';
  $('#done-description').textContent = applied?.ok ? 'Nhìn màn hình từ đúng vị trí camera vừa chốt.' : applied ? applied.reason : 'Đã gửi điểm lên server. Giữ trang máy tính mở để nhận xác nhận áp dụng.';
  if (result) $('#done-description').textContent += ` ${accuracy(result)}`;
  const rejected = displayApplied?.ok === false;
  $('#display-feedback').hidden = !rejected;
  const message = rejected ? `Máy tính từ chối hiệu chuẩn: ${displayApplied.reason || 'Phối cảnh không hợp lệ.'} Hãy hiệu chỉnh lại.` : '';
  if ($('#display-feedback').textContent !== message) $('#display-feedback').textContent = message;
}
async function startLive() {
  if (document.hidden) { resumeOnVisible = true; return; }
  if (startingLive) return;
  startingLive = true;
  attemptedCamera = true;
  try {
    if (!link?.open) throw new Error('Đang mất kết nối. Đợi nối lại phiên rồi mở camera.');
    if (sessionState.mode !== 'live') await link.command('start_live');
    show('camera'); $('#pair-form').hidden = true; $('#freeze').hidden = false;
    $('#camera-warning').textContent = 'Đang mở camera…';
    await camera.start('live');
  } catch (error) { status(error.message, true); }
  finally { startingLive = false; }
}
async function goPhoto(message = '') {
  resumeOnVisible = false;
  camera.stop(); resetFrames(); show('capture');
  if (link?.open && sessionState?.mode !== 'calibrating') {
    try { await link.command('fallback'); } catch (error) { if (!message) message = error.message; }
  }
  if (message) status(message, true);
}
function overlay(result) {
  const node = $('#camera-overlay'); node.width = result.imageSize.w; node.height = result.imageSize.h;
  const ctx = node.getContext('2d');
  result.points.forEach(p => {
    const fresh = result.updatedIds.includes(p.id);
    ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.fillStyle = fresh ? '#d4f879' : '#27391cbb'; ctx.fill(); ctx.strokeStyle = fresh ? '#27391c' : '#d4f879'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = fresh ? '#27391c' : '#d4f879'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(MARKER_IDS.indexOf(p.id) + 1), p.x, p.y);
  });
  document.querySelectorAll('[data-memory-id]').forEach(node => {
    const id = Number(node.dataset.memoryId), remembered = result.points.some(p => p.id === id), fresh = result.updatedIds.includes(id);
    node.classList.toggle('remembered', remembered); node.classList.toggle('observed', fresh);
    node.title = fresh ? 'Vừa thấy trong khung này' : remembered ? 'Dùng điểm đã nhớ từ khung trước' : 'Chưa thấy';
  });
}
async function sendFrame(result) {
  if (!link?.open || freezing || lensChanging || cameraDirty || result.revision !== sessionState?.revision || result.trackingEpoch !== camera.trackingEpoch || sessionState.mode !== 'live') return;
  const now = performance.now(); ticks.push(now); ticks = ticks.filter(t => now - t <= 1500);
  const fps = ticks.length > 1 ? (ticks.length - 1) * 1000 / (now - ticks[0]) : 0;
  $('#phone-detected').textContent = `${result.detected}/4 marker`; $('#phone-fps').textContent = `${fps.toFixed(1)} fps`;
  $('#phone-detection').textContent = `Dò: ${result.detectionMs.toFixed(1)} ms`;
  const nextSeq = ++seq;
  const packet = { type: result.observations.length ? 'live_points' : 'live_status', seq: nextSeq, revision: result.revision,
    points: result.observations, imageSize: result.imageSize, fps, detectionMs: result.detectionMs };
  const ack = await new Promise(resolve => {
    const timer = setTimeout(() => { if (pendingFrame?.seq === nextSeq) { pendingFrame = null; latestFrame = null; updateFreeze(); } resolve({ ok: false, reason: 'Mất xác nhận khung hình. Đang chờ kết nối.' }); }, 2000);
    pendingFrame = { seq: nextSeq, resolve, timer };
    if (!link.send(packet)) { clearTimeout(timer); pendingFrame = null; resolve({ ok: false }); }
  });
  if (result.revision !== sessionState?.revision || result.trackingEpoch !== camera.trackingEpoch) return;
  trackedCount = ack.tracked || 0;
  if (ack.points && ack.imageSize) overlay({ ...ack, updatedIds: ack.updatedIds || [] });
  $('#phone-tracked').textContent = `Nhớ ${trackedCount}/4`;
  latestFrame = null;
  $('#phone-reprojection').textContent = accuracy(ack);
  $('#phone-reprojection').classList.toggle('error', !reprojectionAcceptable(ack.reprojectionError) || !reprojectionAcceptable(ack.freezeReprojectionError));
  let validationError;
  if (ack.ok && ack.ready && ack.freezeQ) {
    try {
      const candidate = { Q: ack.freezeQ, points: ack.freezePoints, imageSize: ack.imageSize };
      validateCalibration(MARKER_IDS.map((id, i) => ({ id, x: candidate.Q[i][0], y: candidate.Q[i][1] })), candidate.imageSize, sessionState.viewport);
      const quality = computeWarp({ viewport: sessionState.viewport, P: sessionState.markers, ...candidate });
      $('#phone-reprojection').textContent = accuracy(quality);
      $('#phone-compression').textContent = `Nén: ${Math.round(quality.compression * 100)}% · Co giãn nhỏ nhất ${quality.minScale.toFixed(2)} px/px`;
      latestFrame = candidate; lastSeq = ack.lastSeq;
    } catch (error) { validationError = error.message; }
  }
  if (!latestFrame) $('#phone-compression').textContent = 'Nén: —';
  serverFrame = { ...ack, validationError, receivedAt: performance.now() };
  updateQuality();
}

function receive(data) {
  contentState(data);
  if (data.type.startsWith('content_')) return;
  if (['connected', 'snapshot', 'live_started', 'capture_started'].includes(data.type)) {
    const changed = sessionState?.revision !== data.revision;
    sessionState = data;
    displayApplied = data.displayApplied;
    renderApplied();
    if (changed || data.type === 'connected') resetFrames();
    if (data.type === 'live_started') cameraDirty = false;
    if (data.type === 'connected' && cameraDirty && camera.mode === 'live') resetCameraCalibration().catch(error => lens.notice(error.message));
    $('#session-badge').textContent = `PHIÊN ${sessionId.slice(0, 8).toUpperCase()}`;
    if (data.busy && data.mode === 'calibrating') { attemptedCamera = true; status('Server đang xử lý ảnh. Đang chờ đồng bộ kết quả…'); }
    else if (data.mode === 'display' && data.result) { camera.stop(); showDone(); }
    else if (data.type === 'live_started' && cameraAllowed && camera.mode !== 'live') startLive();
    else if (data.type === 'connected' && data.mode === 'live' && cameraAllowed && resumeOnVisible) startLive();
    else if (data.type === 'connected' && photo && data.mode === 'calibrating') { attemptedCamera = true; }
    else if (data.type === 'connected' && !attemptedCamera) startLive();
    else if (data.type === 'capture_started') { camera.stop(); show('capture'); }
    if (data.photo && !data.busy && (recoveringPhoto || data.type === 'snapshot')) {
      recoveringPhoto = false;
      loadPhoto(data.photo, data.photo.previewUrl).catch(error => status(error.message, true));
    }
  }
  if (data.type === 'frame_ack' && pendingFrame?.seq === data.seq) {
    const pending = pendingFrame; pendingFrame = null; clearTimeout(pending.timer); pending.resolve(data);
  }
  if (data.type === 'calibrated' && data.revision === sessionState?.revision) {
    if (data.calibrationId !== sessionState.result?.calibrationId) displayApplied = null;
    sessionState.mode = 'display'; sessionState.result = data;
    camera.stop(); resetFrames();
    if (data.source === 'live' || (!busy && !photo)) showDone();
    renderApplied();
  }
  if (data.type === 'display_applied' && data.revision === sessionState?.revision) {
    if (data.seq === undefined && data.calibrationId !== sessionState.result?.calibrationId) return;
    displayApplied = data; renderApplied();
  }
  if (data.type === 'photo_status' && data.revision === sessionState?.revision) {
    status(data.state === 'queued' ? `Ảnh đang xếp hàng · vị trí ${data.position}. Giữ trang này mở (tối đa khoảng 3 phút).` : 'Đang nhận diện marker trên server…');
  }
  if (data.type === 'photo_ready' && data.revision === sessionState?.revision && !busy) {
    recoveringPhoto = false;
    loadPhoto(data, data.previewUrl).catch(error => status(error.message, true));
  }
  if (data.type === 'detect_failed' && data.revision === sessionState?.revision && !busy) {
    status(data.reason || 'Không đọc được ảnh. Hãy thử lại.', true);
  }
}

$('#freeze').onclick = async () => {
  updateQuality();
  if (freezing || lensChanging || cameraDirty || !latestFrame || !stable) return;
  freezing = true; updateFreeze();
  try {
    if (pendingFrame) await new Promise(resolve => { const check = () => pendingFrame ? setTimeout(check, 10) : resolve(); check(); });
    updateQuality();
    if (!latestFrame || !stable) throw new Error('Điểm chưa ổn định hoặc đã cũ. Giữ camera mở và quan sát lại.');
    computeWarp({ viewport: sessionState.viewport, P: sessionState.markers, ...latestFrame });
    await link.command('freeze', { revision: sessionState.revision, lastSeq });
  } catch (error) { $('#camera-warning').textContent = error.message; }
  finally { freezing = false; updateFreeze(); }
};
$('#start-camera').onclick = startLive; $('#reopen-live').onclick = startLive;
$('#use-photo').onclick = () => goPhoto();
$('#clear-tracking').onclick = () => link?.command('start_live').catch(error => lens.notice(error.message));
function pauseCamera() {
  camera.stop(); resetFrames();
  if (link?.open) link.command('pause').catch(() => {});
}
$('#camera-stop').onclick = () => { resumeOnVisible = false; pauseCamera(); if (sessionId) { show('capture'); status('Camera đã tạm dừng. Nhấn mở camera để tiếp tục trong cùng phiên.'); } else location.href = '/capture'; };

function join(value) {
  try {
    const url = new URL(value, location.origin);
    if (!['http:', 'https:'].includes(url.protocol) || !/^\/capture\/[a-f0-9-]{36}$/.test(url.pathname) || url.username || url.password) throw new Error();
    camera.stop(); location.assign(url.href);
  } catch { $('#camera-warning').textContent = 'QR này không phải đường dẫn ghép đôi Anamorphic Screen.'; }
}
$('#pair-form').onsubmit = event => { event.preventDefault(); join($('#pair-url').value); };
addEventListener('pagehide', () => { resumeOnVisible = camera.mode === 'live'; camera.stop(); link?.stop(); });
addEventListener('pageshow', event => { if (event.persisted && sessionId) attachLink(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { resumeOnVisible = camera.mode === 'live'; pauseCamera(); }
  else if (sessionId && sessionState?.mode === 'live' && cameraAllowed && resumeOnVisible) { resumeOnVisible = false; startLive(); }
});

async function boot() {
  if (!sessionId) {
    let saved; try { saved = localStorage.getItem(sessionKey); } catch { /* Storage is optional. */ }
    if (saved && !new URLSearchParams(location.search).has('scan')) { location.replace(`/capture/${encodeURIComponent(saved)}`); return; }
    show('camera'); $('#pair-form').hidden = false; $('#freeze').hidden = true; $('#phone-metrics').hidden = true; $('#marker-memory').hidden = true; $('#use-photo').hidden = true;
    $('.progress').hidden = true;
    $('#camera-heading').textContent = 'Quét QR để ghép đôi.'; $('#camera-eyebrow').textContent = 'KẾT NỐI MÁY TÍNH';
    $('#camera-instruction').textContent = 'Hướng camera sau vào mã QR trên trang hiển thị. Bạn chỉ cần ghép đôi một lần.';
    await camera.start('qr'); return;
  }
  setBusy(true); status('Đang mở phiên hiệu chuẩn…');
  try {
    const session = await api(base);
    try { localStorage.setItem(sessionKey, sessionId); } catch { /* A direct capture URL still survives refresh. */ }
    sessionState = session;
    contentState(session); $('#phone-content').hidden = false;
    $('#session-badge').textContent = `PHIÊN ${sessionId.slice(0, 8).toUpperCase()}`;
    status();
    if (session.photo) await loadPhoto(session.photo, `${base}/photo?photoId=${session.photo.photoId}`);
    attachLink();
  } catch (error) {
    if (error.status === 404) expired();
    else { status(`Không kết nối được server: ${error.message}`, true); attachLink(); }
  } finally { setBusy(false); }
}
function attachLink() {
  link?.stop();
  link = new SessionConnection(sessionId, 'capture', { message: receive, expired,
    state: state => { if (state !== 'open') { resetFrames(); $('#session-badge').textContent = 'ĐANG NỐI LẠI'; $('#camera-warning').textContent = 'Mất kết nối. Các khung hình tạm dừng, phiên sẽ tự nối lại.'; } }
  });
}
boot();
