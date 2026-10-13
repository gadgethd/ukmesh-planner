/**
 * Main-thread wrapper around the assess worker.
 *
 * Jobs are gated by id: callers keep only the newest job's results (a drag or
 * antenna-height change supersedes in-flight work without blocking the UI).
 */
import type { RfSettings } from '@ukmesh-planner/contracts';
import type { AssessCandidate, AssessRequest, AssessResponse } from './assess.worker.js';

export interface AssessHandle {
  jobId: number;
  done: Promise<AssessResponse>;
}

export class ComputeClient {
  private readonly worker: Worker;
  private nextJob = 0;
  private pending = new Map<number, { resolve: (r: AssessResponse) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./assess.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<AssessResponse | { type: 'assess-error'; jobId: number; error: string }>) => {
      const msg = ev.data;
      const entry = this.pending.get(msg.jobId);
      if (!entry) return;
      this.pending.delete(msg.jobId);
      if (msg.type === 'assess-error') entry.reject(new Error(msg.error));
      else entry.resolve(msg);
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'compute worker error');
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
    };
  }

  startAssess(
    site: { lat: number; lon: number; antennaHeightAglM: number },
    candidates: AssessCandidate[],
    rf: RfSettings,
  ): AssessHandle {
    this.nextJob += 1;
    const jobId = this.nextJob;
    const done = new Promise<AssessResponse>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
    });
    const req: AssessRequest = { type: 'assess', jobId, site, candidates, rf };
    this.worker.postMessage(req);
    return { jobId, done };
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
