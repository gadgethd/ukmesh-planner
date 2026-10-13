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

describe('snapshot wiring', () => {
  it('echoes the published snapshot in /readyz and /api/v1/config', async () => {
    const app = buildApp({
      getSnapshotMeta: async () => ({
        id: 'snap-test-1',
        generation: 810,
        fetchedAt: new Date().toISOString(),
        repeaters: 42,
        links: 17,
      }),
    });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().snapshot.id).toBe('snap-test-1');

    const config = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(config.statusCode).toBe(200);
    expect(config.json().datasetVersion).toBe('snap-test-1');
    expect(config.json().snapshot.repeaters).toBe(42);
    await app.close();
  });

  it('reports not-ready when the planner DB is unreachable', async () => {
    const app = buildApp({
      getSnapshotMeta: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    const body = ready.json();
    expect(body.ready).toBe(false);
    expect(body.error).toBe('planner-db-unreachable');

    const config = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(config.statusCode).toBe(200);
    expect(config.json().snapshot).toBeNull();
    await app.close();
  });
});
