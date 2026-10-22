import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import references from '../../fixtures/webgpu/references.json' with { type: 'json' };
import { FIXTURE_NAMES } from './fixtures.js';

test('CPU/WASM/WebGPU deterministic reference renders and numerical parity', async ({ page }, testInfo) => {
  await page.goto('/test/webgpu/index.html');
  await page.waitForFunction(() => 'webgpuHarness' in window);
  for (const name of FIXTURE_NAMES) {
    const result = await page.evaluate(async (name) => (window as any).webgpuHarness.fixture(name), name);
    const path = testInfo.outputPath(`${name}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2));
    await testInfo.attach(`${name}.json`, { path, contentType: 'application/json' });
    console.log(name, JSON.stringify({ parity: result.parity, wasm: result.wasmParity }));
    expect.soft(result.cpu.codes, `${name}: reference codes`).toBe(references.references[name].hashes.codes);
    expect.soft(result.cpu.rgba, `${name}: reference pixels`).toBe(references.references[name].hashes.rgba);
    const marginDelta = result.cpuMarginsMillidb.map((v: number | null, i: number) => {
      const ref = references.references[name].marginsMillidb[i];
      return v === null || ref === null ? (v === ref ? 0 : Infinity) : Math.abs(v - ref!);
    });
    expect.soft(Math.max(...marginDelta), `${name}: Node vs browser CPU millidecibels`).toBeLessThanOrEqual(10);
    expect(result.counts).toEqual(references.references[name].counts);
    expect(result.repeat, `${name}: determinism`).toEqual(result.cpu);
    expect.soft(result.wasm.codes, `${name}: WASM codes`).toBe(result.cpu.codes);
    expect.soft(result.wasm.rgba, `${name}: WASM pixels`).toBe(result.cpu.rgba);
    expect.soft(result.wasmParity.maxDeltaDb, `${name}: WASM margin`).toBeLessThan(0.01);
    expect.soft(result.parity.pass, `${name}: ${JSON.stringify(result.parity)}`).toBe(true);
    await page.locator('canvas').screenshot({ path: testInfo.outputPath(`${name}.png`) });
  }
});
