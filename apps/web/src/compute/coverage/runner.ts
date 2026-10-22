/** One serial worker session: reuse the selected device, pipeline and WASM core. */
import { chooseCoverageBackend, type BackendChoice, type CoverageBackend, type GpuLike } from './select.js';
import { WebGpuCoverageEngine } from './webgpu.js';
import { runCoverageCpu } from './kernel-cpu.js';
import { WasmCoverageCore } from '../wasm/backend.js';
import { coverageGeometry, COVERAGE_DETAILS, COVERAGE_MODEL_VERSION } from './params.js';
import { TerrariumTileProvider } from '../terrain-provider.js';
import { WindowTerrainProvider } from './window.js';
import type { CoverageJobRequest } from './protocol.js';
import type { CoverageProgressMessage, CoverageResultMessage } from './client.js';

export class CoverageRunner {
  private choice: Promise<BackendChoice<GPUDevice>> | null = null;
  private mode: CoverageBackend | null = null;
  private engine: WebGpuCoverageEngine | null = null;
  private wasm: Promise<WasmCoverageCore> | null = null;

  constructor(private readonly gpu: GpuLike | undefined, private readonly provider = new TerrariumTileProvider()) {}

  async run(req: CoverageJobRequest, progress: (p: CoverageProgressMessage) => void): Promise<CoverageResultMessage> {
    const t0 = performance.now();
    const notices: string[] = [];
    const mode = req.forceBackend ?? null;
    if (this.choice && (mode !== this.mode || this.engine?.isLost())) {
      (await this.choice).device?.destroy();
      this.choice = null;
      this.engine = null;
    }
    this.mode = mode;
    this.choice ??= chooseCoverageBackend<GPUDevice>(this.gpu, { force: mode });
    const choice = await this.choice;
    notices.push(`backend ${choice.backend}: ${choice.reason}`);
    let geometry = coverageGeometry(req.site, req.detail);
    // Freeze a single window before running any backend. A retry cannot silently
    // pick up different tiles or unknowns after cache eviction/network recovery.
    const dem = await this.provider.windowRaster(
      { x: geometry.centerPx.x - geometry.halfPx, y: geometry.centerPx.y - geometry.halfPx },
      { x: geometry.centerPx.x + geometry.halfPx, y: geometry.centerPx.y + geometry.halfPx },
    );
    const provider = dem ? new WindowTerrainProvider(dem, this.provider.revision) : this.provider;
    const siteTopM = (provider.elevationAt(req.site) ?? Number.NaN) + req.site.antennaHeightAglM;
    const onProgress = (backend: CoverageBackend) => (done: number, total: number): void =>
      progress({ type: 'coverage-progress', jobId: req.jobId, done, total, backend });
    const result = (backend: CoverageBackend, out: { margins: Float32Array; codes: Uint8Array; counts: number[] }): CoverageResultMessage => ({
      type: 'coverage-result', jobId: req.jobId, backend, geometry, ...out,
      modelVersion: COVERAGE_MODEL_VERSION, terrainRevision: provider.revision,
      elapsedMs: performance.now() - t0, notices,
    });

    if (choice.backend === 'webgpu' && choice.device) {
      try {
        if (!dem) throw new Error('DEM window exceeds the memory budget');
        this.engine ??= new WebGpuCoverageEngine(choice.device);
        const out = await this.engine.run({ ...req, geometry, dem, siteTopM, onProgress: onProgress('webgpu') });
        return result('webgpu', out);
      } catch (err) {
        notices.push(`WebGPU run failed (${String(err)}); trying the WASM core`);
        choice.device.destroy();
        this.engine = null;
        // A failed device stays disabled for this session/mode, preventing retry
        // storms. A new worker or an explicit mode change probes capability again.
        this.choice = Promise.resolve({ backend: 'wasm', reason: 'previous WebGPU failure — WASM core selected' });
      }
    }
    if (choice.backend !== 'cpu') {
      try {
        if (!dem) throw new Error('DEM window exceeds the memory budget');
        this.wasm ??= WasmCoverageCore.load();
        const core = await this.wasm;
        return result('wasm', core.run({ ...req, geometry, dem, siteTopM, onProgress: onProgress('wasm') }));
      } catch (err) {
        this.wasm = null; // transient asset failure may recover on the next job
        notices.push(`WASM run failed (${String(err)}); re-running on the CPU core`);
      }
    }
    const ceiling = Math.max(128, Math.min(512, req.cpuMaxResolution ?? 128));
    const detail = COVERAGE_DETAILS[req.detail] <= ceiling ? req.detail : ceiling < 256 ? 'low' : 'medium';
    if (detail !== req.detail) notices.push(`CPU fallback computes at reduced detail (${COVERAGE_DETAILS[detail]} cells vs ${COVERAGE_DETAILS[req.detail]} requested)`);
    geometry = coverageGeometry(req.site, detail);
    return result('cpu', await runCoverageCpu({ ...req, geometry, provider, onProgress: onProgress('cpu') }));
  }
}
