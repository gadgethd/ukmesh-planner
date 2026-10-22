/**
 * Main-thread wrapper around the coverage worker. Jobs are gated by id:
 * callers keep only the newest job's results (a moved site supersedes
 * in-flight work without blocking the UI).
 */
import type { CoverageJobRequest } from './protocol.js';
import type { CoverageGeometry, CoverageDetail } from './params.js';

export interface CoverageProgressMessage {
  type: 'coverage-progress';
  jobId: number;
  done: number;
  total: number;
  backend: string;
}

export interface CoverageResultMessage {
  type: 'coverage-result';
  jobId: number;
  backend: 'webgpu' | 'wasm' | 'cpu';
  modelVersion: string;
  terrainRevision: string;
  geometry: CoverageGeometry;
  margins: Float32Array;
  codes: Uint8Array;
  counts: number[];
  elapsedMs: number;
  notices: string[];
}

export interface CoverageHandle {
  jobId: number;
  done: Promise<CoverageResultMessage>;
}

export class CoverageClient {
  private worker: Worker | null = null;
  private nextJob = 0;
  private pending = new Map<
    number,
    { resolve: (r: CoverageResultMessage) => void; reject: (e: Error) => void; onProgress?: (p: CoverageProgressMessage) => void }
  >();

  private createWorker(): Worker {
    const worker = new Worker(new URL('./coverage.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (
      ev: MessageEvent<CoverageResultMessage | CoverageProgressMessage | { type: 'coverage-error'; jobId: number; error: string }>,
    ) => {
      const msg = ev.data;
      const entry = this.pending.get(msg.jobId);
      if (!entry) return;
      if (msg.type === 'coverage-progress') {
        entry.onProgress?.(msg);
        return;
      }
      this.pending.delete(msg.jobId);
      if (msg.type === 'coverage-error') entry.reject(new Error(msg.error));
      else entry.resolve(msg);
    };
    worker.onerror = (ev) => {
      if (this.worker !== worker) return; // late event from cancelled work
      const err = new Error(ev.message || 'coverage worker error');
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    };
    return worker;
  }

  start(
    job: {
      site: { lat: number; lon: number; antennaHeightAglM: number };
      detail: CoverageDetail;
      rf: CoverageJobRequest['rf'];
      forceBackend?: 'webgpu' | 'wasm' | 'cpu' | null;
    },
    onProgress?: (p: CoverageProgressMessage) => void,
  ): CoverageHandle {
    // Terminating a busy worker cancels synchronous WASM/CPU work as well as
    // GPU dispatches. An idle worker retains its device/pipeline/terrain cache.
    if (this.pending.size > 0) this.cancel();
    this.worker ??= this.createWorker();
    this.nextJob += 1;
    const jobId = this.nextJob;
    const done = new Promise<CoverageResultMessage>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject, onProgress });
    });
    const req: CoverageJobRequest = { type: 'coverage', jobId, ...job };
    this.worker.postMessage(req);
    return { jobId, done };
  }

  cancel(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    for (const entry of this.pending.values()) entry.reject(new DOMException('Coverage cancelled', 'AbortError'));
    this.pending.clear();
  }

  terminate(): void {
    this.cancel();
  }
}
