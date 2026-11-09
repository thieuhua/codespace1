import { api } from './utils.js';

export class SessionConnection {
  constructor(id, role, { message = () => {}, state = () => {}, expired = () => {} } = {}) {
    Object.assign(this, { id, role, message, state, expired, attempts: 0, pending: new Map(), stopped: false });
    this.offline = () => { this.socket?.close(); this.state('offline'); };
    this.online = () => { clearTimeout(this.timer); this.connect(); };
    addEventListener('offline', this.offline); addEventListener('online', this.online);
    this.connect();
  }
  get open() { return this.socket?.readyState === WebSocket.OPEN; }
  connect() {
    if (this.stopped || this.open || this.socket?.readyState === WebSocket.CONNECTING) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?session=${encodeURIComponent(this.id)}&role=${this.role}`);
    this.socket = ws;
    ws.onopen = () => { this.attempts = 0; this.state('open'); };
    ws.onmessage = event => {
      if (this.socket !== ws || this.stopped) return;
      const data = JSON.parse(event.data);
      if (data.type === 'command_ack') {
        const pending = this.pending.get(data.requestId);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(data.requestId); data.ok ? pending.resolve(data) : pending.reject(new Error(data.reason)); }
      }
      this.message(data);
    };
    ws.onerror = () => this.state('offline');
    ws.onclose = () => {
      if (this.socket !== ws || this.stopped) return;
      this.rejectPending(); this.state('offline');
      this.timer = setTimeout(async () => {
        if (this.stopped) return;
        try { await api(`/api/session/${this.id}`, { signal: AbortSignal.timeout(5000) }); }
        catch (error) {
          if (this.stopped) return;
          if (error.status === 404) { this.stop(); this.expired(); return; }
        }
        this.connect();
      }, Math.min(8000, 400 * 2 ** this.attempts++));
    };
  }
  send(data) {
    if (!this.open || this.socket.bufferedAmount > 16_384) return false;
    this.socket.send(JSON.stringify(data)); return true;
  }
  command(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Chưa nhận được xác nhận. Hãy kiểm tra kết nối.')); }, 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.send({ ...payload, type, requestId })) {
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error('Đang mất kết nối. Chờ nối lại phiên.'));
      }
    });
  }
  rejectPending() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Mất kết nối. Thử lại sau khi nối lại phiên.')); }
    this.pending.clear();
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); this.rejectPending(); this.socket?.close();
    removeEventListener('offline', this.offline); removeEventListener('online', this.online);
  }
}
