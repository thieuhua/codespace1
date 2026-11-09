import { mapFields } from '../../../../shared/content/mapping.js';

const mapped = (config, data, baseURL) => mapFields(data, config.fieldMap, { baseURL });
export const adapters = {
  manual: config => ({ start({ onData }) { onData(config.config.fields); }, stop() {} }),
  clock: config => {
    let timer;
    return { start({ onData }) {
      const tick = () => {
        const date = new Date(), time = date.toLocaleTimeString('vi-VN'), day = date.toLocaleDateString('vi-VN');
        onData(mapped(config, { title: time, description: day, kicker: 'ĐỒNG HỒ TRỰC TIẾP', footer: 'Giờ trên thiết bị hiển thị', image: '', time, date: day }));
      };
      tick(); timer = setInterval(tick, 1000);
    }, stop() { clearInterval(timer); } };
  },
  json: config => {
    let timer;
    return { start({ signal, onData, onStatus }) {
      const poll = async () => {
        try {
          const response = await fetch(config.config.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
          const type = (response.headers.get('content-type') || '').split(';')[0].trim();
          if (!response.ok || !/^application\/(?:[\w.+-]+\+)?json$/i.test(type)) throw new Error('Nguồn cần trả JSON qua CORS.');
          const reader = response.body.getReader(), chunks = []; let size = 0;
          for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Nguồn vượt 2 MiB.'); } chunks.push(value); }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          onData(mapped(config, JSON.parse(new TextDecoder().decode(bytes)), response.url || config.config.url));
        } catch (error) { if (!signal.aborted) onStatus({ state: 'error', reason: error.message }); }
        finally { if (!signal.aborted) timer = setTimeout(poll, config.config.interval * 1000); }
      };
      poll();
    }, stop() { clearTimeout(timer); } };
  },
  websocket: config => {
    let socket, timer, attempts = 0;
    return { start({ signal, onData, onStatus }) {
      const connect = () => {
        if (signal.aborted) return;
        socket = new WebSocket(config.config.url);
        socket.onopen = () => { attempts = 0; };
        socket.onmessage = event => {
          try {
            if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) throw new Error('Cần thông điệp JSON dưới 2 MiB.');
            onData(mapped(config, JSON.parse(event.data)));
          } catch (error) { onStatus({ state: 'error', reason: error.message }); }
        };
        socket.onerror = () => onStatus({ state: 'error', reason: 'Không đọc được nguồn WebSocket.' });
        socket.onclose = () => { if (!signal.aborted) { onStatus({ state: 'error', reason: 'Nguồn WebSocket ngắt kết nối; đang nối lại.' }); timer = setTimeout(connect, Math.min(10000, 500 * 2 ** attempts++)); } };
      };
      connect();
    }, stop() { clearTimeout(timer); socket?.close(); } };
  },
  iframe: () => ({ start({ onData }) { onData({}); }, stop() {} })
};
