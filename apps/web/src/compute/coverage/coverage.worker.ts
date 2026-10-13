/**
 * Coverage worker — Tier B regional coverage (bounded 50x50 km preview).
 *
 * Backend selection: WebGPU for hardware adapters; the shared CPU core (the
 * parity oracle) otherwise, at reduced detail with a clear notice. Any GPU
 * failure (compile, limits, device loss) re-runs the same input on the CPU
 * core. Nothing here ever touches the VPS.
 */
import type { RfSettings } from '@ukmesh-planner/contracts';
import { chooseCoverageBackend, type GpuLike } from './select.js';
import { WebGpuCoverageEngine, CoverageGpuError } from './webgpu.js';
import { runCoverageCpu } from './kernel-cpu.js';
import { coverageGeometry, COVERAGE_DETAILS, type CoverageDetail } from './params.js';
import { TerrariumTileProvider } from '../terrain-provider.js';

export interface CoverageJobRequest {
  type: 'coverage';
  jobId: number;
  site: { lat: number; lon: number; antennaHeightAglM: number };
  detail: CoverageDetail;
  rf: RfSettings;
  forceBackend?: 'webgpu' | 'cpu' | null;
  /** CPU fallback resolution ceiling (cells per side; default 128). */
  cpuMaxResolution?: number;
}

const CPU_CEILING = 128;
const provider = new TerrariumTileProvider();
const post = (m: unknown, transfer?: Transferable[]): void => {
  (self as unknown as { postMessage(msg: unknown, t?: Transferable[]): void }).postMessage(m, transfer);
};

self.onmessage = (ev: MessageEvent<CoverageJobRequest>) => {
  if (ev.data?.type === 'coverage') void handle(ev.data);
};

async function handle(req: CoverageJobRequest): Promise<void> {
  const t0 = performance.now();
  try {
    const notices: string[] = [];
    const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
    const choice = (await chooseCoverageBackend(gpu, { force: req.forceBackend ?? null })) as {
      backend: 'webgpu' | 'cpu';
      reason: string;
      device?: GPUDevice;
    };
    notices.push(`backend ${choice.backend}: ${choice.reason}`);

    if (choice.backend === 'webgpu' && choice.device) {
      try {
        const gpuOut = await runGpu(req, choice.device, notices);
        post(
          { type: 'coverage-result', jobId: req.jobId, backend: 'webgpu', ...gpuOut, elapsedMs: performance.now() - t0, notices },
          [gpuOut.margins.buffer, gpuOut.codes.buffer],
        );
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notices.push(`WebGPU run failed (${msg}); re-running on the CPU core`);
        if (!(err instanceof Error)) throw err;
      }
    }

    // CPU path (bounded resolution, clear notice when reduced).
    let detail: CoverageDetail = req.detail;
    const ceiling = req.cpuMaxResolution ?? CPU_CEILING;
    if (COVERAGE_DETAILS[detail] > ceiling) {
      detail = ceiling <= 128 ? 'low' : 'medium';
      notices.push(
        `CPU fallback computes at reduced detail (${COVERAGE_DETAILS[detail]} cells vs ${COVERAGE_DETAILS[req.detail]} requested)`,
      );
    }
    const geometry = coverageGeometry(req.site, detail);
    const out = await runCoverageCpu({
      site: req.site,
      geometry,
      rf: req.rf,
      provider,
      onProgress: (done, total) => post({ type: 'coverage-progress', jobId: req.jobId, done, total, backend: 'cpu' }),
    });
    post(
      {
        type: 'coverage-result',
        jobId: req.jobId,
        backend: 'cpu',
        geometry,
        margins: out.margins,
        codes: out.codes,
        counts: out.counts,
        elapsedMs: performance.now() - t0,
        notices,
      },
      [out.margins.buffer, out.codes.buffer],
    );
  } catch (err) {
    post({ type: 'coverage-error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function runGpu(
  req: CoverageJobRequest,
  device: GPUDevice,
  _notices: string[],
): Promise<{ geometry: ReturnType<typeof coverageGeometry>; margins: Float32Array; codes: Uint8Array; counts: number[] }> {
  const geometry = coverageGeometry(req.site, req.detail);
  await provider.warmPoint(req.site);
  const siteElev = provider.elevationAt(req.site);
  if (siteElev === null) throw new CoverageGpuError('site terrain unknown (CPU path reports per-cell unknown)');
  const dem = await provider.windowRaster(
    { x: geometry.centerPx.x - geometry.halfPx, y: geometry.centerPx.y - geometry.halfPx },
    { x: geometry.centerPx.x + geometry.halfPx, y: geometry.centerPx.y + geometry.halfPx },
  );
  if (!dem) throw new CoverageGpuError('DEM window exceeds the memory budget');
  const engine = new WebGpuCoverageEngine(device, '');
  const out = await engine.run({
    site: req.site,
    geometry,
    rf: req.rf,
    siteTopM: siteElev + req.site.antennaHeightAglM,
    dem,
    onProgress: (done, total) => post({ type: 'coverage-progress', jobId: req.jobId, done, total, backend: 'webgpu' }),
  });
  return { geometry, margins: out.margins, codes: out.codes, counts: out.counts };
}
