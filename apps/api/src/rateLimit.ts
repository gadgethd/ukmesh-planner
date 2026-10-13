/**
 * Tiny in-process sliding-window rate limiter.
 *
 * Deliberately dependency-free for staging; a distributed/edge limiter is
 * revisited in the production hardening pass (build brief §8.2 / Stage 7).
 */
export interface RateLimiter {
  allow(key: string): boolean;
}

export function makeRateLimiter(opts: { windowMs: number; max: number }): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < opts.windowMs) return;
    lastSweep = now;
    for (const [key, times] of hits) {
      const kept = times.filter((t) => now - t < opts.windowMs);
      if (kept.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, kept);
      }
    }
  }

  return {
    allow(key: string): boolean {
      const now = Date.now();
      sweep(now);
      const times = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
      if (times.length >= opts.max) {
        hits.set(key, times);
        return false;
      }
      times.push(now);
      hits.set(key, times);
      return true;
    },
  };
}
