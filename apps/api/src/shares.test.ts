import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { MemoryShareStore } from './shares.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-10-13T12:00:00.000Z');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Controllable clock, so TTL/expiry are exercised deterministically. */
function makeClock(start: Date): { now: () => Date; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

function makeApp(): { app: ReturnType<typeof buildApp>; clock: ReturnType<typeof makeClock> } {
  const clock = makeClock(START);
  const store = new MemoryShareStore(clock.now);
  return { app: buildApp({ shareStore: store }), clock };
}

type Created = { id: string; revokeToken: string; expiresAt: string };

async function createShare(
  app: ReturnType<typeof buildApp>,
  plan: Record<string, unknown>,
  ttlDays?: number,
): Promise<Created> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/shares',
    payload: ttlDays === undefined ? { plan } : { plan, ttlDays },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Created;
}

describe('shares api (stage 6)', () => {
  it('create: 201 with UUID id/revokeToken and 30-day default TTL', async () => {
    const { app } = makeApp();
    const body = await createShare(app, { site: { lat: 54.6 }, rf: { power: 27 } });
    expect(body.id).toMatch(UUID_RE);
    expect(body.revokeToken).toMatch(UUID_RE);
    expect(new Date(body.expiresAt).getTime()).toBe(START.getTime() + 30 * DAY_MS);
    await app.close();
  });

  it('create: explicit ttlDays is honoured (1..90)', async () => {
    const { app } = makeApp();
    const oneDay = await createShare(app, { a: 1 }, 1);
    expect(new Date(oneDay.expiresAt).getTime()).toBe(START.getTime() + 1 * DAY_MS);
    const maxDays = await createShare(app, { a: 1 }, 90);
    expect(new Date(maxDays.expiresAt).getTime()).toBe(START.getTime() + 90 * DAY_MS);
    await app.close();
  });

  it('create: invalid ttl or non-object plan => 400', async () => {
    const { app } = makeApp();
    const bad: Record<string, unknown>[] = [
      { plan: {}, ttlDays: 0 },
      { plan: {}, ttlDays: 91 },
      { plan: {}, ttlDays: 1.5 },
      { plan: {}, ttlDays: '30' },
      { plan: null },
      { plan: [] },
      { plan: 'not-an-object' },
      { plan: 42 },
      { plan: true },
      {},
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/shares', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe('invalid-request');
    }
    await app.close();
  });

  it('create: plan over 64KiB => 413, exactly 64KiB is accepted', async () => {
    const { app } = makeApp();
    const tooBig = await app.inject({
      method: 'POST',
      url: '/api/v1/shares',
      payload: { plan: { blob: 'x'.repeat(64 * 1024) } },
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toBe('payload-too-large');

    // Fill to exactly the cap using the real JSON encoding, then confirm it passes.
    const plan: Record<string, unknown> = { s: '' };
    plan['s'] = 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(plan), 'utf8'));
    expect(Buffer.byteLength(JSON.stringify(plan), 'utf8')).toBe(64 * 1024);
    const atCap = await app.inject({ method: 'POST', url: '/api/v1/shares', payload: { plan } });
    expect(atCap.statusCode).toBe(201);
    await app.close();
  });

  it('get: round-trip preserves the exact nested plan', async () => {
    const { app } = makeApp();
    const plan = {
      name: 'Site A',
      site: { lat: 54.6789, lon: -1.6234, heightM: 12.5 },
      repeaters: [
        { id: 'r1', enabled: true, params: { freq: 869.525, sf: 11, txPower: 27 } },
        { id: 'r2', enabled: false, params: null },
      ],
      notes: 'nested ✓ unicode',
    };
    const created = await createShare(app, plan);
    const res = await app.inject({ method: 'GET', url: `/api/v1/shares/${created.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plan: unknown; expiresAt: string };
    expect(body.plan).toEqual(plan);
    expect(new Date(body.expiresAt).getTime()).toBe(new Date(created.expiresAt).getTime());
    await app.close();
  });

  it('revoke: correct token => 200, then get and re-revoke both 410 revoked', async () => {
    const { app } = makeApp();
    const created = await createShare(app, { a: 1 });
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/shares/${created.id}/revoke`,
      payload: { revokeToken: created.revokeToken },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ revoked: true });

    const get = await app.inject({ method: 'GET', url: `/api/v1/shares/${created.id}` });
    expect(get.statusCode).toBe(410);
    expect(get.json().error).toBe('revoked');

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/shares/${created.id}/revoke`,
      payload: { revokeToken: created.revokeToken },
    });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toBe('revoked');
    await app.close();
  });

  it('revoke: wrong token => 403 and the share stays live', async () => {
    const { app } = makeApp();
    const created = await createShare(app, { a: 1 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/shares/${created.id}/revoke`,
      payload: { revokeToken: 'definitely-not-the-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('bad-token');

    const get = await app.inject({ method: 'GET', url: `/api/v1/shares/${created.id}` });
    expect(get.statusCode).toBe(200);
    // A wrong-token attempt must not have revoked it: the right token still works.
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/shares/${created.id}/revoke`,
      payload: { revokeToken: created.revokeToken },
    });
    expect(revoke.statusCode).toBe(200);
    await app.close();
  });

  it('unknown id => 404 for get and revoke', async () => {
    const { app } = makeApp();
    const id = '00000000-0000-4000-8000-000000000000';
    const get = await app.inject({ method: 'GET', url: `/api/v1/shares/${id}` });
    expect(get.statusCode).toBe(404);
    expect(get.json().error).toBe('not-found');
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/shares/${id}/revoke`,
      payload: { revokeToken: 'anything' },
    });
    expect(revoke.statusCode).toBe(404);
    expect(revoke.json().error).toBe('not-found');
    await app.close();
  });

  it('expiry: now() >= expiresAt => get 410 expired, revoke 410 expired', async () => {
    const { app, clock } = makeApp();
    const created = await createShare(app, { a: 1 }, 1);

    clock.advance(DAY_MS - 1); // one millisecond short of the TTL
    expect((await app.inject({ method: 'GET', url: `/api/v1/shares/${created.id}` })).statusCode).toBe(200);

    clock.advance(1); // exactly at expiresAt => expired
    const get = await app.inject({ method: 'GET', url: `/api/v1/shares/${created.id}` });
    expect(get.statusCode).toBe(410);
    expect(get.json().error).toBe('expired');

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/shares/${created.id}/revoke`,
      payload: { revokeToken: created.revokeToken },
    });
    expect(revoke.statusCode).toBe(410);
    expect(revoke.json().error).toBe('expired');
    await app.close();
  });

  it('revoked wins over expiry when both apply', async () => {
    const { app, clock } = makeApp();
    const created = await createShare(app, { a: 1 }, 1);
    await app.inject({
      method: 'POST',
      url: `/api/v1/shares/${created.id}/revoke`,
      payload: { revokeToken: created.revokeToken },
    });
    clock.advance(2 * DAY_MS);
    const get = await app.inject({ method: 'GET', url: `/api/v1/shares/${created.id}` });
    expect(get.statusCode).toBe(410);
    expect(get.json().error).toBe('revoked');
    await app.close();
  });

  it('ids and revoke tokens differ across creates', async () => {
    const { app } = makeApp();
    const a = await createShare(app, { a: 1 });
    const b = await createShare(app, { a: 2 });
    expect(a.id).not.toBe(b.id);
    expect(a.revokeToken).not.toBe(b.revokeToken);
    await app.close();
  });

  it('routes are absent when no share store is configured', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/shares', payload: { plan: {} } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
