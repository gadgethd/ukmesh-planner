/** All regional compute stays in this worker; the server only serves data. */
import { CoverageRunner } from './runner.js';
import type { CoverageJobRequest } from './protocol.js';
import type { GpuLike } from './select.js';

const runner = new CoverageRunner((navigator as unknown as { gpu?: GpuLike }).gpu);
const post = (msg: unknown, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage(msg: unknown, t: Transferable[]): void }).postMessage(msg, transfer);
};
// A direct worker consumer gets backpressure too: error scopes, DEM snapshots
// and the WASM scratch memory are never shared by overlapping runs.
let queue = Promise.resolve();
self.onmessage = (ev: MessageEvent<CoverageJobRequest>) => {
  if (ev.data?.type !== 'coverage') return;
  const req = ev.data;
  queue = queue.then(async () => {
    try {
      const out = await runner.run(req, (p) => post(p));
      post(out, [out.margins.buffer, out.codes.buffer]);
    } catch (err) {
      post({ type: 'coverage-error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
    }
  });
};
