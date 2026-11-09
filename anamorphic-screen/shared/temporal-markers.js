import { MARKER_IDS } from './calibration.js';
import { FREEZE_SAMPLES } from './live.js';

// One latest coordinate and a small window of real observations per ID. Missing
// detections never erase a point and never add duplicate samples to its window.
export class TemporalMarkers {
  constructor() { this.reset(); }
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
      const old = this.markers.get(p.id), samples = [...(old?.samples || []), [p.x, p.y]].slice(-FREEZE_SAMPLES);
      this.markers.set(p.id, { id: p.id, x: p.x, y: p.y, seenAt: time, samples });
    }
    const points = MARKER_IDS.flatMap(id => { const p = this.markers.get(id); return p ? [{ id, x: p.x, y: p.y }] : []; });
    const sampleCounts = Object.fromEntries(MARKER_IDS.map(id => [id, this.markers.get(id)?.samples.length || 0]));
    const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
    const freezeQ = points.length === 4 ? MARKER_IDS.map(id => [0, 1].map(axis => median(this.markers.get(id).samples.map(p => p[axis])))) : null;
    return { points, tracked: points.length, updatedIds: observations.map(p => p.id), sampleCounts,
      samples: Math.min(...Object.values(sampleCounts)), freezeQ, imageSize: { ...imageSize }, reset };
  }
}
