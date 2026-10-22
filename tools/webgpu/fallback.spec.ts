import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';

for (const failure of ['compilation', 'device-loss'] as const) {
  test(`real browser ${failure} retries the identical coverage job on WASM`, async ({ page }, testInfo) => {
    await page.goto('/test/webgpu/index.html');
    await page.waitForFunction(() => 'webgpuHarness' in window);
    const result = await page.evaluate(async (failure) => (window as any).webgpuHarness.fallback(failure), failure);
    const path = testInfo.outputPath(`${failure}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2));
    await testInfo.attach('fallback.json', { path, contentType: 'application/json' });
    expect(result.first.backend).toBe('wasm'); expect(result.second.backend).toBe('wasm');
    expect(result.first.notices.join(' ')).toContain('WebGPU run failed');
    expect(result.parity.classificationMismatches).toBe(0); expect(result.parity.maskMismatches).toBe(0);
    expect(result.parity.maxDeltaDb).toBeLessThan(0.01);
    expect(result.repeat).toEqual(result.replay); expect(result.deviceRequests).toBe(1);
  });
}
