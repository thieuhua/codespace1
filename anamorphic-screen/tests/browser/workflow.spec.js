import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { MARKER_IDS } from '../../shared/calibration.js';

async function displaySession(page) {
  await page.goto('/');
  await expect(page.locator('#qr')).toBeVisible();
  await expect(page.locator('#connection-text')).toHaveText('Chưa có điện thoại');
  await page.locator('.marker img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  return page.locator('#qr').evaluate(img => img.dataset.sessionId);
}
async function openPhone(browser, id, testInfo) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  await phone.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Camera denied for fallback coverage', 'NotAllowedError'); };
  });
  await phone.goto(`http://127.0.0.1:3177/capture/${id}`);
  await expect(phone.locator('#session-badge')).toContainText('PHIÊN');
  await expect(phone.locator('#status')).toContainText('camera');
  return { phone, context };
}

test('camera photo → real detection → desktop matrix3d → review → saved calibration and tuning', async ({ page, browser }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const id = await displaySession(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-calibration.png') });
  const photo = await page.screenshot();
  const { phone, context } = await openPhone(browser, id, testInfo);
  phone.on('pageerror', error => errors.push(error.message));
  await phone.screenshot({ path: testInfo.outputPath('phone-capture.png') });
  await phone.locator('#photo-input').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: photo });
  await expect(phone.locator('#review-section')).toBeVisible();
  await expect(phone.locator('#review-instruction')).toContainText('Đã nhận diện đủ 4');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'display');
  await expect(page.locator('#warp')).toHaveCSS('transform', /^matrix3d/);
  await phone.screenshot({ path: testInfo.outputPath('phone-review.png') });
  await phone.locator('#confirm').click(); await expect(phone.locator('#done-section')).toBeVisible();
  await page.keyboard.press('c'); await expect(page.locator('#controls')).toBeVisible();
  await expect(page.locator('#calibration-quality')).toContainText('px');
  await expect(page.locator('#optimize-center')).not.toBeChecked();
  await expect(page.locator('#align-screen')).not.toBeChecked();
  await page.locator('#optimize-center').check(); await page.locator('#align-screen').check();
  await expect(page.locator('#calibration-quality')).toContainText('Góc xoay camera');
  await page.locator('#content-toggle').click();
  await page.locator('#text-input').fill('Phối cảnh đúng\nTừ góc nhìn của tôi');
  await page.locator('#content-panel').getByRole('button', { name: 'Áp dụng', exact: true }).click();
  await expect(page.locator('#poster-text')).toHaveText('Phối cảnh đúng\nTừ góc nhìn của tôi');
  await page.locator('#content-close').click(); await page.locator('#controls-toggle').click();
  await page.locator('#content-width').fill('1000'); await page.locator('#content-width').press('Tab');
  await expect(page.locator('#content')).toHaveCSS('width', '1000px');
  await page.locator('#debug').check(); await expect(page.locator('#debug-outline')).toBeVisible();
  await page.locator('#raster-mode').check(); await expect(page.locator('#raster')).toBeVisible();
  const rasterSize = await page.locator('#raster').evaluate(c => [c.width, c.height]); expect(rasterSize).toEqual([2000, 1200]);
  await page.locator('#raster-mode').uncheck();
  await page.locator('#controls-close').click();
  await page.keyboard.press('w'); await expect(page.locator('#warp')).toHaveCSS('transform', /^matrix\(/);
  await page.keyboard.press('w'); await expect(page.locator('#warp')).toHaveCSS('transform', /^matrix3d/);
  await page.reload(); await expect(page.locator('#connection-text')).toHaveText('Điện thoại đã kết nối');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'display');
  await expect(page.locator('#poster-text')).toHaveText('Phối cảnh đúng\nTừ góc nhìn của tôi');
  await page.locator('#controls-toggle').click();
  await expect(page.locator('#optimize-center')).toBeChecked(); await expect(page.locator('#align-screen')).toBeChecked();
  await page.locator('#controls-close').click();
  await page.screenshot({ path: testInfo.outputPath('desktop-compensated.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'live');
  await expect(page.locator('#live-warning')).toContainText('Viewport');
  await expect(page.locator('#qr')).toHaveAttribute('data-session-id', id);
  expect(errors).toEqual([]);
  await context.close();
});

test('missing markers → manual touch with magnifier, undo, invalid point rejection and correction', async ({ page, browser }, testInfo) => {
  const id = await displaySession(page);
  const { phone, context } = await openPhone(browser, id, testInfo);
  const photo = await sharp({ create: { width: 1000, height: 700, channels: 3, background: '#edf0e5' } }).png().toBuffer();
  await phone.locator('#photo-input').setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: photo });
  await expect(phone.locator('#point-steps')).toBeVisible();
  await expect(phone.locator('#status')).toContainText('0/4');
  await expect(page.locator('#status-text')).toContainText('0/4');
  const tap = async (x, y) => {
    await phone.locator('#photo-canvas').scrollIntoViewIfNeeded();
    const rect = await phone.locator('#photo-canvas').boundingBox();
    await phone.touchscreen.tap(rect.x + rect.width * x, rect.y + rect.height * y);
  };
  await phone.locator('#photo-canvas').scrollIntoViewIfNeeded();
  const canvasRect = await phone.locator('#photo-canvas').boundingBox();
  await phone.mouse.move(canvasRect.x + canvasRect.width / 2, canvasRect.y + canvasRect.height / 2);
  await phone.mouse.down(); await expect(phone.locator('#magnifier')).toBeVisible();
  await phone.mouse.up(); await expect(phone.locator('#magnifier')).toBeHidden(); await phone.locator('#undo').click();
  // Deliberately cross labels first; correction remains possible without a reload.
  for (const [x, y] of [[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]]) await tap(x, y);
  await phone.locator('#confirm').click(); await expect(phone.locator('#status')).toContainText('thứ tự');
  for (let i = 0; i < 4; i++) await phone.locator('#undo').click();
  await tap(0.1, 0.1); await tap(0.9, 0.1);
  await phone.locator('#undo').click(); await expect(phone.locator('#point-steps .placed')).toHaveCount(1);
  await tap(0.9, 0.1); await tap(0.9, 0.9); await tap(0.1, 0.9);
  await phone.locator('#confirm').click();
  await expect(phone.locator('#done-section')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'display');
  await context.close();
});

