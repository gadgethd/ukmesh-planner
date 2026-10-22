import { makeFixture, outputHashes, compareParity, rgba, type FixtureName } from '../../../../tools/webgpu/fixtures.js';
import { WebGpuCoverageEngine, planGpuCoverage } from '../../src/compute/coverage/webgpu.js';
import { runCoverageCpu } from '../../src/compute/coverage/kernel-cpu.js';
import { WasmCoverageCore } from '../../src/compute/wasm/backend.js';
import { CoverageRunner } from '../../src/compute/coverage/runner.js';
import type { TerrariumTileProvider } from '../../src/compute/terrain-provider.js';
import { chooseCoverageBackend } from '../../src/compute/coverage/select.js';

let engine: WebGpuCoverageEngine;
let device: GPUDevice;
let wasm: WasmCoverageCore;
let adapterDetails: Record<string, string | boolean | undefined> = {};
async function initialize() {
  if (!device) {
    const choice = await chooseCoverageBackend<GPUDevice>(navigator.gpu, { force: 'webgpu' });
    if (!choice.device) throw new Error(`WebGPU required for parity: ${choice.reason}`);
    device = choice.device;
    const info = choice.adapter?.info ?? {};
    adapterDetails = { vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, isFallbackAdapter: choice.adapter?.isFallbackAdapter };
    engine = new WebGpuCoverageEngine(device);
    wasm = await WasmCoverageCore.load();
  }
}
async function fixture(name: FixtureName) {
  await initialize();
  const input = makeFixture(name);
  const cpu = await runCoverageCpu(input);
  const repeat = await runCoverageCpu(input);
  const gpu = await engine.run(input);
  const w = wasm.run(input);
  const canvas = document.querySelector<HTMLCanvasElement>('#coverage')!;
  const source = document.createElement('canvas'); source.width = input.geometry.width; source.height = input.geometry.height;
  source.getContext('2d')!.putImageData(new ImageData(rgba(gpu.codes), source.width, source.height), 0, 0);
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 512); ctx.imageSmoothingEnabled = false; ctx.drawImage(source, 0, 0, 512, 512);
  return { cpu: await outputHashes(cpu), repeat: await outputHashes(repeat), wasm: await outputHashes(w),
    gpu: await outputHashes(gpu), cpuMarginsMillidb: Array.from(cpu.margins, (v) => Number.isFinite(v) ? Math.round(v * 1000) : null), parity: compareParity(cpu, gpu), wasmParity: compareParity(cpu, w), counts: cpu.counts };
}
async function benchmark() {
  await initialize();
  const rows = [];
  for (const [size, halfSizeM] of [[128, 5000], [256, 12500], [512, 25000]] as const) {
    const input = makeFixture('hills', size, halfSizeM);
    // One warm-up of each backend, then three measured full runs. Inputs are
    // already local; GPU times include upload, dispatch, readback and cleanup.
    const cpu = await runCoverageCpu(input);
    const gpu = await engine.run(input);
    const wasmOut = wasm.run(input);
    const parity = compareParity(cpu, gpu), wasmParity = compareParity(cpu, wasmOut);
    const measurements: Record<string, number[]> = { cpu: [], wasm: [], webgpu: [] };
    for (let i = 0; i < 3; i += 1) {
      let t = performance.now(); await runCoverageCpu(input); measurements.cpu!.push(performance.now() - t);
      t = performance.now(); wasm.run(input); measurements.wasm!.push(performance.now() - t);
      t = performance.now(); await engine.run(input); measurements.webgpu!.push(performance.now() - t);
    }
    const medians = Object.fromEntries(Object.entries(measurements).map(([k, v]) => [k, [...v].sort((a,b) => a-b)[1]]));
    const row = { size, areaKm: 2 * halfSizeM! / 1000, outputTiles: Math.ceil(size! / planGpuCoverage(input, device.limits).rows), cells: size * size, demTiles: input.dem.width * input.dem.height / 65536,
      parity, wasmParity, demBytes: input.dem.data.byteLength, band: planGpuCoverage(input, device.limits), measurements, medians };
    rows.push(row);
    console.log('benchmark completed', JSON.stringify(row));
  }
  const auto = await chooseCoverageBackend(navigator.gpu);
  auto.device?.destroy?.();
  return { browser: navigator.userAgent, adapter: adapterDetails, autoBackend: auto.backend,
    limits: { maxBufferSize: device.limits.maxBufferSize, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize }, rows };
}
async function fallback(failure: 'compilation' | 'device-loss') {
  const input = makeFixture('hills', 128);
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU required for failure injection');
  let deviceRequests = 0;
  const gpu = { requestAdapter: async () => ({
    info: { description: 'failure-injection adapter' },
    requestDevice: async () => {
      deviceRequests += 1;
      const actual = await adapter.requestDevice();
      if (failure === 'device-loss') actual.destroy();
      return new Proxy(actual, { get(target, key) {
        if (key === 'createShaderModule' && failure === 'compilation') {
          return () => target.createShaderModule({ code: 'deliberately invalid WGSL' });
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  }) };
  const provider = { revision: input.provider.revision, windowRaster: async () => input.dem,
    elevationAt: input.provider.elevationAt.bind(input.provider) } as unknown as TerrariumTileProvider;
  const runner = new CoverageRunner(gpu, provider);
  const req = { type: 'coverage' as const, jobId: 123, detail: 'low' as const, site: input.site, rf: input.rf };
  const first = await runner.run(req, () => {});
  const second = await runner.run({ ...req, jobId: 124 }, () => {});
  const cpu = await runCoverageCpu(input);
  return { first: { backend: first.backend, notices: first.notices }, second: { backend: second.backend, notices: second.notices },
    parity: compareParity(cpu, first), replay: await outputHashes(first), repeat: await outputHashes(second), deviceRequests };
}
Object.assign(window, { webgpuHarness: { fixture, benchmark, fallback } });
