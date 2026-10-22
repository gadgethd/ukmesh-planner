import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import { coverageGeometry } from './params.js';
import { WebGpuCoverageEngine, planGpuCoverage, type CoverageGpuInput } from './webgpu.js';

const limits = {
  maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 256 * 1024 * 1024,
  maxStorageBuffersPerShaderStage: 8, maxUniformBuffersPerShaderStage: 12, maxUniformBufferBindingSize: 65536,
  maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupsPerDimension: 65535,
} as GPUSupportedLimits;
const input = (width = 128, height = 128): CoverageGpuInput => ({
  site: { lat: 55, lon: -1, antennaHeightAglM: 2 }, siteTopM: 52,
  geometry: { ...coverageGeometry({ lat: 55, lon: -1 }, 'low'), width, height },
  rf: DEFAULT_UK_RF_SETTINGS, dem: { data: new Float32Array(16), width: 4, height: 4, originX: 0, originY: 0 },
});

function fakeDevice(options: { compilationError?: boolean; allocationFailure?: number; scopeError?: string; loseOnMap?: boolean } = {}) {
  let lose!: () => void;
  const lost = new Promise<void>((resolve) => { lose = resolve; });
  const buffers: any[] = [], dispatches: number[][] = [], params: number[][] = [];
  const device = {
    limits, lost,
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => options.scopeError ? { message: options.scopeError } : null),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: options.compilationError ? [{ type: 'error', message: 'bad WGSL' }] : [] }) })),
    createComputePipelineAsync: vi.fn(async () => ({ getBindGroupLayout: () => ({}) })),
    createBuffer: vi.fn(({ size }: { size: number }) => {
      if (buffers.length === options.allocationFailure) throw new Error('allocation failed');
      const data = new ArrayBuffer(size);
      const buffer = { size, destroy: vi.fn(), unmap: vi.fn(), getMappedRange: (offset = 0, length = size) => data.slice(offset, offset + length),
        mapAsync: async () => { if (options.loseOnMap) lose(); } };
      buffers.push(buffer); return buffer;
    }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginComputePass: () => ({ setPipeline: () => {}, setBindGroup: () => {},
      dispatchWorkgroups: (...args: number[]) => dispatches.push(args), end: () => {} }), copyBufferToBuffer: () => {}, finish: () => ({}) }),
    queue: { writeBuffer: (_b: unknown, _offset: number, data: Float32Array) => { if (data.length === 28) params.push(Array.from(data)); }, submit: () => {} },
  } as unknown as GPUDevice;
  return { device, buffers, dispatches, params, lose };
}

afterEach(() => vi.unstubAllGlobals());

describe('GPU budget planning', () => {
  it('bounds output to 8192 cells and honours smaller device limits', () => {
    expect(planGpuCoverage(input(512, 512), limits)).toEqual({ rows: 16, bandBytes: 32768 });
    expect(planGpuCoverage(input(128, 128), { ...limits, maxComputeWorkgroupsPerDimension: 16 })).toEqual({ rows: 64, bandBytes: 32768 });
    expect(planGpuCoverage(input(17, 19), { ...limits, maxStorageBufferBindingSize: 272 })).toEqual({ rows: 4, bandBytes: 272 });
  });
  it.each([
    { maxStorageBufferBindingSize: 32 }, { maxBufferSize: 32 }, { maxStorageBuffersPerShaderStage: 2 },
    { maxComputeInvocationsPerWorkgroup: 32 }, { maxComputeWorkgroupSizeX: 4 }, { maxComputeWorkgroupSizeY: 4 },
    { maxUniformBuffersPerShaderStage: 0 }, { maxUniformBufferBindingSize: 64 }, { maxComputeWorkgroupsPerDimension: 1 },
  ])('rejects insufficient limits before allocation: %j', (patch) => {
    expect(() => planGpuCoverage(input(), { ...limits, ...patch })).toThrow(/limits/);
  });
  it.each([[0, 128], [128, -1], [1.5, 128], [513, 128], [128, 513]])('rejects invalid raster %i × %i', (w, h) => {
    expect(() => planGpuCoverage(input(w, h), limits)).toThrow(/dimensions/);
  });
  it('rejects mismatched DEM dimensions', () => {
    const job = input(); job.dem.width = 10;
    expect(() => planGpuCoverage(job, limits)).toThrow(/dimensions/);
  });
});

describe('GPU lifecycle and asynchronous errors', () => {
  function engine(options: Parameters<typeof fakeDevice>[0] = {}) {
    vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8, MAP_READ: 16 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const fake = fakeDevice(options);
    return { ...fake, engine: new WebGpuCoverageEngine(fake.device) };
  }
  it('dispatches bounded bands, handles the partial last band, reuses pipeline and frees buffers', async () => {
    const f = engine();
    const onProgress = vi.fn();
    const out = await f.engine.run({ ...input(512, 19), onProgress });
    expect(f.dispatches).toEqual([[64, 2, 1], [64, 1, 1]]);
    expect(f.params.map((p) => [p[24], p[26]])).toEqual([[0, 16], [16, 3]]);
    expect(onProgress.mock.calls).toEqual([[8192, 9728], [9728, 9728]]);
    expect(out.codes.length).toBe(9728); expect(out.counts[0]).toBe(9728);
    await f.engine.run(input());
    expect(f.device.createComputePipelineAsync).toHaveBeenCalledTimes(1);
    expect(f.buffers.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(6);
  });
  it('fails on WGSL compilation errors', async () => {
    const f = engine({ compilationError: true });
    await expect(f.engine.run(input())).rejects.toThrow('bad WGSL');
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
  });
  it('frees partially allocated buffers', async () => {
    const f = engine({ allocationFailure: 3 });
    await expect(f.engine.run(input())).rejects.toThrow('allocation failed');
    expect(f.buffers).toHaveLength(3);
    expect(f.buffers.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
  });
  it.each(['validation', 'out of memory', 'internal'])('never returns output after a scoped %s error', async (message) => {
    const f = engine({ scopeError: message });
    await expect(f.engine.run(input())).rejects.toThrow(message);
    expect(f.buffers.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
  });
  it('rejects device loss during readback and releases allocations', async () => {
    const f = engine({ loseOnMap: true });
    await expect(f.engine.run(input())).rejects.toThrow('device lost');
    expect(f.buffers.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
  });
  it('rejects concurrent use instead of overlapping device error scopes', async () => {
    const f = engine();
    const first = f.engine.run(input());
    await expect(f.engine.run(input())).rejects.toThrow('already running');
    await first;
  });
});
