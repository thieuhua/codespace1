import { MARKER_IDS, markerLayout, validateCalibration, viewportKey } from '../shared/calibration.js';
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
  const photo = session.photo;
  return { viewport: session.viewport, markers: session.markers, revision: session.revision, mode: session.mode, result: session.result,
    displayApplied: session.displayApplied, busy: session.busy,
    photo: photo ? { photoId: photo.id, imageSize: photo.imageSize, points: photo.points, ok: photo.ok, reason: photo.reason,
      previewUrl: `/api/session/${session.id}/photo?photoId=${photo.id}` } : null };
}
export function peers(session) {
  return { display: [...session.clients].filter(ws => ws.readyState === 1 && ws.role === 'display').length,
    capture: [...session.clients].filter(ws => ws.readyState === 1 && ws.role === 'capture').length,
    streaming: !!session.frameOwner && session.mode === 'live' };
}
export function resetStream(session, mode) {
  session.mode = mode; session.revision++;
  session.tracker = null; session.memory = null; session.liveReady = false; session.lastPacketAt = null;
  session.lastFrame = null; session.frameOwner = null;
  session.displayApplied = null;
  session.liveWarning = '';
}

export function handleMessage(session, ws, data, { broadcast, now, markerMaxAgeMs }) {
  const reply = payload => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); };
  const frame = data?.type === 'live_points' || data?.type === 'live_status';
  const ack = (ok, reason) => {
    const memory = session.tracker?.snapshot(now());
    reply(frame ? { ...memory, type: 'frame_ack', seq: data.seq, ok, reason, warning: session.liveWarning, samples: memory?.samples || 0,
      tracked: memory?.tracked || 0, ready: !!session.liveReady && !!memory?.fresh,
      updatedIds: ok ? session.memory?.updatedIds || [] : [],
      lastSeq: session.lastFrame?.seq || 0, revision: session.revision }
      : { type: 'command_ack', requestId: data?.requestId, ok, reason, revision: session.revision });
  };
  try {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Thông điệp không hợp lệ.');
    if (data.type === 'sync') {
      reply({ type: 'snapshot', ...snapshot(session), peers: peers(session) });
    } else if (data.type === 'display_applied') {
      if (ws.role !== 'display' || data.revision !== session.revision || typeof data.ok !== 'boolean') throw new Error('Xác nhận hiển thị không hợp lệ hoặc đã cũ.');
      if (data.seq !== undefined && data.seq !== session.lastFrame?.seq) throw new Error('Xác nhận khung hình đã cũ.');
      if (data.seq === undefined && (!session.result || data.calibrationId !== session.result.calibrationId)) throw new Error('Xác nhận hiệu chuẩn đã cũ.');
      const applied = { revision: data.revision, ok: data.ok, reason: String(data.reason || '').slice(0, 500),
        seq: data.seq, calibrationId: data.calibrationId };
      if (data.seq === undefined) session.displayApplied = applied;
      broadcast(session, 'display_applied', applied);
    } else if (data.type === 'configure') {
      if (ws.role !== 'display') throw new Error('Chỉ máy tính được đổi viewport.');
      const next = geometry(data.viewport, data.markers);
      if (viewportKey(next.viewport) !== viewportKey(session.viewport) || data.force === true) {
        Object.assign(session, next); session.result = null; session.photo = null;
        resetStream(session, 'live');
        broadcast(session, 'live_started', { ...snapshot(session), reason: 'viewport_changed' });
        broadcast(session, 'peers', peers(session));
      }
    } else if (data.type === 'start_live' || data.type === 'fallback') {
      resetStream(session, data.type === 'start_live' ? 'live' : 'calibrating');
      broadcast(session, data.type === 'start_live' ? 'live_started' : 'capture_started', snapshot(session));
      broadcast(session, 'peers', peers(session));
    } else if (data.type === 'pause') {
      if (ws.role !== 'capture') throw new Error('Chỉ điện thoại được dừng camera.');
      if (session.frameOwner === ws) {
        session.frameOwner = null; session.tracker = null; session.memory = null; session.liveReady = false; session.lastFrame = null;
        broadcast(session, 'live_status', { revision: session.revision, detected: 0, tracked: 0, fps: 0, warning: 'Camera đã tạm dừng. Giữ kết quả hợp lệ gần nhất.' });
        broadcast(session, 'peers', peers(session));
      }
    } else if (frame) {
      if (ws.role !== 'capture') throw new Error('Chỉ điện thoại được gửi khung hình.');
      if (session.mode !== 'live' || data.revision !== session.revision) throw new Error('Lượt hiệu chỉnh đã đổi. Đợi đồng bộ phiên.');
      if (!Number.isSafeInteger(data.seq) || data.seq <= (ws.lastSeq || 0)) throw new Error('Khung hình cũ hoặc lặp lại.');
      if (session.frameOwner && session.frameOwner !== ws) throw new Error('Một điện thoại khác đang hiệu chỉnh.');
      const wasStreaming = !!session.frameOwner;
      ws.lastSeq = data.seq;
      const fps = Math.max(0, Math.min(60, Number(data.fps) || 0));
      const observations = data.points || [], size = data.imageSize || session.memory?.imageSize;
      session.tracker ||= new TemporalMarkers({ maxAgeMs: markerMaxAgeMs });
      const memory = session.tracker.update(observations, size, session.revision, now());
      session.frameOwner = ws;
      session.memory = memory; session.lastPacketAt = now(); session.liveReady = false;
      if (!wasStreaming) broadcast(session, 'peers', peers(session));
      if (memory.reset) session.lastFrame = null;
      const detected = observations.length, tracked = memory.tracked;
      let warning = tracked < 4 ? `Thấy ${detected}/4, đã nhớ ${tracked}/4. Tiếp tục tìm các marker còn thiếu.`
        : detected < 4 ? `Thấy ${detected}/4, đã nhớ 4/4. Giữ điểm chưa thấy từ khung trước.` : '';
      let Q;
      if (tracked === 4) {
        try {
          Q = validateCalibration(memory.points, size, session.viewport);
          validateCalibration(memory.freezeQ.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), size, session.viewport);
          session.liveReady = true;
        } catch (error) { warning = error.message; }
      }
      if (tracked === 4 && !memory.fresh) warning = `Marker ID ${memory.staleIds.join(', ')} đã cũ (quá ${memory.maxAgeMs} ms). Hãy đưa các marker này vào camera lại.`;
      session.liveWarning = warning;
      if (Q && (observations.length || !session.lastFrame)) {
        const result = { ...memory, Q, imageSize: { ...size }, seq: data.seq, revision: session.revision, detected, tracked, fps,
          ready: session.liveReady && memory.fresh, warning, algorithm: 'temporal' };
        session.lastFrame = result;
        broadcast(session, 'live_points', result);
      } else broadcast(session, 'live_status', { ...memory, revision: session.revision, detected, tracked, fps, warning: warning && `${warning} Giữ kết quả hợp lệ gần nhất.` });
    } else if (data.type === 'freeze') {
      if (ws.role !== 'capture' || session.frameOwner !== ws || session.mode !== 'live' || data.revision !== session.revision) throw new Error('Điện thoại chưa có lượt hiệu chỉnh đang hoạt động.');
      session.memory = session.tracker.snapshot(now());
      if (!session.memory.fresh) throw new Error(`Không thể chốt: marker ID ${session.memory.staleIds.join(', ')} đã cũ hoặc chưa thấy (giới hạn ${session.memory.maxAgeMs} ms). Hãy quan sát lại các ID này.`);
      const result = { Q: session.memory.freezeQ, imageSize: session.memory.imageSize };
      validateCalibration(result.Q.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), result.imageSize, session.viewport);
      const latest = session.lastFrame;
      if (!latest || !session.liveReady || data.lastSeq !== latest.seq || now() - session.lastPacketAt > 1000) throw new Error('Chưa có đủ bốn điểm hợp lệ, hoặc camera đã ngừng gửi. Giữ camera mở và thử chốt lại.');
      session.result = { ...result, revision: session.revision, source: 'live', algorithm: 'temporal',
        calibrationId: session.calibrationId = (session.calibrationId || 0) + 1,
        samples: session.memory.samples, sampleCounts: session.memory.sampleCounts, markerStats: session.memory.markerStats };
      session.displayApplied = null;
      session.mode = 'display';
      broadcast(session, 'calibrated', session.result);
      broadcast(session, 'peers', peers(session));
    } else throw new Error('Lệnh không được hỗ trợ.');
    session.touched = now();
    ack(true);
  } catch (error) { ack(false, error.message); }
}
