import { test, expect } from '@playwright/test';
import { syntheticPhoto } from '../fixtures.js';

async function paired(page, calibrated = false) {
  await page.goto('/'); await expect(page.locator('#qr')).toBeVisible();
  const id = await page.locator('#qr').getAttribute('data-session-id');
  if (calibrated) {
    const photo = await syntheticPhoto();
    const response = await page.request.post(`/api/session/${id}/photo`, { multipart: { photo: { name: 'markers.png', mimeType: 'image/png', buffer: photo.buffer } } });
    expect((await response.json()).ok).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-state', 'display');
  }
  await page.locator('#content-toggle').click();
  return id;
}
const apply = page => page.locator('#content-panel').getByRole('button', { name: 'Áp dụng', exact: true }).click();
const session = async (page, id) => (await page.request.get(`/api/session/${id}`)).json();

test('manual fields, XSS and phone config sync preserve calibration and its localStorage record', async ({ page, browser }) => {
  const id = await paired(page, true), link = await page.locator('#copy-link').getAttribute('title');
  const before = await session(page, id);
  const geometry = await page.locator('#warp').evaluate(node => node.style.transform);
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('anamorphic:calibration:'))));
  const attack = '<script>window.injected=1</script><img src=x onerror=alert(1)>';
  await page.locator('#text-input').fill(attack);
  await page.locator('#content-panel').getByRole('button', { name: 'Thử', exact: true }).click();
  await expect(page.locator('.content-message')).toContainText(attack);
  await apply(page); await expect(page.locator('#poster-text')).toHaveText(attack);
  expect(await page.evaluate(() => window.injected)).toBeUndefined(); await expect(page.locator('#content script')).toHaveCount(0);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage();
  try {
    await phone.goto(new URL(`/capture/${id}${new URL(link).hash}`, page.url()).href); await expect(phone.locator('#done-section')).toBeVisible();
    expect(new URL(phone.url()).hash).toBe('');
    await phone.locator('#phone-content > summary').click();
    await phone.locator('[name="field:title"]').fill('Đổi từ điện thoại'); await apply(phone);
    await expect(page.locator('#poster-text')).toHaveText('Đổi từ điện thoại');
    expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('anamorphic:calibration:'))))).toEqual(stored);
    await page.reload(); await expect(page.locator('#poster-text')).toHaveText('Đổi từ điện thoại');
    expect(await page.locator('#warp').evaluate(node => node.style.transform)).toBe(geometry);
    const after = await session(page, id); expect(after.revision).toBe(before.revision); expect(after.result).toEqual(before.result); expect(after.markers).toEqual(before.markers);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(new URL(link).hash.slice(3));
    const denied = await page.request.put(`/api/session/${id}/content/config`, { data: after.contentConfig }); expect(denied.status()).toBe(403);
  } finally { await context.close(); }
});

test('CORS JSON keeps last good data on errors and iframe explicitly disables raster', async ({ page }) => {
  await paired(page); await page.locator('#preview').click(); await page.locator('#content-toggle').click();
  // Preview opens tuning, which closes the content panel.
  let requests = 0;
  await page.route('https://feed.example/data', route => route.fulfill({ status: ++requests === 1 ? 200 : 503, contentType: 'application/json', body: '{"title":"Dữ liệu thật"}' }));
  await page.locator('[name=adapterId]').selectOption('json'); await page.locator('[name=url]').fill('https://feed.example/data'); await page.locator('[name=interval]').fill('5');
  await apply(page); await expect(page.locator('#poster-text')).toHaveText('Dữ liệu thật');
  await expect(page.locator('#content-status')).toHaveAttribute('data-state', 'stale', { timeout: 12000 });
  await expect(page.locator('#poster-text')).toHaveText('Dữ liệu thật');
  await page.route('https://frame.example/', route => route.fulfill({ contentType: 'text/html', body: '<h1>Trang nhúng</h1>' }));
  await page.locator('[name=adapterId]').selectOption('iframe'); await page.locator('[name=url]').fill('https://frame.example/'); await apply(page);
  await expect(page.locator('#content iframe')).toHaveAttribute('sandbox', '');
  await expect(page.locator('#raster-mode')).toBeDisabled(); await expect(page.locator('#raster')).toBeHidden();
});

test('continuous bursts produce throttled 2× canvases and preserve the old canvas during rendering', async ({ page }) => {
  const id = await paired(page, true), before = await session(page, id);
  await page.evaluate(async () => {
    const { register } = await import('/display/content/runtime.js');
    register('clock', () => {
      let timer, seq = 0;
      return { start({ onData }) { const tick = () => onData({ title: `Tin ${++seq}` }); tick(); timer = setInterval(tick, 10); }, stop() { clearInterval(timer); } };
    });
    window.rasterCalls = [];
    window.html2canvas = async (_node, options) => {
      const number = window.rasterCalls.push({ at: performance.now(), scale: options.scale });
      if (number === 2) await new Promise(resolve => { window.releaseRaster = resolve; });
      const canvas = document.createElement('canvas'); canvas.width = options.width * options.scale; canvas.height = options.height * options.scale;
      const context = canvas.getContext('2d'); context.fillStyle = `rgb(${number},0,0)`; context.fillRect(0, 0, canvas.width, canvas.height); return canvas;
    };
  });
  await page.locator('[name=adapterId]').selectOption('clock'); await page.locator('[name=templateId]').selectOption('ticker'); await apply(page);
  await expect(page.locator('#ticker-text')).toContainText('Tin');
  await page.locator('#content-close').click(); await page.locator('#controls-toggle').click(); await page.locator('#raster-mode').check();
  await expect(page.locator('#raster')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!window.releaseRaster)).toBe(true);
  expect(await page.locator('#raster').evaluate(canvas => [canvas.width, canvas.height, canvas.getContext('2d').getImageData(0, 0, 1, 1).data[0]])).toEqual([1920, 1200, 1]);
  await page.evaluate(() => window.releaseRaster());
  await expect.poll(() => page.evaluate(() => window.rasterCalls.length)).toBeGreaterThanOrEqual(4);
  const calls = await page.evaluate(() => window.rasterCalls); expect(calls.every(call => call.scale === 2)).toBe(true);
  for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThan(590);
  expect((await session(page, id)).revision).toBe(before.revision);
});
