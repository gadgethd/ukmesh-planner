import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('planner api (stage 1)', () => {
  it('/healthz is liveness-only', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('/readyz reports snapshot state', async () => {
    const app = buildApp({
      getSnapshotMeta: async () => ({
        id: 'test-1',
        generation: 810,
        fetchedAt: new Date().toISOString(),
        repeaters: 10,
        links: 5,
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ready: boolean; snapshot: { generation: number } };
    expect(body.ready).toBe(true);
    expect(body.snapshot.generation).toBe(810);
    await app.close();
  });

  it('/api/v1/config exposes bounds and versions', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      bounds: number[];
      modelVersion: string;
      computeBackends: string[];
    };
    expect(body.bounds).toHaveLength(4);
    expect(body.modelVersion).toMatch(/^rf-model-/);
    expect(body.computeBackends).toContain('wasm');
    await app.close();
  });
});
