import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

test('benchmark 128², 256² and 512² cells', async ({ page }, testInfo) => {
  test.setTimeout(1_800_000);
  page.on('console', (message) => { if (message.text().startsWith('benchmark completed')) console.log(message.text()); });
  await page.goto('/test/webgpu/index.html');
  await page.waitForFunction(() => 'webgpuHarness' in window);
  const result = await page.evaluate(async () => (window as any).webgpuHarness.benchmark());
  const path = testInfo.outputPath('benchmark.json');
  writeFileSync(path, JSON.stringify(result, null, 2));
  await testInfo.attach('benchmark.json', { path, contentType: 'application/json' });
  console.log(JSON.stringify(result, null, 2));
  expect(result.rows).toHaveLength(3);
  for (const row of result.rows) {
    expect(row.parity.pass, JSON.stringify({ size: row.size, parity: row.parity })).toBe(true);
    expect(row.wasmParity.classificationMismatches).toBe(0);
    expect(row.wasmParity.maxDeltaDb).toBeLessThan(0.01);
  }
});
