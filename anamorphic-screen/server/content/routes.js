import { timingSafeEqual } from 'node:crypto';
import { isServerSource, normalizeFields, sourceURL, validateContent } from '../../shared/content/schema.js';
import { mapFields } from '../../shared/content/mapping.js';
import { safeFetch } from './safe-fetch.js';
import { parseJSON } from './adapters/json.js';
import { parseRSS } from './adapters/rss.js';
import { parseHTML, extractHTML } from './adapters/html.js';

function bad(message, status = 400) { return Object.assign(new Error(message), { status }); }
export function authorized(session, token) {
  if (typeof token !== 'string') return false;
  const actual = Buffer.from(token), expected = Buffer.from(session.controllerToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function requireController(session, token) {
  if (!authorized(session, token)) throw bad('Cần khóa điều khiển trong QR của phiên.', 403);
}
export function createContentService({ broadcast, fetchSource = safeFetch, now = Date.now } = {}) {
  const pollers = new Map();
  function rate(session, action, limit) {
    session.contentRates ||= {};
    const bucket = session.contentRates[action];
    if (!bucket || now() - bucket.start >= 60000) session.contentRates[action] = { start: now(), count: 1 };
    else if (++bucket.count > limit) throw bad('Quá nhiều yêu cầu nội dung. Đợi một phút rồi thử lại.', 429);
  }
  function stop(session) {
    const running = pollers.get(session.id);
    if (running) { clearTimeout(running.timer); running.controller.abort(); pollers.delete(session.id); }
  }
  function status(session, state, reason = '') {
    session.contentStatus = { state, reason, contentRevision: session.contentConfig.contentRevision };
    broadcast(session, 'content_status', session.contentStatus);
  }
  function data(session, fields) {
    session.contentData = { fields, contentRevision: session.contentConfig.contentRevision };
    broadcast(session, 'content_data', session.contentData); status(session, 'ready');
  }
  async function preview(session, raw, signal) {
    const value = validateContent(raw), { adapterId, config, fieldMap } = value;
    if (adapterId === 'manual') return config.fields;
    if (!isServerSource(value)) throw bad('Nguồn này chạy trên trình duyệt; dùng nút Thử trên máy tính.');
    let headers = {};
    if (config.secretRef) {
      const secret = session.contentSecrets?.get(config.secretRef);
      if (!secret || secret.origin !== new URL(config.url).origin) throw bad('Chưa có khóa có tên cho origin nguồn này trên server.');
      headers = { [secret.header]: secret.value };
    }
    const types = adapterId === 'json' ? ['application/json'] : adapterId === 'rss'
      ? ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'] : ['text/html', 'application/xhtml+xml'];
    try {
      const response = await fetchSource(config.url, { types, headers, signal });
      const source = adapterId === 'json' ? parseJSON(response.body) : adapterId === 'rss' ? parseRSS(response.body, config.item) : parseHTML(response.body);
      return mapFields(source, fieldMap, { kind: adapterId, extract: extractHTML, baseURL: response.url });
    } catch (error) { throw bad(error.message, error.status || 400); }
  }
  function set(session, raw, token) {
    requireController(session, token); rate(session, 'config', 20);
    const value = validateContent(raw);
    if (value.contentRevision !== session.contentConfig.contentRevision) throw bad('Nội dung đã đổi trên thiết bị khác. Đợi đồng bộ rồi áp dụng lại.', 409);
    stop(session);
    value.contentRevision = session.contentConfig.contentRevision + 1;
    session.contentConfig = value;
    session.contentData = isServerSource(value) && session.contentData
      ? { fields: normalizeFields(session.contentData.fields, value.fieldMap), contentRevision: value.contentRevision } : null;
    broadcast(session, 'content_config', { contentConfig: value });
    if (value.adapterId === 'manual') data(session, value.config.fields);
    else if (isServerSource(value)) {
      status(session, 'loading');
      const running = { controller: new AbortController() }; pollers.set(session.id, running);
      const poll = async () => {
        try {
          const fields = await preview(session, value, running.controller.signal);
          if (pollers.get(session.id) === running) data(session, fields);
        } catch (error) {
          if (pollers.get(session.id) === running) status(session, session.contentData ? 'stale' : 'error', error.message);
        } finally {
          if (pollers.get(session.id) === running) {
            running.timer = setTimeout(poll, Math.max(15, value.config.interval) * 1000); running.timer.unref?.();
          }
        }
      };
      poll();
    } else status(session, 'loading');
    return value;
  }
  function message(session, ws, value) {
    if (value?.type === 'content_status') {
      try {
        requireController(session, value.controllerToken);
        if (ws.role !== 'display' || isServerSource(session.contentConfig) || value.contentRevision !== session.contentConfig.contentRevision) throw bad('Trạng thái nguồn không hợp lệ hoặc đã cũ.');
        if (!['loading', 'ready', 'stale', 'error'].includes(value.state)) throw bad('Trạng thái nguồn không được hỗ trợ.');
        rate(session, 'status', 180);
        status(session, value.state, String(value.reason || '').slice(0, 500));
      } catch (error) { ws.send(JSON.stringify({ type: 'command_ack', requestId: value.requestId, ok: false, reason: error.message })); }
      return true;
    }
    if (value?.type !== 'content_config') return false;
    try { set(session, value.contentConfig, value.controllerToken); ws.send(JSON.stringify({ type: 'command_ack', requestId: value.requestId, ok: true, contentRevision: session.contentConfig.contentRevision })); }
    catch (error) { ws.send(JSON.stringify({ type: 'command_ack', requestId: value.requestId, ok: false, reason: error.message })); }
    return true;
  }
  function mount(app, sessionRequired) {
    app.get('/api/session/:id/content/config', sessionRequired, (req, res) => res.json({ contentConfig: req.session.contentConfig, contentData: req.session.contentData, contentStatus: req.session.contentStatus }));
    app.put('/api/session/:id/content/config', sessionRequired, (req, res) => res.json({ contentConfig: set(req.session, req.body, req.get('X-Controller-Token')) }));
    app.post('/api/session/:id/content/preview', sessionRequired, async (req, res) => {
      requireController(req.session, req.get('X-Controller-Token')); rate(req.session, 'preview', 10);
      res.json({ fields: await preview(req.session, req.body) });
    });
    app.put('/api/session/:id/content/secrets', sessionRequired, (req, res) => {
      requireController(req.session, req.get('X-Controller-Token')); rate(req.session, 'secrets', 5);
      if (req.get('X-Content-Display-Key') !== req.session.contentDisplayKey) throw bad('Chỉ trang máy tính tạo phiên được nhập khóa nguồn.', 403);
      const { name, header, value, url } = req.body || {};
      if (!/^[a-zA-Z][\w-]{0,39}$/.test(name || '') || !/^(authorization|x-api-key|api-key)$/i.test(header || '') || typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value)) throw bad('Tên khóa, header hoặc giá trị không hợp lệ.');
      const origin = new URL(sourceURL(url)).origin;
      req.session.contentSecrets ||= new Map();
      if (!req.session.contentSecrets.has(name) && req.session.contentSecrets.size >= 8) throw bad('Mỗi phiên tối đa 8 khóa có tên.');
      req.session.contentSecrets.set(name, { header, value, origin });
      res.json({ ok: true });
    });
  }
  return { set, preview, message, mount, stop, close() { for (const running of pollers.values()) { clearTimeout(running.timer); running.controller.abort(); } pollers.clear(); } };
}
