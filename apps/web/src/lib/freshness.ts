/** Freshness buckets for existing repeaters (documented in the legend). */
export type FreshnessBucket = 'fresh' | 'recent' | 'stale' | 'long';

export function freshnessBucket(lastSeenIso: string | null, now = Date.now()): FreshnessBucket {
  if (!lastSeenIso) return 'long';
  const t = Date.parse(lastSeenIso);
  if (!Number.isFinite(t)) return 'long';
  const ageH = (now - t) / 3_600_000;
  if (ageH < 24) return 'fresh';
  if (ageH < 24 * 7) return 'recent';
  if (ageH < 24 * 28) return 'stale';
  return 'long';
}

export const FRESHNESS_LABEL: Record<FreshnessBucket, string> = {
  fresh: 'seen < 24 h',
  recent: 'seen < 7 d',
  stale: 'seen < 28 d',
  long: 'long-unseen (> 28 d)',
};
