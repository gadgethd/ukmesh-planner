/**
 * WebGPU coverage engine (Tier B). One invocation per output cell; the WGSL
 * mirrors the CPU oracle (see shader.wgsl header). Dispatches are chunked into
 * row bands with progress callbacks; the engine is single-use per device and
 * reports device loss so the caller can fall back to the CPU core.
 */
import type { RfSettings } from '@ukmesh-planner/contracts';
import shaderSource from './shader.wgsl?raw';
import type { CoverageGeometry } from './params.js';

export class CoverageGpuError extends Error {}

export interface CoverageGpuInput {
  site: { lat: number; lon: number; antennaHeightAglM: number };
  geometry: CoverageGeometry;
  rf: RfSettings;
  /** Site terrain elevation + antenna height (ASL), resolved by the caller. */
  siteTopM: number;
  dem: { data: Float32Array; width: number; height: number; originX: number; originY: number };
  onProgress?: (done: number, total: number) => void;
}

export interface CoverageGpuOutput {
  margins: Float32Array;
  codes: Uint8Array;
  counts: number[];
  elapsedMs: number;
}

const PARAMS_FLOATS = 28; // 112 bytes (f32 array; layout mirrors the WGSL struct)
const BAND_ROWS = 64;

export class WebGpuCoverageEngine {
  private pipeline: GPUComputePipeline | null = null;
  private lost = false;
  readonly adapterInfo: string;

  constructor(private readonly device: GPUDevice, adapterInfo = '') {
    this.adapterInfo = adapterInfo;
    void device.lost.then(() => {
      this.lost = true;
    });
  }

  isLost(): boolean {
    return this.lost;
  }

  private check(): void {
    if (this.lost) throw new CoverageGpuError('device lost');
  }

  private async getPipeline(): Promise<GPUComputePipeline> {
    if (this.pipeline) return this.pipeline;
    this.check();
    const module = this.device.createShaderModule({ code: shaderSource });
    // Surface compilation problems as errors instead of validation aborts.
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
      throw new CoverageGpuError(`shader compilation failed: ${errors.map((e) => e.message).join('; ')}`);
    }
    this.pipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    return this.pipeline;
  }

  async run(input: CoverageGpuInput): Promise<CoverageGpuOutput> {
    this.check();
    const t0 = performance.now();
    const { device } = this;
    const { geometry, rf, dem } = input;
    const { width, height } = geometry;
    const total = width * height;

    const demBytes = dem.data.byteLength;
    if (demBytes > device.limits.maxStorageBufferBindingSize || demBytes > device.limits.maxBufferSize) {
      throw new CoverageGpuError(
        `DEM window ${Math.round(demBytes / 1048576)} MiB exceeds device limits (${Math.round(device.limits.maxStorageBufferBindingSize / 1048576)} MiB)`,
      );
    }

    const pipeline = await this.getPipeline();
    this.check();

    const demBuf = device.createBuffer({ size: demBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const marginsBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const codesBuf = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const paramsBuf = device.createBuffer({ size: PARAMS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const stagingMargins = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const stagingCodes = device.createBuffer({ size: total * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    try {
      device.queue.writeBuffer(demBuf, 0, dem.data);

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuf } },
          { binding: 1, resource: { buffer: demBuf } },
          { binding: 2, resource: { buffer: marginsBuf } },
          { binding: 3, resource: { buffer: codesBuf } },
        ],
      });

      const params = new Float32Array(PARAMS_FLOATS);
      params[0] = input.site.lon;
      params[1] = input.site.lat;
      params[2] = input.siteTopM;
      params[3] = rf.rxHeightAglM;
      params[4] = dem.originX;
      params[5] = dem.originY;
      params[6] = dem.width;
      params[7] = dem.height;
      params[8] = geometry.centerPx.x - geometry.halfPx;
      params[9] = geometry.centerPx.y - geometry.halfPx;
      params[10] = geometry.cellPx;
      params[11] = width;
      params[12] = height;
      params[13] = rf.txPowerDbm;
      params[14] = rf.txGainDbi;
      params[15] = rf.rxGainDbi;
      params[16] = rf.rxSensitivityDbm;
      params[17] = rf.marginGreenDb;
      params[18] = rf.marginMarginalDb;
      params[19] = rf.maxRangeKm;
      params[20] = rf.frequencyMhz;
      params[21] = 90; // targetSpacingM (mirrors kernel-cpu)
      params[22] = 24; // minSamples
      params[23] = 512; // maxSamples

      let done = 0;
      for (let row0 = 0; row0 < height; row0 += BAND_ROWS) {
        this.check();
        const rows = Math.min(BAND_ROWS, height - row0);
        params[24] = row0; // rowOffset
        device.queue.writeBuffer(paramsBuf, 0, params);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(rows / 8), 1);
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        done += rows * width;
        input.onProgress?.(done, total);
      }

      // Readback.
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(marginsBuf, 0, stagingMargins, 0, total * 4);
      enc.copyBufferToBuffer(codesBuf, 0, stagingCodes, 0, total * 4);
      device.queue.submit([enc.finish()]);
      await stagingMargins.mapAsync(GPUMapMode.READ);
      await stagingCodes.mapAsync(GPUMapMode.READ);
      const margins = new Float32Array(stagingMargins.getMappedRange().slice(0));
      const codeWords = new Uint32Array(stagingCodes.getMappedRange().slice(0));
      const codes = new Uint8Array(total);
      const counts = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < total; i += 1) {
        const c = codeWords[i] ?? 4;
        codes[i] = c;
        counts[c] = (counts[c] ?? 0) + 1;
      }
      stagingMargins.unmap();
      stagingCodes.unmap();

      return { margins, codes, counts, elapsedMs: performance.now() - t0 };
    } finally {
      for (const b of [demBuf, marginsBuf, codesBuf, paramsBuf, stagingMargins, stagingCodes]) b.destroy();
    }
  }
}
