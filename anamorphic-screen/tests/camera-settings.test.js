import test from 'node:test';
import assert from 'node:assert/strict';
import { settingRange, snapSetting, sliderZoom, zoomSlider, preferredRearCamera, cameraPoint } from '../shared/camera-settings.js';
import { TrackControls } from '../client/capture/track-controls.js';

function fakeTrack({ capabilities = {}, settings = {}, apply } = {}) {
  let actual = { ...settings };
  const calls = [];
  return { calls, getCapabilities: () => capabilities, getSettings: () => ({ ...actual }), getConstraints: () => ({ width: { ideal: 1920 }, advanced: [{ zoom: actual.zoom }] }),
    async applyConstraints(constraints) {
      calls.push(constraints);
      if (apply) await apply(constraints);
      actual = { ...actual, ...constraints.advanced[0] };
    }
  };
}

test('zoom uses actual range/step with useful precision near 1×, including large maximum zoom', () => {
  const range = settingRange({ min: 1, max: 100, step: 0.05 });
  assert.equal(snapSetting(1.13, range), 1.15); assert.equal(snapSetting(999, range), 100);
  assert.equal(snapSetting(-1, range), 1);
  assert.ok(sliderZoom(150, range) < 2.1);
  for (const value of [1, 1.5, 2, 3, 10, 100]) assert.ok(Math.abs(sliderZoom(zoomSlider(value, range), range) - value) < Math.max(0.06, value * 0.005));
  assert.equal(settingRange({ min: 1, max: 1 }), null);
  assert.equal(settingRange({ min: NaN, max: 5 }), null);
  assert.throws(() => snapSetting(NaN, range));
});

test('rear selection prefers standard wide camera over ultra-wide, virtual camera or front camera', () => {
  const devices = [{ deviceId: 'front', label: 'Front Camera' }, { deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
    { deviceId: 'triple', label: 'Back Triple Camera' }, { deviceId: 'wide', label: 'Back Wide Camera' }];
  assert.equal(preferredRearCamera(devices, 'ultra'), 'wide');
  assert.equal(preferredRearCamera(devices, 'wide'), 'wide');
  assert.equal(preferredRearCamera([{ deviceId: 'one', label: '' }, { deviceId: 'two', label: '' }], 'two'), 'two');
});

test('tap focus coordinates map to normalized sensor coordinates and exclude letterboxing', () => {
  const rect = { left: 20, top: 40, width: 400, height: 400 };
  assert.deepEqual(cameraPoint(rect, 1920, 1080, 220, 240), { x: 0.5, y: 0.5 });
  assert.equal(cameraPoint(rect, 1920, 1080, 220, 50), null);
  const point = cameraPoint(rect, 1920, 1080, 120, 240); assert.equal(point.x, 0.25);
  assert.equal(cameraPoint(rect, 0, 0, 100, 100), null);
});

test('initial autofocus preserves current zoom; rapid updates coalesce and retain independent lens settings', async () => {
  let inFlight = 0, maximum = 0, changed = 0;
  const track = fakeTrack({ capabilities: { zoom: { min: 1, max: 8, step: 0.1 }, focusMode: ['continuous', 'single-shot', 'manual'], focusDistance: { min: 0, max: 10, step: 0.1 } }, settings: { zoom: 2.7, focusMode: 'manual', focusDistance: 1.5 },
    apply: async () => { inFlight++; maximum = Math.max(maximum, inFlight); await new Promise(r => setTimeout(r, 10)); inFlight--; } });
  const control = new TrackControls(track, { supported: { pointsOfInterest: true }, changed: () => { changed++; } });
  await control.initialize();
  assert.equal(track.getSettings().zoom, 2.7); assert.equal(track.getSettings().focusMode, 'continuous');
  const updates = [control.update({ zoom: 1.1 }), control.update({ zoom: 1.5 }), control.update({ zoom: 2.2 }), control.focusAt({ x: 0.25, y: 0.75 })];
  await Promise.all(updates);
  assert.equal(track.getSettings().zoom, 2.2); assert.equal(track.getSettings().focusMode, 'single-shot');
  assert.deepEqual(track.getSettings().pointsOfInterest, [{ x: 0.25, y: 0.75 }]);
  assert.equal(track.calls.length, 2); assert.equal(maximum, 1); assert.equal(changed, 1);
  assert.deepEqual(track.calls[1].width, { ideal: 1920 });
  await control.update({ focusDistance: 6.26 });
  assert.equal(track.getSettings().zoom, 2.2); assert.equal(track.getSettings().focusMode, 'manual'); assert.equal(track.getSettings().focusDistance, 6.3);
});

test('a rejected camera constraint leaves controls usable and does not pretend the setting changed', async () => {
  const track = fakeTrack({ capabilities: { zoom: { min: 1, max: 5, step: 0.1 } }, settings: { zoom: 1.7 }, apply: async c => { if (c.advanced[0].zoom > 3) throw new Error('Device rejected zoom'); } });
  const control = new TrackControls(track);
  await assert.rejects(control.update({ zoom: 4 })); assert.equal(control.busy, false); assert.equal(track.getSettings().zoom, 1.7);
  await control.update({ zoom: 2 }); assert.equal(track.getSettings().zoom, 2);
  await assert.rejects(control.focusAt({ x: 0.5, y: 0.5 }), /lấy nét/);
});

test('stopping a camera cancels queued lens operations', async () => {
  const track = fakeTrack({ capabilities: { zoom: { min: 1, max: 5, step: 0.1 } }, settings: { zoom: 1 } });
  const control = new TrackControls(track), pending = control.update({ zoom: 2 }); control.dispose();
  await assert.rejects(pending, /dừng/); assert.equal(track.calls.length, 0);
});
