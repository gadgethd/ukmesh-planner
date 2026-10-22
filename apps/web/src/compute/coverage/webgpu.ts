/**
 * WebGPU coverage engine (Tier B). One invocation per output cell; the WGSL
 * mirrors the CPU oracle (see shader.wgsl header). Dispatches are chunked into
 * row bands with progress callbacks; one engine/pipeline is reused per worker.
 * Only one bounded output band is resident on the GPU; any device/validation/
 * allocation failure rejects the job.
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
export const GPU_MAX_DEM_BYTES = 96 * 1024 * 1024;
export const GPU_MAX_BAND_CELLS = 8192;
const WORKGROUP_SIZE = 8;

/** Validate before allocating, including the output/readback buffers and dispatch. */
export function planGpuCoverage(input: CoverageGpuInput, limits: GPUSupportedLimits): { rows: number; bandBytes: number } {
  const { width, height } = input.geometry;
  const { dem } = input;
  if (![width, height, dem.width, dem.height].every((v) => Number.isSafeInteger(v) && v > 0)
      || width > 512 || height > 512 || dem.data.length !== dem.width * dem.height) {
    throw new CoverageGpuError('invalid coverage dimensions (maximum 512 × 512)');
  }
  if (dem.data.byteLength > Math.min(GPU_MAX_DEM_BYTES, limits.maxStorageBufferBindingSize, limits.maxBufferSize)) {
    throw new CoverageGpuError('DEM window exceeds device/memory limits');
  }
  if (limits.maxStorageBuffersPerShaderStage < 3 || limits.maxUniformBuffersPerShaderStage < 1
      || limits.maxUniformBufferBindingSize < PARAMS_FLOATS * 4 || limits.maxBufferSize < PARAMS_FLOATS * 4
      || limits.maxComputeInvocationsPerWorkgroup < 64 || limits.maxComputeWorkgroupSizeX < 8
      || limits.maxComputeWorkgroupSizeY < 8
      || Math.ceil(width / WORKGROUP_SIZE) > limits.maxComputeWorkgroupsPerDimension) {
    throw new CoverageGpuError('device compute/binding limits are insufficient');
  }
  const rows = Math.min(height, 64, Math.floor(GPU_MAX_BAND_CELLS / width),
    limits.maxComputeWorkgroupsPerDimension * WORKGROUP_SIZE,
    Math.floor(Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize) / (width * 4)));
  if (rows < 1) throw new CoverageGpuError('device output buffer limits are insufficient');
  return { rows, bandBytes: rows * width * 4 };
}

export class WebGpuCoverageEngine {
  private pipeline: GPUComputePipeline | null = null;
  private lost = false;
  private busy = false;
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
    this.pipeline = await this.device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    return this.pipeline;
  }

  async run(input: CoverageGpuInput): Promise<CoverageGpuOutput> {
    this.check();
    if (this.busy) throw new CoverageGpuError('coverage engine already running');
    const t0 = performance.now();
    const { device } = this;
    const { geometry, rf, dem } = input;
    const { width, height } = geometry;
    const total = width * height;
    const plan = planGpuCoverage(input, device.limits);
    const buffers: GPUBuffer[] = [];
    this.busy = true;
    // WebGPU reports many failures asynchronously rather than throwing. Never
    // publish readback until every scope has been checked.
    device.pushErrorScope('internal');
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    let scopesPopped = false;
    const popScopes = async (): Promise<void> => {
      scopesPopped = true;
      const errors = await Promise.all([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()]);
      const error = errors.find((e) => e !== null);
      if (error) throw new CoverageGpuError(`WebGPU error: ${error.message}`);
      this.check();
    };
    const alloc = (size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const b = device.createBuffer({ size, usage });
      buffers.push(b); // includes partial allocation failures in cleanup
      return b;
    };
    try {
      const pipeline = await this.getPipeline();
      this.check();
      const demBuf = alloc(dem.data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const marginsBuf = alloc(plan.bandBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const codesBuf = alloc(plan.bandBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const paramsBuf = alloc(PARAMS_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      const stagingMargins = alloc(plan.bandBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
      const stagingCodes = alloc(plan.bandBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
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
      params[25] = Number.NaN; // nanValue (runtime NaN for the shader)

      const margins = new Float32Array(total);
      const codes = new Uint8Array(total);
      const counts = [0, 0, 0, 0, 0, 0];
      for (let row0 = 0; row0 < height; row0 += plan.rows) {
        this.check();
        const rows = Math.min(plan.rows, height - row0);
        const cells = rows * width;
        const bytes = cells * 4;
        params[24] = row0;
        params[26] = rows;
        device.queue.writeBuffer(paramsBuf, 0, params);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(rows / 8), 1);
        pass.end();
        encoder.copyBufferToBuffer(marginsBuf, 0, stagingMargins, 0, bytes);
        encoder.copyBufferToBuffer(codesBuf, 0, stagingCodes, 0, bytes);
        device.queue.submit([encoder.finish()]);
        await Promise.all([stagingMargins.mapAsync(GPUMapMode.READ), stagingCodes.mapAsync(GPUMapMode.READ)]);
        this.check();
        margins.set(new Float32Array(stagingMargins.getMappedRange(0, bytes)), row0 * width);
        const words = new Uint32Array(stagingCodes.getMappedRange(0, bytes));
        for (let i = 0; i < cells; i += 1) {
          const c = words[i]!;
          if (c > 5) throw new CoverageGpuError('invalid cell code in GPU readback');
          codes[row0 * width + i] = c;
          counts[c] = (counts[c] ?? 0) + 1;
        }
        stagingMargins.unmap();
        stagingCodes.unmap();
        input.onProgress?.((row0 + rows) * width, total);
      }
      await popScopes();
      return { margins, codes, counts, elapsedMs: performance.now() - t0 };
    } finally {
      try {
        if (!scopesPopped) await popScopes();
      } finally {
        for (const b of buffers) b.destroy();
        this.busy = false;
      }
    }
  }
}