test('keyboard photo picker preserves three detected markers and asks only for the missing ID', async ({ page, browser }, testInfo) => {
  const id = await displaySession(page);
  const missing = page.locator('.marker[data-id="42"]');
  await missing.evaluate(node => { node.style.visibility = 'hidden'; });
  const photo = await page.screenshot();
  await missing.evaluate(node => { node.style.visibility = ''; });
  const { phone, context } = await openPhone(browser, id, testInfo);
  try {
    await expect(page.locator('#connection-text')).toHaveText('Điện thoại đã kết nối');
    await phone.locator('#photo-label').focus();
    const chooser = phone.waitForEvent('filechooser');
    await phone.keyboard.press('Enter');
    await (await chooser).setFiles({ name: 'three-markers.png', mimeType: 'image/png', buffer: photo });
    await expect(phone.locator('#point-steps .placed')).toHaveCount(3);
    await expect(phone.locator('[data-point="1"]')).toHaveClass(/current/);
    await expect(phone.locator('#review-instruction')).toContainText('2 · trên phải');
    await phone.locator('#photo-canvas').scrollIntoViewIfNeeded();
    const rect = await phone.locator('#photo-canvas').boundingBox();
    await phone.touchscreen.tap(rect.x + rect.width * 0.92, rect.y + rect.height * 0.08);
    await expect(phone.locator('#point-steps .placed')).toHaveCount(4);
    await phone.locator('#confirm').click();
    await expect(phone.locator('#done-heading')).toHaveText('Góc nhìn đã được áp dụng.');
  } finally { await context.close(); }
});

