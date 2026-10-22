import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import { CoverageClient } from './client.js';
const workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  terminate = vi.fn(); postMessage = vi.fn();
  constructor() { workers.push(this); }
}
const job = { site: { lat: 55, lon: -1, antennaHeightAglM: 2 }, rf: DEFAULT_UK_RF_SETTINGS, detail: 'low' as const };
afterEach(() => { vi.unstubAllGlobals(); workers.length = 0; });
describe('coverage cancellation and worker lifetime', () => {
  it('terminates superseded work and rejects its promise', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new CoverageClient(), a = client.start(job);
    const cancelled = expect(a.done).rejects.toMatchObject({ name: 'AbortError' });
    const b = client.start(job);
    await cancelled; expect(workers[0]!.terminate).toHaveBeenCalledOnce(); expect(workers).toHaveLength(2);
    workers[1]!.onmessage!({ data: { type: 'coverage-result', jobId: b.jobId } });
    await b.done; client.terminate();
  });
  it('reuses idle workers and settles pending promises when terminated', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new CoverageClient(), a = client.start(job);
    workers[0]!.onmessage!({ data: { type: 'coverage-result', jobId: a.jobId } }); await a.done;
    const b = client.start(job); expect(workers).toHaveLength(1);
    const cancelled = expect(b.done).rejects.toMatchObject({ name: 'AbortError' });
    client.terminate(); await cancelled;
  });
});

it('replaces a crashed worker on the next request', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const client = new CoverageClient(), a = client.start(job);
  const failed = expect(a.done).rejects.toThrow('worker failed');
  workers[0]!.onerror!({ message: 'worker failed' }); await failed;
  const b = client.start(job); expect(workers).toHaveLength(2);
  workers[1]!.onmessage!({ data: { type: 'coverage-result', jobId: b.jobId } }); await b.done;
  client.terminate();
});

it('ignores a late error from a superseded worker', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const client = new CoverageClient(), a = client.start(job);
  const oldError = workers[0]!.onerror!;
  const cancelled = expect(a.done).rejects.toMatchObject({ name: 'AbortError' });
  const b = client.start(job); await cancelled;
  oldError({ message: 'late device error' });
  workers[1]!.onmessage!({ data: { type: 'coverage-result', jobId: b.jobId } });
  await expect(b.done).resolves.toMatchObject({ jobId: b.jobId });
  expect(workers[1]!.terminate).not.toHaveBeenCalled(); client.terminate();
});
