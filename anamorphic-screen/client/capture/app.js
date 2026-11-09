import { $, api, json, toast } from '/assets/utils.js';
import { MARKER_IDS, validatePoints } from '/shared/calibration.js';

const sessionId = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1));
const base = `/api/session/${encodeURIComponent(sessionId)}`;
let photo, image, points = [], manual = false, busy = false, activePointer = null, pointerPoint;
let keyboardPoint = [0, 0];
const canvas = $('#photo-canvas'), context = canvas.getContext('2d');
const labels = ['1 · trên trái', '2 · trên phải', '3 · dưới phải', '4 · dưới trái'];

function status(text = '', error = false) {
  $('#status').hidden = !text;
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}
function show(section) {
  for (const id of ['capture', 'review', 'done', 'expired']) $(`#${id}-section`).hidden = id !== section;
  for (const [index, step] of ['photo', 'review', 'done'].entries()) $(`#step-${step}`).classList.toggle('active', index <= ['capture', 'review', 'done'].indexOf(section));
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
$('#retake').onclick = () => { show('capture'); };
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

async function boot() {
  setBusy(true); status('Đang mở phiên hiệu chuẩn…');
  try {
    const session = await api(base);
    $('#session-badge').textContent = `PHIÊN ${sessionId.slice(0, 8).toUpperCase()}`;
    status();
    if (session.photo) await loadPhoto(session.photo, `${base}/photo?photoId=${session.photo.photoId}`);
  } catch (error) {
    if (error.status === 404) expired();
    else { status(`Không kết nối được server: ${error.message}`, true); toast('Kiểm tra cùng Wi-Fi và địa chỉ server trên máy tính.'); }
  } finally { setBusy(false); }
}
boot();
