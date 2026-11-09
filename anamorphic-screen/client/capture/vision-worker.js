/* Classic worker: js-aruco2's browser build installs CV/AR on self. */
importScripts('/vendor/cv.js', '/vendor/aruco.js', '/vendor/jsQR.js');
const modules = Promise.all([import('/shared/markers.js'), import('/shared/calibration.js'), import('/shared/temporal-markers.js')]);
const detector = new AR.Detector({ dictionaryName: 'ARUCO', maxHammingDistance: 2 });
let tracker;
self.onmessage = async ({ data: job }) => {
  try {
    const pixels = new Uint8ClampedArray(job.buffer);
    if (job.type === 'qr') {
      const result = jsQR(pixels, job.width, job.height, { inversionAttempts: 'dontInvert' });
      self.postMessage({ id: job.id, code: result?.data || null });
      return;
    }
    const [{ markerPoints }, { computeWarp, validateCalibration }, { TemporalMarkers }] = await modules;
    tracker ||= new TemporalMarkers();
    const found = detector.detect({ data: pixels, width: job.width, height: job.height });
    const imageSize = { w: job.width, h: job.height };
    const observations = markerPoints(found, imageSize);
    const memory = tracker.update(observations, imageSize, job.trackingKey, performance.now());
    const { points } = memory;
    let warning = '', compression, valid = false, freezeValid = false;
    try {
      const Q = validateCalibration(points, imageSize, job.viewport, job.markers);
      compression = computeWarp({ viewport: job.viewport, P: job.markers, Q, imageSize }).compression;
      valid = true;
      computeWarp({ viewport: job.viewport, P: job.markers, Q: memory.freezeQ, imageSize });
      freezeValid = true;
      if (observations.length < 4) warning = `Thấy ${observations.length}/4, đã nhớ 4/4. Giữ điểm chưa thấy từ khung trước; giữ camera ổn định.`;
    } catch (error) { warning = points.length < 4 ? `Thấy ${observations.length}/4, đã nhớ ${points.length}/4. Tiếp tục tìm các marker còn thiếu.` : error.message; }
    self.postMessage({ id: job.id, ...memory, observations, detected: observations.length, warning, compression, valid, freezeValid });
  } catch (error) { self.postMessage({ id: job.id, error: error.message }); }
};
