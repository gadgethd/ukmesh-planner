import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import { CoverageRunner } from './runner.js';
import type { CoverageJobRequest } from './protocol.js';
import type { TerrariumTileProvider } from '../terrain-provider.js';

const fakes = vi.hoisted(() => ({ gpu: vi.fn(), wasm: vi.fn(), cpu: vi.fn(), load: vi.fn(), lost: vi.fn(() => false) }));
vi.mock('./webgpu.js', () => ({ WebGpuCoverageEngine: class { run = fakes.gpu; isLost = fakes.lost; } }));
vi.mock('../wasm/backend.js', () => ({ WasmCoverageCore: { load: fakes.load } }));
vi.mock('./kernel-cpu.js', () => ({ runCoverageCpu: fakes.cpu }));
const out = () => ({ margins: new Float32Array([12]), codes: new Uint8Array([1]), counts: [0, 1, 0, 0, 0, 0] });
const request: CoverageJobRequest = { type: 'coverage', jobId: 17, site: { lat: 55, lon: -1, antennaHeightAglM: 2 }, rf: DEFAULT_UK_RF_SETTINGS, detail: 'medium' };
function setup() {
  const dem = { data: new Float32Array(4), width: 2, height: 2, originX: 0, originY: 0 };
  const provider = { windowRaster: vi.fn(async () => dem), revision: 'fixture-v1', elevationAt: () => 0 } as unknown as TerrariumTileProvider;
  const device = { destroy: vi.fn() };
  const requestDevice = vi.fn(async () => device);
  const gpu = { requestAdapter: vi.fn(async () => ({ info: { vendor: 'hardware' }, requestDevice })) };
  return { runner: new CoverageRunner(gpu, provider), gpu, provider, device, dem, requestDevice };
}
beforeEach(() => {
  vi.clearAllMocks();
  fakes.gpu.mockReset().mockResolvedValue(out()); fakes.wasm.mockReset().mockReturnValue(out());
  fakes.cpu.mockReset().mockResolvedValue(out()); fakes.load.mockReset().mockResolvedValue({ run: fakes.wasm });
  fakes.lost.mockReturnValue(false);
});

describe('worker backend execution and fallback', () => {
  it('reuses a hardware device and engine across compatible jobs', async () => {
    const s = setup();
    expect((await s.runner.run(request, vi.fn())).backend).toBe('webgpu');
    await s.runner.run({ ...request, jobId: 18 }, vi.fn());
    expect(s.requestDevice).toHaveBeenCalledTimes(1); expect(fakes.gpu).toHaveBeenCalledTimes(2);
    expect(s.device.destroy).not.toHaveBeenCalled();
  });
  it.each(['shader compilation', 'device lost', 'allocation', 'validation'])('replays identical input on WASM after %s failure', async (reason) => {
    const s = setup(); fakes.gpu.mockRejectedValue(new Error(reason));
    const result = await s.runner.run(request, vi.fn());
    expect(result.backend).toBe('wasm'); expect(result.notices.join(' ')).toContain(reason);
    const gpuInput = fakes.gpu.mock.calls[0]![0], wasmInput = fakes.wasm.mock.calls[0]![0];
    for (const key of ['site', 'rf', 'geometry', 'dem']) expect(wasmInput[key]).toBe(gpuInput[key]);
    expect(wasmInput.siteTopM).toBe(gpuInput.siteTopM);
    expect(s.provider.windowRaster).toHaveBeenCalledTimes(1); expect(s.device.destroy).toHaveBeenCalledOnce();
    await s.runner.run(request, vi.fn());
    expect(fakes.gpu).toHaveBeenCalledTimes(1); expect(s.requestDevice).toHaveBeenCalledTimes(1);
  });
  it('no WebGPU uses WASM and reuses its module', async () => {
    const s = setup(); const runner = new CoverageRunner(undefined, s.provider);
    expect((await runner.run(request, vi.fn())).backend).toBe('wasm');
    await runner.run(request, vi.fn()); expect(fakes.load).toHaveBeenCalledTimes(1);
  });
  it('a non-Error GPU rejection still falls back', async () => {
    const s = setup(); fakes.gpu.mockRejectedValue('driver unavailable');
    expect((await s.runner.run(request, vi.fn())).backend).toBe('wasm');
  });
  it('falls back to capped CPU when WASM fails; retries WASM next job', async () => {
    const s = setup(); fakes.load.mockRejectedValueOnce(new Error('asset 404')).mockResolvedValue({ run: fakes.wasm });
    const runner = new CoverageRunner(undefined, s.provider);
    const result = await runner.run({ ...request, detail: 'high' }, vi.fn());
    expect(result.backend).toBe('cpu'); expect(result.geometry.width).toBe(128);
    expect(result.notices.join(' ')).toContain('reduced detail'); expect(result.notices.join(' ')).toContain('asset 404');
    expect(fakes.cpu.mock.calls[0]![0].rf).toBe(request.rf);
    expect((await runner.run(request, vi.fn())).backend).toBe('wasm');
  });
  it('replaces a lost device on the next job', async () => {
    const s = setup(); await s.runner.run(request, vi.fn()); fakes.lost.mockReturnValueOnce(true);
    await s.runner.run(request, vi.fn());
    expect(s.device.destroy).toHaveBeenCalledOnce(); expect(s.requestDevice).toHaveBeenCalledTimes(2);
  });
  it('an oversized DEM window falls back to the capped streaming CPU path', async () => {
    const s = setup();
    vi.mocked(s.provider.windowRaster).mockResolvedValue(null);
    const result = await s.runner.run({ ...request, detail: 'high' }, vi.fn());
    expect(result.backend).toBe('cpu'); expect(result.geometry.width).toBe(128);
    expect(result.notices.join(' ')).toContain('memory budget');
    expect(fakes.gpu).not.toHaveBeenCalled(); expect(fakes.load).not.toHaveBeenCalled();
    expect(fakes.cpu.mock.calls[0]![0].provider).toBe(s.provider);
    expect(s.device.destroy).toHaveBeenCalledOnce();
  });
  it('force CPU bypasses GPU and WASM', async () => {
    const s = setup();
    expect((await s.runner.run({ ...request, forceBackend: 'cpu' }, vi.fn())).backend).toBe('cpu');
    expect(s.gpu.requestAdapter).not.toHaveBeenCalled(); expect(fakes.load).not.toHaveBeenCalled();
  });
});
