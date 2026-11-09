import { $, api, json, toast } from '/assets/utils.js';
import { MARKER_IDS, validatePoints, computeWarp } from '/shared/calibration.js';
import { SessionConnection } from '/assets/connection.js';
import { Camera } from './camera.js';
import { LensUI } from './lens-ui.js';

const sessionId = location.pathname.split('/').filter(Boolean)[1] || null;
const base = `/api/session/${encodeURIComponent(sessionId)}`;
const sessionKey = 'anamorphic:capture-session:v2';
let link, sessionState, attemptedCamera = false, cameraAllowed = false, startingLive = false, resumeOnVisible = false, freezing = false, seq = 0, pendingFrame, latestFrame = null, trackedCount = 0, lastSeq = 0, ticks = [];
let photo, image, points = [], manual = false, busy = false, activePointer = null, pointerPoint;
let keyboardPoint = [0, 0];
let lensChanging = false, cameraDirty = false;
const canvas = $('#photo-canvas'), context = canvas.getContext('2d');
const labels = ['1 · trên trái', '2 · trên phải', '3 · dưới phải', '4 · dưới trái'];

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
  $('#photo-label').setAttribute('aria-disabled', String(value));
  for (const id of ['confirm', 'manual', 'undo', 'retake']) $(`#${id}`).disabled = value;
  if (!value) updateReview();
}
function expired() { setBusy(false); show('expired'); $('#session-badge').textContent = 'PHIÊN ĐÃ HẾT HẠN'; }

function draw() {
  if (!image) return;
  context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
  const ratio = canvas.width / photo.imageSize.w;
  const dotRadius = Math.max(9, canvas.width / 85);
  points.forEach((p, i) => {
    const x = p.x * ratio, y = p.y * canvas.height / photo.imageSize.h;
    context.beginPath(); context.arc(x, y, dotRadius, 0, Math.PI * 2);
    context.fillStyle = '#d4f879'; context.fill(); context.lineWidth = dotRadius / 5; context.strokeStyle = '#233019'; context.stroke();
    context.fillStyle = '#233019'; context.font = `bold ${dotRadius * 1.2}px monospace`; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(String(i + 1), x, y + dotRadius / 20);
  });
  if (manual && document.activeElement === canvas && points.length < 4) {
    const x = keyboardPoint[0] * ratio, y = keyboardPoint[1] * canvas.height / photo.imageSize.h;
    context.strokeStyle = '#ff5a3c'; context.lineWidth = Math.max(2, canvas.width / 500);
    context.beginPath(); context.moveTo(x - dotRadius, y); context.lineTo(x + dotRadius, y); context.moveTo(x, y - dotRadius); context.lineTo(x, y + dotRadius); context.stroke();
  }
}

function updateReview() {
  canvas.classList.toggle('manual', manual);
  $('#point-steps').hidden = !manual; $('#point-help').hidden = !manual;
  $('#manual').hidden = manual; $('#undo').hidden = !manual; $('#undo').disabled = busy || !points.length;
  $('#confirm').disabled = busy || points.length !== 4;
  document.querySelectorAll('[data-point]').forEach((node, i) => {
    node.classList.toggle('placed', i < points.length); node.classList.toggle('current', i === points.length);
  });
  if (manual) $('#review-instruction').textContent = points.length < 4
    ? `Chạm tâm marker ${labels[points.length]} theo nhãn trên ảnh (không theo vị trí ảnh nếu ảnh bị xoay).`
    : 'Đã chọn 4 tâm marker. Kiểm tra rồi nhấn “Đúng” để áp dụng.';
  else $('#review-instruction').textContent = 'Đã nhận diện đủ 4 marker và gửi kết quả lên máy tính. Kiểm tra các chấm trên ảnh; chọn “Chạm tay” nếu cần sửa.';
  draw();
}

async function loadPhoto(data, source) {
  photo = data; manual = false;
  const nextImage = new Image(); nextImage.src = source;
  await nextImage.decode();
  image = nextImage; canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  points = data.ok ? MARKER_IDS.map(id => data.points.find(p => p.id === id)).filter(Boolean) : [];
  keyboardPoint = [photo.imageSize.w / 2, photo.imageSize.h / 2];
  show('review');
  if (!data.ok) { manual = true; points = []; }
  updateReview();
  if (!data.ok) status(data.reason || 'Không tìm đủ marker. Hãy chạm lần lượt vào 4 tâm trên ảnh.');
}

$('#photo-input').onchange = async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || busy) return;
  if (file.size > 20 * 1024 * 1024) { status('Ảnh lớn hơn 20 MB. Hãy chọn ảnh nhỏ hơn.', true); return; }
  setBusy(true); status('Đang gửi ảnh gốc và nhận diện marker… Giữ nguyên cửa sổ máy tính.');
  camera.stop();
  const form = new FormData(); form.append('photo', file);
  try {
    const data = await api(`${base}/photo`, { method: 'POST', body: form });
    await loadPhoto(data, data.previewUrl);
    $('#session-badge').textContent = 'ẢNH ĐÃ NHẬN';
  } catch (error) {
    if (error.status === 404) expired();
    else status(`${error.message} Bạn có thể chụp hoặc chọn ảnh khác.`, true);
  } finally { setBusy(false); }
};

