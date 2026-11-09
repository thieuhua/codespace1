/* Classic worker: js-aruco2's browser build installs CV/AR on self. */
importScripts('/vendor/cv.js', '/vendor/aruco.js', '/vendor/jsQR.js');
const modules = Promise.all([import('/shared/detection.js'), import('/shared/calibration.js'), import('/shared/temporal-markers.js')]);
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
    const [{ detectMarkers }, { computeWarp, validateCalibration, reprojectionAcceptable, reprojectionWarning }, { TemporalMarkers }] = await modules;
    tracker ||= new TemporalMarkers();
    const imageSize = { w: job.width, h: job.height };
    const previous = tracker.key === job.trackingKey && tracker.imageSize?.w === job.width && tracker.imageSize?.h === job.height ? tracker.snapshot().points : [];
    const detail = job.detailBuffer && { data: new Uint8ClampedArray(job.detailBuffer), width: job.detailWidth, height: job.detailHeight };
    const started = performance.now();
    const observations = detectMarkers(detector, { data: pixels, width: job.width, height: job.height }, detail, previous);
    const detectionMs = performance.now() - started;
    const memory = tracker.update(observations, imageSize, job.trackingKey, performance.now());
    const { points } = memory;
    let warning = '', compression, reprojectionError = null, valid = false, freezeValid = false;
    try {
      const Q = validateCalibration(points, imageSize, job.viewport, job.markers);
      const quality = computeWarp({ viewport: job.viewport, P: job.markers, Q, points, imageSize });
      ({ compression, reprojectionError } = quality);
      valid = true;
      const frozen = computeWarp({ viewport: job.viewport, P: job.markers, Q: memory.freezeQ, points: memory.freezePoints, imageSize });
      freezeValid = reprojectionAcceptable(reprojectionError) && reprojectionAcceptable(frozen.reprojectionError);
      if (observations.length < 4) warning = `Thấy ${observations.length}/4, đã nhớ 4/4. Giữ điểm chưa thấy từ khung trước; giữ camera ổn định.`;
      warning = reprojectionWarning(quality) || reprojectionWarning(frozen) || warning;
    } catch (error) { warning = points.length < 4 ? `Thấy ${observations.length}/4, đã nhớ ${points.length}/4. Tiếp tục tìm các marker còn thiếu.` : error.message; }
    self.postMessage({ id: job.id, ...memory, stable: memory.stable && freezeValid, observations, detected: observations.length,
      detectionMs, reprojectionError, warning, compression, valid, freezeValid });
  } catch (error) { self.postMessage({ id: job.id, error: error.message }); }
};
