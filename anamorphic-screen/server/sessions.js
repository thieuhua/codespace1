import { randomUUID } from 'node:crypto';

export class SessionStore {
  constructor({ ttl = 15 * 60_000, capacity = 40, now = Date.now, onExpire = () => {} } = {}) {
    this.ttl = ttl;
    this.capacity = capacity;
    this.now = now;
    this.onExpire = onExpire;
    this.sessions = new Map();
  }
  create(data) {
    this.sweep();
    if (this.sessions.size >= this.capacity) throw Object.assign(new Error('Server đang có quá nhiều phiên. Hãy thử lại sau.'), { status: 503 });
    const session = { ...data, id: randomUUID(), touched: this.now(), clients: new Set(), photo: null, result: null, busy: false };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id, touch = true) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (this.now() - session.touched >= this.ttl) { this.delete(id); return null; }
    if (touch) session.touched = this.now();
    return session;
  }
  delete(id) {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      this.onExpire(session);
    }
  }
  sweep() {
    for (const [id, session] of this.sessions) if (this.now() - session.touched >= this.ttl) this.delete(id);
  }
}