test('preview, local image, QR host editing and invalid session have usable controls', async ({ page, browser }, testInfo) => {
  await displaySession(page);
  await page.locator('.network-settings summary').click();
  await page.locator('#server-url').fill('http://192.168.20.5:3000'); await page.locator('#apply-url').click();
  await expect(page.locator('#camera-security')).toContainText('cần HTTPS');
  await page.locator('#shortcut-help').click(); await expect(page.locator('#shortcut-dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#shortcut-dialog')).toBeHidden();
  await expect(page.locator('#copy-link')).toHaveAttribute('title', /^http:\/\/192.168.20.5:3000\/capture\//);
  await page.locator('#preview').click(); await expect(page.locator('#uncalibrated')).toBeVisible();
  const image = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#d16f42' } }).png().toBuffer();
  await page.locator('#image-input').setInputFiles({ name: 'art.png', mimeType: 'image/png', buffer: image });
  await expect(page.locator('#custom-image')).toBeVisible();
  await page.locator('#remove-image').click(); await expect(page.locator('#custom-image')).toBeHidden();
  await page.locator('#recalibrate').click(); await expect(page.locator('body')).toHaveAttribute('data-state', 'live');
  const previous = await page.locator('#qr').getAttribute('src');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.marker')[1].style.left)).toBe(`${390 * 0.92}px`);
  await page.locator('#pair-button').click();
  await expect(page.locator('#qr')).toHaveAttribute('src', previous);
  await expect(page.locator('#qr')).toBeVisible();
  await expect(page.locator('.marker')).toHaveCount(4);
  const markerCenters = await page.locator('.marker').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));
  expect(markerCenters[1][0]).toBeCloseTo(390 * 0.92, 1);
  await page.screenshot({ path: testInfo.outputPath('narrow-display.png') });
  const invalid = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await invalid.goto('http://127.0.0.1:3177/capture/expired-session'); await expect(invalid.locator('#expired-section')).toBeVisible();
  await invalid.close();
});

test('display reconnects WebSocket and recovers calibration missed while disconnected', async ({ page, request }) => {
  const id = await displaySession(page);
  // Disconnect through the browser's network state without changing the server.
  await page.context().setOffline(true);
  await expect(page.locator('#connection-text')).toHaveText('Đang kết nối lại');
  const photo = await sharp({ create: { width: 1000, height: 700, channels: 3, background: '#fff' } }).png().toBuffer();
  const uploaded = await request.post(`/api/session/${id}/photo`, { multipart: { photo: { name: 'blank.png', mimeType: 'image/png', buffer: photo } } });
  const data = await uploaded.json();
  const result = await request.post(`/api/session/${id}/points`, { data: { photoId: data.photoId, points: MARKER_IDS.map((id, i) => ({ id, x: [80, 920, 920, 80][i], y: [56, 56, 644, 644][i] })) } });
  expect(result.ok()).toBeTruthy();
  await page.context().setOffline(false);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'display', { timeout: 20_000 });
  await expect(page.locator('#connection-text')).toHaveText('Chưa có điện thoại');
});

test('DPR changes and exiting fullscreen restart live in the same paired session', async ({ page }) => {
  const firstId = await displaySession(page);
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(2);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'live');
  await expect(page.locator('#qr')).toHaveAttribute('data-session-id', firstId);
  const secondId = await page.locator('#qr').evaluate(img => img.dataset.sessionId);
  const session = await (await page.request.get(`/api/session/${secondId}`)).json();
  expect(session.viewport.dpr).toBe(2);
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  const beforeExit = await page.locator('#qr').getAttribute('src');
  const before = await (await page.request.get(`/api/session/${secondId}`)).json();
  await page.context().setOffline(true);
  await expect(page.locator('#connection-text')).toHaveText('Đang kết nối lại');
  await page.locator('#fullscreen').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(page.locator('#qr')).toHaveAttribute('src', beforeExit);
  await page.context().setOffline(false);
  await expect.poll(async () => (await (await page.request.get(`/api/session/${secondId}`)).json()).revision).toBeGreaterThan(before.revision);
  await devtools.detach();
});
