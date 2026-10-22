import { writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

async function offlineApp(page: Page, mode: 'gpu' | 'no-gpu') {
  // Generate a valid 256² Terrarium tile (50 m ASL) in the browser. It is served
  // only by this test route; no live terrain/snapshot service is contacted.
  const tile = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d')!; ctx.fillStyle = 'rgb(128,50,0)'; ctx.fillRect(0, 0, 256, 256);
    return c.toDataURL().split(',')[1]!;
  });
  await page.route('**/terrain-tiles/**', (r) => r.fulfill({ contentType: 'image/png', body: Buffer.from(tile, 'base64') }));
  await page.route('https://**/*', (r) => r.abort());
  await page.route('**/api/**', (r) => r.fulfill({ json: r.request().url().includes('/config')
    ? { snapshot: { id: 'offline-fixture', generation: 1, fetchedAt: new Date().toISOString(), repeaters: 0, links: 0 } }
    : { items: [], nextCursor: null } }));
  await page.addInitScript((mode) => {
    if (mode === 'gpu') (window as any).__plannerForceBackend = 'webgpu';
    if (mode === 'no-gpu') {
      // Strip GPU in both page and worker realms, including Vite's development
      // module-worker wrappers. The production worker code remains unmodified.
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          const moduleUrl = new URL(String(url), location.href).href;
          const source = `
            const queued = [];
            const collect = (e) => queued.push(e.data);
            self.addEventListener('message', collect);
            Object.defineProperty(navigator, 'gpu', { value: undefined });
            // A blob worker has no HTTP base URL. Preserve the original worker's
            // root-relative terrain/WASM fetch semantics in this test wrapper.
            const base = ${JSON.stringify(moduleUrl)};
            const originalFetch = self.fetch.bind(self);
            self.fetch = (url, init) => originalFetch(
              typeof url === 'string' || url instanceof URL ? new URL(String(url), base) : url, init);
            await import(base);
            self.removeEventListener('message', collect);
            for (const data of queued) self.dispatchEvent(new MessageEvent('message', { data }));
          `;
          super(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })), { ...options, type: 'module' });
        }
      };
      Object.defineProperty(navigator, 'gpu', { value: undefined });
    }
  }, mode);
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__plannerMap);
  await page.evaluate(() => {
    const map = (window as any).__plannerMap;
    map.jumpTo({ center: [-1.6237, 54.9648], zoom: 9, pitch: 0, bearing: 0 });
    map.fire('click', { lngLat: { lng: -1.6237, lat: 54.9648 } });
  });
  await page.getByLabel('Show coverage preview', { exact: false }).check();
  // Use low detail for the same bounded output in desktop and mobile tests.
  await page.getByRole('button', { name: /low/i, exact: false }).click();
  await page.waitForFunction(() => ['done', 'error'].includes((window as any).__planner?.coverage.status), {}, { timeout: 120_000 });
  const status = await page.evaluate(() => ({ state: (window as any).__planner?.coverage, errors: (window as any).__errs }));
  expect(status.state.status, JSON.stringify(status)).toBe('done');
}

for (const mode of ['gpu', 'no-gpu'] as const) {
  test(`${mode}: Simple coverage renders on desktop and mobile`, async ({ page }, testInfo) => {
    await page.setViewportSize(mode === 'gpu' ? { width: 1280, height: 800 } : { width: 390, height: 844 });
    await offlineApp(page, mode);
    const result = await page.evaluate(() => {
      const w = window as any;
      return { coverage: w.__planner.coverage, layer: !!w.__plannerMap.getLayer('coverage-raster'), source: !!w.__plannerMap.getSource('coverage') };
    });
    expect(result.coverage.backend).toBe(mode === 'gpu' ? 'webgpu' : 'wasm');
    expect(result.coverage.counts[4]).toBe(0);
    expect(result.coverage.counts[0]).toBeGreaterThan(0);
    expect(result.coverage.counts.reduce((a: number,b: number) => a+b, 0)).toBe(128 * 128);
    await expect.poll(async () => page.evaluate(() => !!(window as any).__plannerMap.getLayer('coverage-raster'))).toBe(true);
    const path = testInfo.outputPath('coverage.json');
    writeFileSync(path, JSON.stringify(result, null, 2));
    await testInfo.attach('coverage.json', { path, contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath(`${mode}.png`) });
    // Simulate visibility without relying on headless window focus semantics.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => page.evaluate(() => (window as any).__planner?.coverage.status)).toBe('idle');
    await expect.poll(async () => page.evaluate(() => !!(window as any).__plannerMap.getLayer('coverage-raster'))).toBe(false);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => (window as any).__planner?.coverage.status === 'done', {}, { timeout: 120_000 });
    expect(await page.evaluate(() => (window as any).__planner.coverage.backend)).toBe(mode === 'gpu' ? 'webgpu' : 'wasm');
    await page.getByLabel('Show coverage preview', { exact: false }).uncheck();
    await expect.poll(async () => page.evaluate(() => !!(window as any).__plannerMap.getLayer('coverage-raster'))).toBe(false);
  });
}
