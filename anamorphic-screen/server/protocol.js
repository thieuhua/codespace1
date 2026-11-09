import { MARKER_IDS, markerLayout, validatePoints, viewportKey } from '../shared/calibration.js';
import { TemporalMarkers } from '../shared/temporal-markers.js';

export function geometry(viewport, markers) {
  if (!viewport || !Number.isInteger(viewport.vw) || !Number.isInteger(viewport.vh) ||
      viewport.vw < 200 || viewport.vh < 200 || viewport.vw > 16_384 || viewport.vh > 16_384 ||
      !Number.isFinite(viewport.dpr) || viewport.dpr < 0.25 || viewport.dpr > 8) throw new Error('Viewport không hợp lệ.');
  const expected = markerLayout(viewport);
  if (!Array.isArray(markers) || markers.length !== 4 || new Set(markers.map(p => p?.id)).size !== 4 ||
      expected.some(p => !markers.some(m => m?.id === p.id && Number.isFinite(m.x) && Number.isFinite(m.y) && Math.abs(m.x - p.x) < 0.5 && Math.abs(m.y - p.y) < 0.5))) {
    throw new Error('Vị trí marker không khớp viewport.');
  }
  return { viewport: { vw: viewport.vw, vh: viewport.vh, dpr: viewport.dpr }, markers: expected };
}

export function snapshot(session) {
  return { viewport: session.viewport, markers: session.markers, revision: session.revision, mode: session.mode, result: session.result };
}
export function peers(session) {
  return { display: [...session.clients].filter(ws => ws.readyState === 1 && ws.role === 'display').length,
    capture: [...session.clients].filter(ws => ws.readyState === 1 && ws.role === 'capture').length };
}
export function resetStream(session, mode) {
  session.mode = mode; session.revision++;
  session.tracker = null; session.memory = null; session.liveReady = false; session.lastPacketAt = null;
  session.lastFrame = null; session.frameOwner = null;
}

export function handleMessage(session, ws, data, { broadcast, now }) {
  const reply = payload => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); };
  const frame = data?.type === 'live_points' || data?.type === 'live_status';
  const ack = (ok, reason) => reply(frame ? { type: 'frame_ack', seq: data.seq, ok, reason, samples: session.memory?.samples || 0,
    tracked: session.memory?.tracked || 0, ready: !!session.liveReady, sampleCounts: session.memory?.sampleCounts,
    lastSeq: session.lastFrame?.seq || 0, revision: session.revision }
    : { type: 'command_ack', requestId: data?.requestId, ok, reason, revision: session.revision });
  try {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Thông điệp không hợp lệ.');
    if (data.type === 'configure') {
      if (ws.role !== 'display') throw new Error('Chỉ máy tính được đổi viewport.');
      const next = geometry(data.viewport, data.markers);
      if (viewportKey(next.viewport) !== viewportKey(session.viewport) || data.force === true) {
        Object.assign(session, next); session.result = null; session.photo = null;
        resetStream(session, 'live');
        broadcast(session, 'live_started', { ...snapshot(session), reason: 'viewport_changed' });
      }
    } else if (data.type === 'start_live' || data.type === 'fallback') {
      resetStream(session, data.type === 'start_live' ? 'live' : 'calibrating');
      broadcast(session, data.type === 'start_live' ? 'live_started' : 'capture_started', snapshot(session));
    } else if (data.type === 'pause') {
      if (ws.role !== 'capture') throw new Error('Chỉ điện thoại được dừng camera.');
      if (session.frameOwner === ws) {
        session.frameOwner = null; session.tracker = null; session.memory = null; session.liveReady = false; session.lastFrame = null;
        broadcast(session, 'live_status', { revision: session.revision, detected: 0, tracked: 0, fps: 0, warning: 'Camera đã tạm dừng. Giữ kết quả hợp lệ gần nhất.' });
      }
    } else if (frame) {
      if (ws.role !== 'capture') throw new Error('Chỉ điện thoại được gửi khung hình.');
      if (session.mode !== 'live' || data.revision !== session.revision) throw new Error('Lượt hiệu chỉnh đã đổi. Đợi đồng bộ phiên.');
      if (!Number.isSafeInteger(data.seq) || data.seq <= (ws.lastSeq || 0)) throw new Error('Khung hình cũ hoặc lặp lại.');
      if (session.frameOwner && session.frameOwner !== ws) throw new Error('Một điện thoại khác đang hiệu chỉnh.');
      session.frameOwner = ws; ws.lastSeq = data.seq;
      const fps = Math.max(0, Math.min(60, Number(data.fps) || 0));
      const observations = data.points || [], size = data.imageSize || session.memory?.imageSize;
      session.tracker ||= new TemporalMarkers();
      const memory = session.tracker.update(observations, size, session.revision, now());
      session.memory = memory; session.lastPacketAt = now(); session.liveReady = false;
      if (memory.reset) session.lastFrame = null;
      const detected = observations.length, tracked = memory.tracked;
      let warning = tracked < 4 ? `Thấy ${detected}/4, đã nhớ ${tracked}/4. Tiếp tục tìm các marker còn thiếu.`
        : detected < 4 ? `Thấy ${detected}/4, đã nhớ 4/4. Giữ điểm chưa thấy từ khung trước.` : '';
      let Q;
      if (tracked === 4) {
        try {
          Q = validatePoints(memory.points, size);
          validatePoints(memory.freezeQ.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), size);
          session.liveReady = true;
        } catch (error) { warning = error.message; }
      }
      if (Q && (observations.length || !session.lastFrame)) {
        const result = { Q, imageSize: { ...size }, seq: data.seq, revision: session.revision, detected, tracked, fps,
          updatedIds: memory.updatedIds, sampleCounts: memory.sampleCounts, samples: memory.samples, warning, algorithm: 'temporal' };
        session.lastFrame = result;
        broadcast(session, 'live_points', result);
      } else broadcast(session, 'live_status', { revision: session.revision, detected, tracked, fps, warning });
    } else if (data.type === 'freeze') {
      if (ws.role !== 'capture' || session.frameOwner !== ws || session.mode !== 'live' || data.revision !== session.revision) throw new Error('Điện thoại chưa có lượt hiệu chỉnh đang hoạt động.');
      const latest = session.lastFrame;
      if (!latest || !session.liveReady || data.lastSeq !== latest.seq || now() - session.lastPacketAt > 1000) throw new Error('Chưa có đủ bốn điểm hợp lệ, hoặc camera đã ngừng gửi. Giữ camera mở và thử chốt lại.');
      const result = { Q: session.memory.freezeQ, imageSize: session.memory.imageSize };
      validatePoints(result.Q.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), result.imageSize);
      session.result = { ...result, revision: session.revision, source: 'live', algorithm: 'temporal',
        samples: session.memory.samples, sampleCounts: session.memory.sampleCounts };
      session.mode = 'display';
      broadcast(session, 'calibrated', session.result);
    } else throw new Error('Lệnh không được hỗ trợ.');
    session.touched = now();
    ack(true);
  } catch (error) { ack(false, error.message); }
}
