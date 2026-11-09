export const $ = selector => document.querySelector(selector);
export async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(45_000) });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({ reason: `Server trả mã ${response.status}.` }));
  if (!response.ok) throw Object.assign(new Error(data.reason || 'Không kết nối được server.'), { status: response.status });
  return data;
}
export const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function toast(message) {
  let node = $('#toast');
  if (!node) { node = document.createElement('div'); node.id = 'toast'; node.className = 'toast'; node.setAttribute('role', 'status'); document.body.append(node); }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 6000);
}
export async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); return; }
  const text = document.createElement('textarea');
  text.value = value; text.style.position = 'fixed'; text.style.opacity = '0';
  document.body.append(text); text.select();
  const copied = document.execCommand('copy'); text.remove();
  if (!copied) throw new Error('Hãy chọn và sao chép đường dẫn bằng tay.');
}
