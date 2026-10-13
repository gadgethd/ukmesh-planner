/**
 * Share client (Stage 6) — thin wrapper over the planner share API.
 *
 * Nothing is uploaded unless the visitor clicks "Create share link"; the
 * revoke token is kept locally (IndexedDB) and is the only way to revoke.
 */
import type { SerializedPlan } from './store.js';

export interface ShareCreated {
  id: string;
  expiresAt: string;
  revokeToken: string;
}

export type FetchShareResult =
  | { status: 'ok'; plan: unknown; expiresAt: string }
  | { status: 'not-found' }
  | { status: 'expired' }
  | { status: 'revoked' }
  | { status: 'error'; message: string };

export async function createShare(plan: SerializedPlan, ttlDays?: number): Promise<ShareCreated> {
  const res = await fetch('/api/v1/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ttlDays ? { plan, ttlDays } : { plan }),
  });
  if (!res.ok) throw new Error(`share-create-failed:${res.status}`);
  return (await res.json()) as ShareCreated;
}

export async function revokeShare(id: string, revokeToken: string): Promise<boolean> {
  const res = await fetch(`/api/v1/shares/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revokeToken }),
  });
  if (res.ok) return true;
  if (res.status === 410) return true; // already gone — nothing left to revoke
  return false;
}

export async function fetchShare(id: string): Promise<FetchShareResult> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/shares/${encodeURIComponent(id)}`);
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'network-error' };
  }
  if (res.status === 404) return { status: 'not-found' };
  if (res.status === 410) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error === 'revoked' ? { status: 'revoked' } : { status: 'expired' };
  }
  if (!res.ok) return { status: 'error', message: `share-fetch-failed:${res.status}` };
  const body = (await res.json()) as { plan: unknown; expiresAt: string };
  return { status: 'ok', plan: body.plan, expiresAt: body.expiresAt };
}

/** Parse `#share=<uuid>` from a location hash; null when absent/malformed. */
export function shareIdFromHash(hash: string): string | null {
  const m = /^#share=([0-9a-fA-F-]{36})$/.exec(hash);
  return m ? m[1]! : null;
}
