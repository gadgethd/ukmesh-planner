/**
 * Coverage backend selection. Pure enough to unit-test with fakes; the worker
 * passes the real `navigator.gpu`.
 *
 * Policy: WebGPU is used for hardware adapters only. Software adapters
 * (SwiftShader/lavapipe/llvmpipe) measured comparable to the WASM core for
 * this workload (1.9 s vs 2.3 s at 128x128 — docs/performance/benchmarks.md);
 * the WASM core is selected for them anyway because it is parity-verified
 * and does not depend on software-WebGPU support varying by browser.
 * Anything without a usable hardware adapter gets the WASM core; the JS CPU
 * core (the parity oracle) is the fallback of last resort when the WASM
 * asset cannot run, and can be forced explicitly by the parity tooling.
 */

export interface GpuLike {
  requestAdapter(options?: { powerPreference?: string }): Promise<AdapterLike | null>;
}

export interface AdapterLike {
  isFallbackAdapter?: boolean;
  info?: { architecture?: string; description?: string; vendor?: string; device?: string };
  requestDevice(): Promise<DeviceLike>;
  limits?: { maxStorageBufferBindingSize?: number; maxBufferSize?: number };
}

export interface DeviceLike {
  destroy?: () => void;
}

export type CoverageBackend = 'webgpu' | 'wasm' | 'cpu';

export interface BackendChoice<TDevice = DeviceLike> {
  backend: CoverageBackend;
  reason: string;
  adapter?: AdapterLike;
  device?: TDevice;
}

const SOFTWARE_HINT = /swiftshader|llvmpipe|lavapipe|softpipe|software|mesa\b/i;

export function isSoftwareAdapter(adapter: Pick<AdapterLike, 'isFallbackAdapter' | 'info'>): boolean {
  if (adapter.isFallbackAdapter === true) return true;
  const info = adapter.info ?? {};
  const hay = `${info.architecture ?? ''} ${info.description ?? ''} ${info.vendor ?? ''} ${info.device ?? ''}`;
  return SOFTWARE_HINT.test(hay);
}

export async function chooseCoverageBackend<TDevice extends DeviceLike = DeviceLike>(
  gpu: GpuLike | undefined,
  opts: { force?: CoverageBackend | null } = {},
): Promise<BackendChoice<TDevice>> {
  if (opts.force === 'cpu') return { backend: 'cpu', reason: 'forced cpu' };
  if (opts.force === 'wasm') return { backend: 'wasm', reason: 'forced wasm' };
  if (!gpu) return { backend: 'wasm', reason: 'navigator.gpu unavailable — WASM core selected' };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { backend: 'wasm', reason: 'no WebGPU adapter — WASM core selected' };
    const software = isSoftwareAdapter(adapter);
    if (software && opts.force !== 'webgpu') {
      return {
        backend: 'wasm',
        reason: `software adapter (${adapter.info?.architecture ?? 'fallback'}) — WASM core selected`,
        adapter,
      };
    }
    const device = (await adapter.requestDevice()) as TDevice;
    return {
      backend: 'webgpu',
      reason: software ? 'software adapter (forced)' : 'hardware adapter',
      adapter,
      device,
    };
  } catch (err) {
    return {
      backend: 'wasm',
      reason: `adapter/device request failed: ${err instanceof Error ? err.message : String(err)} — WASM core selected`,
    };
  }
}
