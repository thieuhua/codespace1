import { test, expect } from '@playwright/test';
import { syntheticPhoto } from '../fixtures.js';
import { cameraBrowser } from './fake-camera.js';

// The video track and vision worker are real; lens capabilities are simulated
// because CI has no physical autofocus/zoom mechanism to operate or measure.
async function installLensHardware(page, unsupported = false) {
  await page.addInitScript(({ unsupported }) => {
    window.lensCalls = []; window.cameraOpens = [];
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const supported = navigator.mediaDevices.getSupportedConstraints.bind(navigator.mediaDevices);
    navigator.mediaDevices.getSupportedConstraints = () => ({ ...supported(), pointsOfInterest: !unsupported });
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
      { kind: 'videoinput', deviceId: 'wide', label: 'Back Wide Camera' }
    ];
    navigator.mediaDevices.getUserMedia = async constraints => {
      const deviceId = constraints.video.deviceId?.exact || 'ultra';
      window.cameraOpens.push(deviceId);
      const video = { ...constraints.video }; delete video.deviceId;
      const stream = await getMedia({ video, audio: false }), track = stream.getVideoTracks()[0];
      const original = track.getSettings.bind(track);
      let state = unsupported ? {} : { zoom: deviceId === 'wide' ? 2.2 : 1.4, focusMode: 'manual', focusDistance: 1.5 };
      track.getSettings = () => ({ ...original(), deviceId, ...state });
      track.getCapabilities = () => unsupported ? {} : { zoom: { min: 1, max: 8, step: 0.1 }, focusMode: ['continuous', 'single-shot', 'manual'], focusDistance: { min: 0, max: 10, step: 0.1 } };
      track.applyConstraints = async constraints => {
        window.lensCalls.push({ deviceId, constraints });
        await new Promise(resolve => setTimeout(resolve, 45));
        state = { ...state, ...constraints.advanced[0] };
      };
      return stream;
    };
  }, { unsupported });
}

test('camera choice, actual zoom, autofocus/tap/manual focus and sample reset work together without changing pairing', async ({ page }, testInfo) => {
  await page.goto('/'); await expect(page.locator('#qr')).toBeVisible();
  const id = await page.locator('#qr').evaluate(img => new URL(img.src).pathname.split('/')[3]);
  const fixture = await syntheticPhoto(), browser = await cameraBrowser(fixture.buffer, testInfo.outputPath('lens.y4m'));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  try {
    const phone = await context.newPage(); await installLensHardware(phone);
    await phone.goto(`http://127.0.0.1:3177/capture/${id}`);
    await phone.locator('#lens-controls summary').click();
    await expect(phone.locator('#camera-device')).toHaveValue('wide');
    await expect(phone.locator('#camera-zoom-value')).toHaveText('2.2×');
    await expect(phone.locator('#camera-focus-mode')).toHaveValue('continuous');
    expect(await phone.evaluate(() => window.cameraOpens)).toEqual(['ultra', 'wide']);
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    const before = await (await page.request.get(`/api/session/${id}`)).json();
    await phone.locator('[data-zoom="2"]').click();
    await expect(phone.locator('#freeze')).toBeDisabled();
    await expect(phone.locator('#camera-zoom-value')).toHaveText('2×');
    await expect.poll(async () => (await (await page.request.get(`/api/session/${id}`)).json()).revision).toBeGreaterThan(before.revision);
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    const video = phone.locator('#camera-video'); await video.scrollIntoViewIfNeeded();
    const rect = await video.boundingBox();
    await phone.mouse.click(rect.x + rect.width * 0.25, rect.y + rect.height * 0.75);
    await expect(phone.locator('#focus-target')).toBeVisible();
    await expect(phone.locator('#camera-focus-mode')).toHaveValue('single-shot');
    const tap = await phone.evaluate(() => window.lensCalls.findLast(call => call.constraints.advanced[0].pointsOfInterest));
    expect(tap.constraints.advanced[0].pointsOfInterest[0].x).toBeCloseTo(0.25, 2);
    expect(tap.constraints.advanced[0].pointsOfInterest[0].y).toBeCloseTo(0.75, 2);
    expect(tap.constraints.advanced[0].zoom).toBe(2);
    await expect(phone.locator('#camera-device')).toBeEnabled();
    await phone.locator('#camera-focus-mode').selectOption('manual');
    await expect(phone.locator('#camera-focus-distance-controls')).toBeVisible();
    await phone.locator('#camera-focus-distance').evaluate(input => { input.value = '5.3'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await expect(phone.locator('#camera-focus-distance-value')).toHaveText('5.3');
    await expect(phone.locator('#camera-device')).toBeEnabled();
    await phone.locator('#camera-device').selectOption('ultra');
    await expect(phone.locator('#camera-zoom-value')).toHaveText('1.4×');
    await expect(phone.locator('#camera-device')).toBeEnabled();
    await phone.locator('[data-zoom="3"]').click();
    await expect(phone.locator('#camera-zoom-value')).toHaveText('3×');
    await expect(phone.locator('#camera-device')).toBeEnabled();
    await phone.screenshot({ path: testInfo.outputPath('lens-controls.png') });
    await phone.locator('#camera-stop').click(); await phone.locator('#start-camera').click();
    await expect(phone.locator('#camera-device')).toHaveValue('ultra'); await expect(phone.locator('#camera-zoom-value')).toHaveText('3×');
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    const preference = await phone.evaluate(() => JSON.parse(localStorage.getItem('anamorphic:camera:v1')));
    expect(preference.deviceId).toBe('ultra'); expect(preference.zooms.ultra).toBe(3);
    expect((await (await page.request.get(`/api/session/${id}`)).json()).mode).toBe('live');
    expect(await phone.evaluate(() => localStorage.getItem('anamorphic:capture-session:v2'))).toBe(id);
  } finally { await context.close(); await browser.close(); }
});

test('unsupported lens APIs are explained without fake zoom/focus controls or breaking detection', async ({ page }, testInfo) => {
  await page.goto('/'); await expect(page.locator('#qr')).toBeVisible();
  const id = await page.locator('#qr').evaluate(img => new URL(img.src).pathname.split('/')[3]);
  const fixture = await syntheticPhoto(), browser = await cameraBrowser(fixture.buffer, testInfo.outputPath('fixed-lens.y4m'));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  try {
    const phone = await context.newPage(); await installLensHardware(phone, true);
    await phone.goto(`http://127.0.0.1:3177/capture/${id}`);
    await phone.locator('#lens-controls summary').click();
    await expect(phone.locator('#camera-capability-note')).toContainText('không cung cấp điều khiển zoom');
    await expect(phone.locator('#camera-zoom-controls')).toBeHidden();
    await expect(phone.locator('#camera-focus-controls')).toBeHidden();
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    expect(await phone.evaluate(() => window.lensCalls)).toEqual([]);
  } finally { await context.close(); await browser.close(); }
});
