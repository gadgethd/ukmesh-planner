/**
 * Main-thread wrapper around the assess worker.
 *
 * Jobs are gated by id: callers keep only the newest job's results (a drag or
 * antenna-height change supersedes in-flight work without blocking the UI).
 */
import type { RfSettings } from '@ukmesh-planner/contracts';
import type {
  AssessCandidate,
  AssessRequest,
  AssessResponse,
  CandidatesRequest,
  CandidatesResponse,
  ProfileEndpoint,
  ProfileRequest,
  ProfileResponse,
} from './assess.worker.js';

export interface AssessHandle {
  jobId: number;
  done: Promise<AssessResponse>;
}

export interface ProfileHandle {
  jobId: number;
  done: Promise<ProfileResponse>;
}

export interface CandidatesProgress {
  jobId: number;
  done: number;
  total: number;
}

export interface CandidatesHandle {
  jobId: number;
  done: Promise<CandidatesResponse>;
}

export class ComputeClient {
  private readonly worker: Worker;
  private nextJob = 0;
  private pending = new Map<
    number,
    {
      resolve: (r: AssessResponse | ProfileResponse | CandidatesResponse) => void;
      reject: (e: Error) => void;
      onProgress?: (p: CandidatesProgress) => void;
    }
  >();

  constructor() {
    this.worker = new Worker(new URL('./assess.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (
      ev: MessageEvent<
        | AssessResponse
        | ProfileResponse
        | CandidatesResponse
        | { type: 'candidates-progress'; jobId: number; done: number; total: number }
        | { type: 'assess-error' | 'profile-error' | 'candidates-error'; jobId: number; error: string }
      >,
    ) => {
      const msg = ev.data;
      const entry = this.pending.get(msg.jobId);
      if (!entry) return;
      if (msg.type === 'candidates-progress') {
        entry.onProgress?.({ jobId: msg.jobId, done: msg.done, total: msg.total });
        return;
      }
      this.pending.delete(msg.jobId);
      if (msg.type === 'assess-error' || msg.type === 'profile-error' || msg.type === 'candidates-error') {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg as AssessResponse | ProfileResponse | CandidatesResponse);
      }
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
    usablePathLossDb?: number,
  ): AssessHandle {
    this.nextJob += 1;
    const jobId = this.nextJob;
    const done = new Promise<AssessResponse>((resolve, reject) => {
      this.pending.set(jobId, { resolve: (r) => resolve(r as AssessResponse), reject });
    });
    const req: AssessRequest = {
      type: 'assess',
      jobId,
      site,
      candidates,
      rf,
      calibration: usablePathLossDb === undefined ? undefined : { usablePathLossDb },
    };
    this.worker.postMessage(req);
    return { jobId, done };
  }

  startProfile(a: ProfileEndpoint, b: ProfileEndpoint, rf: RfSettings): ProfileHandle {
    this.nextJob += 1;
    const jobId = this.nextJob;
    const done = new Promise<ProfileResponse>((resolve, reject) => {
      this.pending.set(jobId, { resolve: (r) => resolve(r as ProfileResponse), reject });
    });
    const req: ProfileRequest = { type: 'profile', jobId, a, b, rf };
    this.worker.postMessage(req);
    return { jobId, done };
  }

  startCandidates(
    req: Omit<CandidatesRequest, 'type' | 'jobId'>,
    onProgress?: (p: CandidatesProgress) => void,
  ): CandidatesHandle {
    this.nextJob += 1;
    const jobId = this.nextJob;
    const done = new Promise<CandidatesResponse>((resolve, reject) => {
      this.pending.set(jobId, { resolve: (r) => resolve(r as CandidatesResponse), reject, onProgress });
    });
    const message: CandidatesRequest = { type: 'candidates', jobId, ...req };
    this.worker.postMessage(message);
    return { jobId, done };
  }

  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
