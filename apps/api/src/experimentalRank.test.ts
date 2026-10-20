import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const candidate = { lat: 54.97, lon: -1.61, antenna_height_m: 10, role: 2 };
const repeaters = [
  { id: 'A', lat: 54.9, lon: -1.7, antenna_height_m: null, role: 2 },
  { id: 'B', lat: 55.1, lon: -1.5, antenna_height_m: 15, role: 2 },
];

const stubBody = {
  model: { version: 'test', artifact_sha256: 'x' },
  semantics: 'relative link ranking only; no probability, no guaranteed connectivity',
  ranking: [{ repeater_id: 'A', rank: 1, score: 0.9, terms: {}, warnings: [] }],
  warnings: [],
};

function stubFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(stubBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('experimental rank proxy', () => {
  it('is not mounted when no service URL is configured', async () => {
    const app = buildApp({});
    const res = await app.inject({ method: 'POST', url: '/api/v1/experimental/rank', payload: { candidate, repeaters } });
    expect(res.statusCode).toBe(404);
  });

  it('proxies a valid request and returns the ranking unchanged', async () => {
    const calls: string[] = [];
    const app = buildApp({ experimentalRank: { url: 'http://rank.test', fetchImpl: stubFetch(calls) } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/experimental/rank', payload: { candidate, repeaters, top_k: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(stubBody);
    expect(calls).toEqual(['http://rank.test/rank']);
  });

  it('rejects invalid coordinates before calling the service', async () => {
    const calls: string[] = [];
    const app = buildApp({ experimentalRank: { url: 'http://rank.test', fetchImpl: stubFetch(calls) } });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/experimental/rank',
      payload: { candidate: { lat: 999, lon: 0 }, repeaters },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty repeater list', async () => {
    const app = buildApp({ experimentalRank: { url: 'http://rank.test', fetchImpl: stubFetch([]) } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/experimental/rank', payload: { candidate, repeaters: [] } });
    expect(res.statusCode).toBe(400);
  });
});
