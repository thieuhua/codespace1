export function settingRange(capability) {
  if (!capability || !Number.isFinite(capability.min) || !Number.isFinite(capability.max) || capability.max <= capability.min) return null;
  const step = Number.isFinite(capability.step) && capability.step > 0 ? capability.step : (capability.max - capability.min) / 1000;
  return { min: capability.min, max: capability.max, step };
}

export function snapSetting(value, range) {
  if (!range || !Number.isFinite(value)) throw new Error('Giá trị camera không hợp lệ.');
  const bounded = Math.max(range.min, Math.min(range.max, value));
  return Number(Math.max(range.min, Math.min(range.max, range.min + Math.round((bounded - range.min) / range.step) * range.step)).toFixed(10));
}

// A logarithmic slider leaves useful precision near 1× on cameras whose range
// extends to 20× or 100×. The value still respects the device's actual step.
export function sliderZoom(position, range) {
  const t = Math.max(0, Math.min(1000, position)) / 1000;
  return snapSetting(Math.exp(Math.log(range.min) + t * Math.log(range.max / range.min)), range);
}
export function zoomSlider(value, range) {
  return Math.round(1000 * Math.log(snapSetting(value, range) / range.min) / Math.log(range.max / range.min));
}

export function preferredRearCamera(devices, currentId) {
  const rear = /back|rear|environment|sau|arrière|rück|traser|traseir/i;
  const score = device => {
    const label = device.label || '';
    if (!rear.test(label) || /front|facetime|trước/i.test(label)) return -Infinity;
    return 100 + (/wide|rộng/i.test(label) ? 30 : 0) - (/ultra|siêu|tele|0[.,]5/i.test(label) ? 100 : 0) - (/triple|dual|kép/i.test(label) ? 30 : 0);
  };
  const current = devices.find(d => d.deviceId === currentId);
  const candidate = devices.reduce((best, d) => score(d) > score(best) ? d : best, current || { label: '' });
  return score(candidate) > score(current || { label: '' }) ? candidate.deviceId : currentId;
}

// Match object-fit:contain; a tap in a black letterbox has no sensor coordinate.
// W3C pointsOfInterest use normalized [0,1] coordinates, not CSS/image pixels.
export function cameraPoint(rect, videoWidth, videoHeight, clientX, clientY) {
  if (!(rect.width > 0 && rect.height > 0 && videoWidth > 0 && videoHeight > 0)) return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale, height = videoHeight * scale;
  const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
  const x = (clientX - left) / width, y = (clientY - top) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
