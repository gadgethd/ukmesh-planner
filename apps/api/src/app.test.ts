import { describe, expect, it } from 'vitest';
import { buildApp, parseBbox } from './app.js';
import type { LinkQuery, Page, RepeaterQuery } from './snapshot.js';
import type { PlannerObservedLink, PlannerRepeater, SnapshotMeta } from '@ukmesh-planner/contracts';

const A = 'A'.repeat(64);
const B = 'B'.repeat(64);

const meta: SnapshotMeta = {
  id: 'snap-test-1',
  generation: 810,
  fetchedAt: new Date().toISOString(),
  repeaters: 2,
  links: 1,
};

function rep(id: string): PlannerRepeater {
  return {
    canonicalId: id, name: 'R', lat: 54.6, lon: -1.6, lastSeen: new Date().toISOString(),
    isOnline: true, hardwareModel: null, firmwareVersion: null, iata: null,
    advertCount: 1, identityMemberCount: 1,
  };
}

function link(s: string, t: string): PlannerObservedLink {
  return {
    sourceId: s, targetId: t, observedCount: 3, strongObservationCount: 1,
    countAToB: 2, countBToA: 1, lastObserved: new Date().toISOString(),
    pathLossDb: 120, itmViable: true, forceViable: false, evidence: 'observed',
  };
}

interface Calls { repeaterQueries: RepeaterQuery[]; linkQueries: LinkQuery[]; }

function makeDeps(over: {
  meta?: SnapshotMeta | null;
  repeatersPage?: Page<PlannerRepeater>;
  linksPage?: Page<PlannerObservedLink>;
} = {}): { deps: Parameters<typeof buildApp>[0]; calls: Calls } {
  const calls: Calls = { repeaterQueries: [], linkQueries: [] };
  return {
    calls,
    deps: {
      getSnapshotMeta: async () => (over.meta === undefined ? meta : over.meta),
      getRepeaters: async (_id: string, q: RepeaterQuery) => {
        calls.repeaterQueries.push(q);
        return over.repeatersPage ?? { items: [rep(A), rep(B)], nextCursor: null };
      },
      getObservedLinks: async (_id: string, q: LinkQuery) => {
        calls.linkQueries.push(q);
        return over.linksPage ?? { items: [link(A, B)], nextCursor: null };
      },
    },
  };
}

describe('planner api (stage 1)', () => {
  it('/healthz is liveness-only', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('/readyz reports snapshot state', async () => {
    const app = buildApp({ getSnapshotMeta: async () => meta });
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
    const body = res.json() as { bounds: number[]; modelVersion: string; computeBackends: string[] };
    expect(body.bounds).toHaveLength(4);
    expect(body.modelVersion).toMatch(/^rf-model-/);
    expect(body.computeBackends).toContain('cpu');
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
    expect(ready.json().ready).toBe(false);
    expect(ready.json().error).toBe('planner-db-unreachable');
    await app.close();
  });
});

describe('parseBbox', () => {
  it('absent => no filter; parses valid; rejects malformed', () => {
    expect(parseBbox(undefined)).toEqual({ ok: true, bbox: null });
    expect(parseBbox('-2,54,0,55')).toEqual({ ok: true, bbox: [-2, 54, 0, 55] });
    expect(parseBbox('1,2,3')).toEqual({ ok: false });
    expect(parseBbox('0,55,-2,54')).toEqual({ ok: false });
    expect(parseBbox('a,b,c,d')).toEqual({ ok: false });
  });
});

describe('data endpoints', () => {
  it('repeaters: absent bbox => full snapshot (no spatial filter)', async () => {
    const { deps, calls } = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: 'GET', url: '/api/v1/repeaters' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.snapshotId).toBe('snap-test-1');
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
    expect(calls.repeaterQueries[0]!.bbox).toBeNull();
    await app.close();
  });

  it('repeaters: bbox + cursor + limit pass through', async () => {
    const { deps, calls } = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/repeaters?bbox=-2,54,0,55&limit=50&cursor=${A}`,
    });
    expect(res.statusCode).toBe(200);
    const q = calls.repeaterQueries[0]!;
    expect(q.bbox).toEqual([-2, 54, 0, 55]);
    expect(q.limit).toBe(50);
    expect(q.cursor).toBe(A);
    await app.close();
  });

  it('repeaters: invalid bbox/limit/cursor => 400', async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    for (const url of [
      '/api/v1/repeaters?bbox=0,55,-2,54',
      '/api/v1/repeaters?limit=999999',
      '/api/v1/repeaters?cursor=nothex',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });

  it('repeaters: 503 when store absent or no snapshot', async () => {
    const bare = buildApp();
    expect((await bare.inject({ method: 'GET', url: '/api/v1/repeaters' })).statusCode).toBe(503);
    await bare.close();

    const { deps } = makeDeps({ meta: null });
    const app = buildApp(deps);
    const res = await app.inject({ method: 'GET', url: '/api/v1/repeaters' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no-snapshot');
    await app.close();
  });

  it('observed-links: happy path + cursor split', async () => {
    const { deps, calls } = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/observed-links?cursor=${A}:${B}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].evidence).toBe('observed');
    expect(calls.linkQueries[0]!.cursor).toEqual({ sourceId: A, targetId: B });
    const bad = await app.inject({ method: 'GET', url: '/api/v1/observed-links?cursor=nope' });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('snapshot/meta: 200 + 503 paths', async () => {
    const { deps } = makeDeps();
    const app = buildApp(deps);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/snapshot/meta' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().snapshot.id).toBe('snap-test-1');
    await app.close();

    const { deps: d2 } = makeDeps({ meta: null });
    const app2 = buildApp(d2);
    const none = await app2.inject({ method: 'GET', url: '/api/v1/snapshot/meta' });
    expect(none.statusCode).toBe(503);
    await app2.close();
  });

  it('rate limits /api/v1/* but never /healthz', async () => {
    const { deps } = makeDeps();
    const app = buildApp({ ...deps, rateLimit: { windowMs: 60_000, max: 2 } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/config' })).statusCode).toBe(200);
    const third = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(third.statusCode).toBe(429);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    await app.close();
  });
});
