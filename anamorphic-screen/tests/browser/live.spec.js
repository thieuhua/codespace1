import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { syntheticPhoto } from '../fixtures.js';
import { cameraBrowser } from './fake-camera.js';
import { markerLayout, MARKER_IDS, computeWarp } from '../../shared/calibration.js';
import { apply } from '../../shared/homography.js';

async function pair(page) {
  await page.goto('/'); await expect(page.locator('#qr')).toBeVisible();
  await expect(page.locator('#connection-text')).toHaveText('Chưa có điện thoại');
  return page.locator('#qr').evaluate(img => img.dataset.sessionId);
}

test('real camera track → worker ArUco → live relay → median freeze; both devices reload/reconnect in the same session', async ({ page }, testInfo) => {
  const id = await pair(page), fixture = await syntheticPhoto();
  const browser = await cameraBrowser(fixture.buffer, testInfo.outputPath('markers.y4m'), { width: 1280, height: 896 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  try {
    const phone = await context.newPage(), errors = [], requests = [];
    let inFlight = 0, maximumInFlight = 0;
    phone.on('pageerror', error => errors.push(error.message));
    phone.on('request', request => { if (request.method() === 'POST') requests.push(request.url()); });
    phone.on('websocket', ws => {
      ws.on('framesent', event => { const data = JSON.parse(event.payload); if (['live_points', 'live_status'].includes(data.type)) { inFlight++; maximumInFlight = Math.max(inFlight, maximumInFlight); } });
      ws.on('framereceived', event => { const data = JSON.parse(event.payload); if (data.type === 'frame_ack') inFlight--; });
    });
    await phone.goto(`http://127.0.0.1:3177/capture/${id}`);
    await expect(phone.locator('#camera-section')).toBeVisible();
    await expect(phone.locator('#phone-detected')).toHaveText('4/4 marker', { timeout: 20_000 });
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    await expect(phone.locator('#phone-detection')).toContainText('ms');
    await expect(phone.locator('#phone-reprojection')).toContainText('px');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'live');
    await expect(page.locator('#warp')).toHaveCSS('transform', /^matrix3d/);
    await expect(page.locator('#markers')).toBeVisible();
    await expect(page.locator('#live-detection')).toContainText('ms');
    await expect(page.locator('#live-reprojection')).toContainText('px');
    expect(await page.locator('#markers').evaluate(node => Number(getComputedStyle(node).zIndex))).toBeGreaterThan(20);
    await page.screenshot({ path: testInfo.outputPath('desktop-live.png') });
    await phone.screenshot({ path: testInfo.outputPath('phone-live.png') });
    await phone.locator('#freeze').click();
    await expect(phone.locator('#done-section')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'display');
    await expect(page.locator('#markers')).toBeHidden();
    const locked = await (await page.request.get(`/api/session/${id}`)).json();
    expect(locked.result.samples).toBeGreaterThanOrEqual(1); expect(locked.result.samples).toBeLessThanOrEqual(15);
    expect(locked.result.algorithm).toBe('temporal'); expect(locked.result.imageSize.w).toBe(640);
    expect(locked.result.points.every(p => p.corners.length === 4)).toBe(true);
    expect(locked.result.correspondenceCount).toBe(16); expect(locked.result.reprojectionError).toBeLessThanOrEqual(2);
    expect(maximumInFlight).toBe(1); expect(requests.filter(url => url.endsWith('/photo'))).toEqual([]);
    // A transient initial HTTP failure must not orphan the remembered pairing.
    await phone.route(`**/api/session/${id}`, route => route.abort(), { times: 1 });
    await phone.reload(); await expect(phone.locator('#done-section')).toBeVisible();
    await page.route(`**/api/session/${id}`, route => route.abort(), { times: 1 });
    await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-state', 'display');
    await expect(page.locator('#connection-text')).toHaveText('Điện thoại đã kết nối');
    expect(await page.evaluate(() => localStorage.getItem('anamorphic:display-session:v2'))).toBe(id);
    expect(await phone.evaluate(() => localStorage.getItem('anamorphic:capture-session:v2'))).toBe(id);
    await phone.locator('#reopen-live').click(); await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#start-live').click();
    await expect(phone.locator('#freeze')).toBeDisabled();
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    await phone.locator('#camera-stop').click();
    await expect(page.locator('#live-warning')).toContainText('tạm dừng');
    await phone.locator('#start-camera').click(); await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    await context.setOffline(true); await expect(phone.locator('#session-badge')).toHaveText('ĐANG NỐI LẠI');
    await context.setOffline(false); await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    expect((await (await page.request.get(`/api/session/${id}`)).json()).peers.capture).toBe(1);
    expect(errors).toEqual([]);
  } finally { await context.close(); await browser.close(); }
});

test('single-marker video frames accumulate, update the desktop immediately and freeze with no complete detection frame', async ({ page }, testInfo) => {
  const id = await pair(page);
  const fixtures = await Promise.all(MARKER_IDS.map(id => syntheticPhoto({ markerIds: [id] })));
  const blank = await syntheticPhoto({ blank: true });
  const browser = await cameraBrowser([...fixtures.map(f => f.buffer), blank.buffer], testInfo.outputPath('partial-markers.y4m'), { repeat: 8 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  try {
    const phone = await context.newPage(), packets = [];
    phone.on('websocket', socket => socket.on('framesent', event => { const message = JSON.parse(event.payload); if (message.type === 'live_points') packets.push(message); }));
    await phone.goto(`http://127.0.0.1:3177/capture/${id}`);
    await expect(phone.locator('#phone-tracked')).toHaveText('Nhớ 4/4', { timeout: 20_000 });
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator('#live-tracked')).toHaveText('Nhớ 4/4');
    await expect(page.locator('#warp')).toHaveCSS('transform', /^matrix3d/);
    expect(packets.length).toBeGreaterThanOrEqual(4);
    expect(packets.every(packet => packet.points.length === 1)).toBe(true);
    const first = await page.locator('#warp').evaluate(node => node.style.transform);
    // Wait for the completely blank segment. All remembered coordinates and
    // the freeze action survives only while every ID remains fresh.
    await expect(phone.locator('#phone-detected')).toHaveText('0/4 marker', { timeout: 10_000 });
    await expect(phone.locator('#phone-tracked')).toHaveText('Nhớ 4/4');
    await expect(phone.locator('#freeze')).toBeEnabled();
    expect(await page.locator('#warp').evaluate(node => node.style.transform)).toBe(first);
    await phone.screenshot({ path: testInfo.outputPath('remembered-points.png') });
    await phone.locator('#freeze').click(); await expect(phone.locator('#done-section')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-state', 'display');
    const locked = await (await page.request.get(`/api/session/${id}`)).json();
    expect(locked.result.algorithm).toBe('temporal'); expect(Object.keys(locked.result.sampleCounts)).toHaveLength(4);
    await phone.locator('#reopen-live').click(); await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
    await phone.locator('#clear-tracking').click(); await expect(phone.locator('#freeze')).toBeDisabled();
    await expect(phone.locator('#freeze')).toBeEnabled({ timeout: 20_000 });
  } finally { await context.close(); await browser.close(); }
});

test('QR scanning uses the real jsQR worker when BarcodeDetector is unavailable', async ({ page }, testInfo) => {
  const id = await pair(page), captureURL = `http://127.0.0.1:3177/capture/${id}`;
  const qr = await QRCode.toBuffer(captureURL, { width: 420, margin: 4 });
  const source = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#fff' } }).composite([{ input: qr, left: 110, top: 30 }]).png().toBuffer();
  const browser = await cameraBrowser(source, testInfo.outputPath('qr.y4m'), { width: 640, height: 480 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  try {
    const phone = await context.newPage();
    await phone.addInitScript(() => { delete globalThis.BarcodeDetector; });
    await phone.goto('http://127.0.0.1:3177/capture?scan=1');
    await expect(phone).toHaveURL(captureURL, { timeout: 20_000 });
    await expect(phone.locator('#session-badge')).toContainText(id.slice(0, 8).toUpperCase());
    await expect(page.locator('body')).toHaveAttribute('data-state', 'live');
    await expect(phone.locator('#camera-section')).toBeVisible();
    expect(await phone.evaluate(() => localStorage.getItem('anamorphic:capture-session:v2'))).toBe(id);
  } finally { await context.close(); await browser.close(); }
});

test('invalid horizon keeps the last valid warp and warns instead of blanking the display', async ({ page }) => {
  const id = await pair(page);
  const phone = new WebSocket(`ws://127.0.0.1:3177/ws?session=${id}&role=capture`);
  const messages = []; phone.on('message', b => messages.push(JSON.parse(b)));
  try {
    await once(phone, 'open'); phone.send(JSON.stringify({ type: 'start_live', requestId: 'start' }));
    await expect.poll(() => messages.find(m => m.requestId === 'start')?.ok).toBe(true);
    const revision = messages.find(m => m.requestId === 'start').revision;
    const send = (seq, Q) => phone.send(JSON.stringify({ type: 'live_points', seq, revision, imageSize: { w: 640, h: 400 }, points: Q.map(([x, y], i) => ({ id: MARKER_IDS[i], x, y })), fps: 12 }));
    send(1, [[50, 32], [590, 32], [590, 368], [50, 368]]);
    await expect(page.locator('#live-detected')).toHaveText('4/4 marker');
    const beforeUpdate = await page.locator('#warp').evaluate(node => node.style.transform);
    const Q = [[60, 32], [590, 32], [590, 368], [50, 368]];
    phone.send(JSON.stringify({ type: 'live_points', seq: 2, revision, imageSize: { w: 640, h: 400 }, points: [{ id: 17, x: 60, y: 32 }], fps: 12 }));
    await expect.poll(() => page.locator('#warp').evaluate(node => node.style.transform)).not.toBe(beforeUpdate);
    const expected = computeWarp({ viewport: { vw: 1440, vh: 900, dpr: 1 }, P: markerLayout({ vw: 1440, vh: 900 }), Q, imageSize: { w: 640, h: 400 } }).S;
    const actual = await page.locator('#warp').evaluate(node => {
      const matrix = new DOMMatrix(node.style.transform);
      return [[0, 0], [960, 0], [960, 600], [0, 600]].map(([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(matrix); return [p.x / p.w, p.y / p.w]; });
    });
    actual.forEach((p, i) => expect(Math.hypot(p[0] - expected[i][0], p[1] - expected[i][1])).toBeLessThan(0.1));
    const before = await page.locator('#warp').evaluate(node => node.style.transform);
    const horizon = [0.02, 0, 0, 0, 0.02, 0, -1 / 1400, 0, 1];
    send(3, markerLayout({ vw: 1440, vh: 900 }).map(p => apply(horizon, [p.x, p.y])));
    await expect(page.locator('#live-warning')).toContainText('Giữ kết quả hợp lệ gần nhất');
    await expect(page.locator('#live-warning')).toContainText('chân trời');
    expect(await page.locator('#warp').evaluate(node => node.style.transform)).toBe(before);
    await expect(page.locator('#markers')).toBeVisible();
  } finally { phone.terminate(); }
});
