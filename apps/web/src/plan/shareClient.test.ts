import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import { createShare, fetchShare, revokeShare, shareIdFromHash } from './shareClient.js';
import type { SerializedPlan } from './store.js';

const plan: SerializedPlan = { version: 1, mode: 'simple', site: null, rf: DEFAULT_UK_RF_SETTINGS };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(impl(String(input), init));
  });
}

describe('share client', () => {
  it('creates a share and returns id/token/expiry', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('/api/v1/shares');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as { plan: SerializedPlan };
      expect(body.plan).toEqual(plan);
      return new Response(
        JSON.stringify({ id: 'i-1', expiresAt: '2026-11-01T00:00:00Z', revokeToken: 't-1' }),
        { status: 201 },
      );
    });
    const res = await createShare(plan);
    expect(res).toEqual({ id: 'i-1', expiresAt: '2026-11-01T00:00:00Z', revokeToken: 't-1' });
  });

  it('throws on a failed create', async () => {
    stubFetch(() => new Response('{}', { status: 500 }));
    await expect(createShare(plan)).rejects.toThrow('share-create-failed:500');
  });

  it('revoke maps 200/410 to success, others to failure', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    expect(await revokeShare('i-1', 't-1')).toBe(true);
    stubFetch(() => new Response('{}', { status: 410 }));
    expect(await revokeShare('i-1', 't-1')).toBe(true);
    stubFetch(() => new Response('{}', { status: 403 }));
    expect(await revokeShare('i-1', 't-1')).toBe(false);
  });

  it('fetchShare maps statuses', async () => {
    stubFetch(() => new Response(JSON.stringify({ plan, expiresAt: 'x' }), { status: 200 }));
    expect(await fetchShare('i-1')).toEqual({ status: 'ok', plan, expiresAt: 'x' });

    stubFetch(() => new Response('{}', { status: 404 }));
    expect(await fetchShare('i-1')).toEqual({ status: 'not-found' });

    stubFetch(() => new Response(JSON.stringify({ error: 'revoked' }), { status: 410 }));
    expect(await fetchShare('i-1')).toEqual({ status: 'revoked' });

    stubFetch(() => new Response(JSON.stringify({ error: 'expired' }), { status: 410 }));
    expect(await fetchShare('i-1')).toEqual({ status: 'expired' });
  });

  it('parses only well-formed share hashes', () => {
    expect(shareIdFromHash('#share=518b3a60-c782-423c-b496-aa512cea27ff')).toBe(
      '518b3a60-c782-423c-b496-aa512cea27ff',
    );
    expect(shareIdFromHash('')).toBeNull();
    expect(shareIdFromHash('#share=not-a-uuid')).toBeNull();
    expect(shareIdFromHash('#other=518b3a60-c782-423c-b496-aa512cea27ff')).toBeNull();
  });
});
