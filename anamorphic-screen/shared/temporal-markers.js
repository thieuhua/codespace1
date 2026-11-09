import { MARKER_IDS } from './calibration.js';
import { FREEZE_SAMPLES } from './live.js';

export const MARKER_MAX_AGE_MS = 3000;
export const STABLE_SAMPLES = 3;
export const STABLE_JITTER_PX = 4;

export function markerStability(markerStats, maxAgeMs = MARKER_MAX_AGE_MS) {
  return MARKER_IDS.every(id => {
    const stats = markerStats?.[id];
    return stats && stats.ageMs !== null && stats.ageMs <= maxAgeMs && stats.sampleCount >= STABLE_SAMPLES && stats.jitter <= STABLE_JITTER_PX;
  });
}

// One latest coordinate and a small window of real observations per ID. Missing
// detections never erase a point and never add duplicate samples to its window.
export class TemporalMarkers {
  constructor({ maxAgeMs = MARKER_MAX_AGE_MS } = {}) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('Cửa sổ tuổi marker không hợp lệ.');
    this.maxAgeMs = maxAgeMs; this.reset();
  }
  reset() { this.key = null; this.imageSize = null; this.markers = new Map(); }
  update(observations, imageSize, key, time = 0) {
    if (!imageSize || !Number.isInteger(imageSize.w) || !Number.isInteger(imageSize.h) || imageSize.w < 32 || imageSize.h < 32 || Math.max(imageSize.w, imageSize.h) > 2000) {
      throw new Error('Kích thước khung hình không hợp lệ.');
    }
    if (!Array.isArray(observations) || observations.length > 4 || new Set(observations.map(p => p?.id)).size !== observations.length ||
        observations.some(p => !p || !MARKER_IDS.includes(p.id) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= imageSize.w || p.y >= imageSize.h)) {
      throw new Error('Điểm marker mới không hợp lệ.');
    }
    const reset = this.key !== key || this.imageSize?.w !== imageSize.w || this.imageSize?.h !== imageSize.h;
    if (reset) { this.reset(); this.key = key; this.imageSize = { ...imageSize }; }
    for (const p of observations) {
      const old = this.markers.get(p.id), previous = old && time - old.seenAt <= this.maxAgeMs ? old.samples : [];
      const samples = [...previous, [p.x, p.y]].slice(-FREEZE_SAMPLES);
      this.markers.set(p.id, { id: p.id, x: p.x, y: p.y, seenAt: time, samples });
    }
    return { ...this.snapshot(time), updatedIds: observations.map(p => p.id), reset };
  }
  snapshot(time = 0) {
    const points = MARKER_IDS.flatMap(id => { const p = this.markers.get(id); return p ? [{ id, x: p.x, y: p.y }] : []; });
    const sampleCounts = Object.fromEntries(MARKER_IDS.map(id => [id, this.markers.get(id)?.samples.length || 0]));
    const markerStats = Object.fromEntries(MARKER_IDS.map(id => {
      const p = this.markers.get(id);
      const jitter = p ? Math.max(0, ...p.samples.flatMap(a => p.samples.map(b => Math.hypot(a[0] - b[0], a[1] - b[1])))) : 0;
      return [id, { ageMs: p ? Math.max(0, time - p.seenAt) : null, sampleCount: sampleCounts[id], jitter }];
    }));
    const staleIds = MARKER_IDS.filter(id => markerStats[id].ageMs === null || markerStats[id].ageMs > this.maxAgeMs);
    const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const freezeQ = points.length === 4 ? MARKER_IDS.map(id => [0, 1].map(axis => median(this.markers.get(id).samples.map(p => p[axis])))) : null;
    return { points, tracked: points.length, sampleCounts, markerStats, staleIds, maxAgeMs: this.maxAgeMs,
      stable: markerStability(markerStats, this.maxAgeMs), fresh: !staleIds.length,
      samples: Math.min(...Object.values(sampleCounts)), freezeQ, imageSize: this.imageSize && { ...this.imageSize } };
  }
}