$('#manual').onclick = () => { manual = true; points = []; status(); updateReview(); };
$('#undo').onclick = () => { if (!busy) { points.pop(); status(); updateReview(); } };
$('#confirm').onclick = async () => {
  if (busy || points.length !== 4) return;
  try { validatePoints(points, photo.imageSize); } catch (error) { status(error.message, true); return; }
  setBusy(true); status('Đang áp dụng góc nhìn…');
  try {
    await api(`${base}/points`, json({ points, photoId: photo.photoId }));
    show('done'); $('#session-badge').textContent = 'ĐÃ HIỆU CHUẨN';
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
  points.push({ id: MARKER_IDS[points.length], x: point[0], y: point[1] });
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
    draw();
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
  camera.resetTracking();
  $('#phone-tracked').textContent = 'Nhớ 0/4';
  document.querySelectorAll('[data-memory-id]').forEach(node => { node.classList.remove('remembered', 'observed'); node.title = 'Chưa thấy'; });
  if (pendingFrame) { clearTimeout(pendingFrame.timer); pendingFrame.resolve({ ok: false, samples: 0 }); pendingFrame = null; }
  updateFreeze();
}
function updateFreeze() {
  $('#freeze').disabled = freezing || lensChanging || cameraDirty || !link?.open || !latestFrame || trackedCount < 4;
  $('#freeze').textContent = freezing ? 'Đang chốt…' : `Chốt · ${trackedCount}/4 điểm`;
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
  overlay(result);
  const now = performance.now(); ticks.push(now); ticks = ticks.filter(t => now - t <= 1500);
  const fps = ticks.length > 1 ? (ticks.length - 1) * 1000 / (now - ticks[0]) : 0;
  $('#phone-detected').textContent = `${result.detected}/4 marker`; $('#phone-fps').textContent = `${fps.toFixed(1)} fps`;
  $('#phone-tracked').textContent = `Nhớ ${result.tracked}/4`;
  $('#phone-compression').textContent = result.valid ? `Nén: ${Math.round(result.compression * 100)}%` : 'Nén: —';
  $('#camera-warning').textContent = result.warning || 'Góc nhìn hợp lệ. Giữ ổn định rồi nhấn Chốt.';
  const nextSeq = ++seq;
  const packet = { type: result.observations.length ? 'live_points' : 'live_status', seq: nextSeq, revision: result.revision,
    points: result.observations, imageSize: result.imageSize, fps };
  const ack = await new Promise(resolve => {
    const timer = setTimeout(() => { if (pendingFrame?.seq === nextSeq) { pendingFrame = null; latestFrame = null; updateFreeze(); } resolve({ ok: false, reason: 'Mất xác nhận khung hình. Đang chờ kết nối.' }); }, 2000);
    pendingFrame = { seq: nextSeq, resolve, timer };
    if (!link.send(packet)) { clearTimeout(timer); pendingFrame = null; resolve({ ok: false }); }
  });
  if (result.revision !== sessionState?.revision || result.trackingEpoch !== camera.trackingEpoch) return;
  trackedCount = ack.tracked || 0;
  if (ack.ok && ack.ready && result.freezeValid) {
    latestFrame = { Q: result.freezeQ, imageSize: result.imageSize }; lastSeq = ack.lastSeq;
  } else { latestFrame = null; if (ack.reason) $('#camera-warning').textContent = ack.reason; }
  updateFreeze();
}

function receive(data) {
  if (['connected', 'live_started', 'capture_started'].includes(data.type)) {
    const changed = sessionState?.revision !== data.revision;
    sessionState = data;
    if (changed || data.type === 'connected') resetFrames();
    if (data.type === 'live_started') cameraDirty = false;
    if (data.type === 'connected' && cameraDirty && camera.mode === 'live') resetCameraCalibration().catch(error => lens.notice(error.message));
    $('#session-badge').textContent = `PHIÊN ${sessionId.slice(0, 8).toUpperCase()}`;
    if (data.mode === 'display' && data.result) { camera.stop(); show('done'); $('#review-again').hidden = !photo; }
    else if (data.type === 'live_started' && cameraAllowed && camera.mode !== 'live') startLive();
    else if (data.type === 'connected' && data.mode === 'live' && cameraAllowed && resumeOnVisible) startLive();
    else if (data.type === 'connected' && photo && data.mode === 'calibrating') { attemptedCamera = true; }
    else if (data.type === 'connected' && !attemptedCamera) startLive();
    else if (data.type === 'capture_started') { camera.stop(); show('capture'); }
  }
  if (data.type === 'frame_ack' && pendingFrame?.seq === data.seq) {
    const pending = pendingFrame; pendingFrame = null; clearTimeout(pending.timer); pending.resolve(data);
  }
  if (data.type === 'calibrated' && data.source === 'live' && data.revision === sessionState?.revision) {
    sessionState.mode = 'display'; camera.stop(); resetFrames(); show('done'); $('#review-again').hidden = !photo;
  }
}

$('#freeze').onclick = async () => {
  if (freezing || lensChanging || cameraDirty || !latestFrame || trackedCount < 4) return;
  freezing = true; updateFreeze();
  try {
    if (pendingFrame) await new Promise(resolve => { const check = () => pendingFrame ? setTimeout(check, 10) : resolve(); check(); });
    if (!latestFrame) throw new Error('Chưa gom đủ bốn điểm hợp lệ.');
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
