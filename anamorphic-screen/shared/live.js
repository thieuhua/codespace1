export const FREEZE_SAMPLES = 15; // Maximum real observations kept per marker, not a minimum to enable freeze.
export const FRAME_INTERVAL = 80; // 12.5 frames/s; at most one detector/relay job in flight.

// Smooth normalized photo coordinates, never CSS matrix coefficients. Validate
// the resulting homography before committing this state in the display client.
export function emaFrame(previous, next, alpha = 0.3) {
  if (!previous || previous.imageSize.w !== next.imageSize.w || previous.imageSize.h !== next.imageSize.h) {
    return { Q: next.Q.map(p => [...p]), imageSize: { ...next.imageSize } };
  }
  return { Q: next.Q.map((p, i) => p.map((v, axis) => previous.Q[i][axis] + alpha * (v - previous.Q[i][axis]))), imageSize: { ...next.imageSize } };
}
