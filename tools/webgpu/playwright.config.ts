import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
process.env.TMPDIR = resolve(import.meta.dirname, '../../.t');
mkdirSync(process.env.TMPDIR, { recursive: true });
export default defineConfig({
  testDir: '.', testMatch: process.env.WEBGPU_BENCHMARK === '1' ? 'benchmark.spec.ts' : ['parity.spec.ts', 'fallback.spec.ts', 'ui.spec.ts'], workers: 1, timeout: 180_000,
  outputDir: process.env.WEBGPU_BENCHMARK === '1' ? '../../test-results/webgpu-benchmark' : '../../test-results/webgpu',
  reporter: [['list'], ['json', { outputFile: resolve(import.meta.dirname, process.env.WEBGPU_BENCHMARK === '1' ? '../../test-results/webgpu-benchmark/report.json' : '../../test-results/webgpu/report.json') }]],
  use: {
    baseURL: 'http://127.0.0.1:5184', headless: true, screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PARITY_CHROME || undefined,
      args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-dev-shm-usage'],
    },
  },
  webServer: {
    command: 'npm run dev --workspace @ukmesh-planner/web -- --host 127.0.0.1 --port 5184 --strictPort --mode webgpu-test',
    cwd: '../..', url: 'http://127.0.0.1:5184/test/webgpu/index.html', reuseExistingServer: false,
  },
});
