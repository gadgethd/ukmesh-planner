/**
 * Coverage backend selection. Pure enough to unit-test with fakes; the worker
 * passes the real `navigator.gpu`.
 *
 * Policy: WebGPU is used for hardware adapters. Software adapters
 * (SwiftShader/lavapipe/llvmpipe) are slower than the CPU core for this
 * workload — documented in docs/performance/benchmarks.md — so the CPU
 * fallback is chosen for them unless the caller explicitly forces webgpu
 * (used by the parity/benchmark tooling).
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

export interface BackendChoice<TDevice = DeviceLike> {
  backend: 'webgpu' | 'cpu';
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
  opts: { force?: 'webgpu' | 'cpu' | null } = {},
): Promise<BackendChoice<TDevice>> {
  if (opts.force === 'cpu') return { backend: 'cpu', reason: 'forced cpu' };
  if (!gpu) return { backend: 'cpu', reason: 'navigator.gpu unavailable' };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { backend: 'cpu', reason: 'no WebGPU adapter' };
    const software = isSoftwareAdapter(adapter);
    if (software && opts.force !== 'webgpu') {
      return {
        backend: 'cpu',
        reason: `software adapter (${adapter.info?.architecture ?? 'fallback'}) — CPU core selected`,
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
    return { backend: 'cpu', reason: `adapter/device request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
