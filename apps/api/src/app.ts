/**
 * Planner API — small, rate-limited, same-origin service.
 *
 * Stage 1 scope: health/readiness + config endpoints and the response shapes
 * the frontend will rely on. Snapshot-backed endpoints arrive in Stage 2
 * (their data flows from the planner datastore, never from the source DB).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import {
  DEFAULT_BOUNDS,
  RF_MODEL_VERSION,
  SOURCE_CONTRACT_VERSION,
  type SnapshotMeta,
} from '@ukmesh-planner/contracts';

export interface AppDeps {
  /** Returns the currently published snapshot metadata ("ready" signal). */
  getSnapshotMeta?: () => Promise<SnapshotMeta | null>;
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Liveness — must not touch any database.
  app.get('/healthz', async () => ({ ok: true }));

  // Readiness — planner datastore / snapshot state.
  app.get('/readyz', async () => {
    const snapshot = deps.getSnapshotMeta ? await deps.getSnapshotMeta() : null;
    return {
      ready: true,
      sourceContract: SOURCE_CONTRACT_VERSION,
      snapshot,
    };
  });

  // Public configuration: bounds, versions, advertised compute backends.
  app.get('/api/v1/config', async () => ({
    bounds: DEFAULT_BOUNDS,
    modelVersion: RF_MODEL_VERSION,
    datasetVersion: null,
    computeBackends: ['wasm', 'webgpu'],
    snapshot: null,
  }));

  return app;
}
