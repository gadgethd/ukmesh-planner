/**
 * Coverage backend selection. Pure enough to unit-test with fakes; the worker
 * passes the real `navigator.gpu`.
 *
 * Policy: WebGPU is used for hardware adapters only. Software adapters
 * (SwiftShader/lavapipe/llvmpipe) use WASM for reproducibility and portability
 * across browsers, irrespective of forced-adapter benchmark speed. See
 * docs/performance/benchmarks.md for both current and historical measurements.
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

// Mesa also drives real Intel/AMD GPUs; only its software rasterizers belong here.
const SOFTWARE_HINT = /swiftshader|llvmpipe|lavapipe|softpipe|software/i;

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
