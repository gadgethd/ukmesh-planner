import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { makePlannerStore } from './snapshot.js';
import type { ShareStore } from './shares.js';
import { calibrateFromObservedLinks } from '@ukmesh-planner/rf-core';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const dbUrl = process.env['PLANNER_DB_URL'] ?? '';
const rateLimit = {
  windowMs: Number(process.env['RATE_LIMIT_WINDOW_MS'] ?? 60_000),
  max: Number(process.env['RATE_LIMIT_MAX'] ?? 240),
};

const store = dbUrl ? makePlannerStore(dbUrl) : null;

/**
 * Postgres-backed share store (stage 6).
 *
 * Shares get their own pooled handle on the same planner database — the
 * snapshot reader keeps a private single connection. Expiry is evaluated by
 * Postgres itself (`now()`), so a skewed app clock cannot extend a share's
 * TTL, and the revoke attempt is settled atomically inside the UPDATE.
 */
class PgShareStore implements ShareStore {
  constructor(private readonly pool: Pool) {}

  async create(
    plan: Record<string, unknown>,
    ttlDays: number,
  ): Promise<{ id: string; expiresAt: Date; revokeToken: string }> {
    const id = randomUUID();
    const revokeToken = randomUUID();
    const res = await this.pool.query(
      `insert into shares (id, plan, revoke_token, expires_at)
       values ($1, $2::jsonb, $3, now() + make_interval(days => $4::int))
       returning expires_at`,
      [id, JSON.stringify(plan), revokeToken, ttlDays],
    );
    const row = res.rows[0] as { expires_at: Date } | undefined;
    if (!row) throw new Error('share insert returned no row');
    return { id, expiresAt: row.expires_at, revokeToken };
  }

  async get(id: string): Promise<
    | { status: 'ok'; plan: Record<string, unknown>; expiresAt: Date }
    | { status: 'not-found' }
    | { status: 'expired' }
    | { status: 'revoked' }
  > {
    const res = await this.pool.query(
      `select plan, expires_at, revoked_at, (expires_at <= now()) as expired
         from shares
        where id = $1`,
      [id],
    );
    const row = res.rows[0] as
      | { plan: Record<string, unknown>; expires_at: Date; revoked_at: Date | null; expired: boolean }
      | undefined;
    if (!row) return { status: 'not-found' };
    // Revocation is permanent, so it outranks expiry when both apply.
    if (row.revoked_at) return { status: 'revoked' };
    if (row.expired) return { status: 'expired' };
    return { status: 'ok', plan: row.plan, expiresAt: row.expires_at };
  }

  async revoke(
    id: string,
    revokeToken: string,
  ): Promise<'revoked' | 'not-found' | 'expired' | 'revoked-already' | 'bad-token'> {
    const upd = await this.pool.query(
      `update shares
          set revoked_at = now()
        where id = $1 and revoke_token = $2
          and revoked_at is null and expires_at > now()
      returning id`,
      [id, revokeToken],
    );
    if (upd.rowCount === 1) return 'revoked';
    // The atomic UPDATE settles the success path; this read only classifies
    // why nothing matched (missing / revoked / expired / wrong token).
    const res = await this.pool.query(
      `select revoked_at, (expires_at <= now()) as expired from shares where id = $1`,
      [id],
    );
    const row = res.rows[0] as { revoked_at: Date | null; expired: boolean } | undefined;
    if (!row) return 'not-found';
    if (row.revoked_at) return 'revoked-already';
    if (row.expired) return 'expired';
    return 'bad-token';
  }
}

const sharePool = dbUrl
  ? new Pool({ connectionString: dbUrl, application_name: 'ukmesh-planner-api' })
  : null;
// An idle-pool client error must not take the process down.
sharePool?.on('error', (err: Error) => {
  // eslint-disable-next-line no-console
  console.error('[ukmesh-planner-api] share pool error:', err.message);
});
const shareStore = sharePool ? new PgShareStore(sharePool) : null;

// Calibration is derived from the snapshot's observed links and cached per
// snapshot id — the data changes only when a new snapshot publishes.
let calibrationCache: {
  snapshotId: string;
  value: { usablePathLossDb: number; green: number; amber: number; samples: number; snapshotId: string };
} | null = null;

async function getCalibration(): Promise<{
  usablePathLossDb: number;
  green: number;
  amber: number;
  samples: number;
  snapshotId: string;
}> {
  if (!store) throw new Error('planner store not configured');
  const meta = await store.getSnapshotMeta();
  if (!meta) throw new Error('no published snapshot');
  if (calibrationCache && calibrationCache.snapshotId === meta.id) return calibrationCache.value;
  const rows = await store.getObservedLosses(meta.id);
  const cal = calibrateFromObservedLinks(rows);
  const value = { ...cal, snapshotId: meta.id };
  calibrationCache = { snapshotId: meta.id, value };
  console.log(
    `[ukmesh-planner-api] calibration: samples=${cal.samples} usable=${cal.usablePathLossDb} ` +
      `green=${cal.green} amber=${cal.amber}`,
  );
  return value;
}

const app = buildApp(
  store && shareStore
    ? {
        getSnapshotMeta: () => store.getSnapshotMeta(),
        getRepeaters: store.getRepeaters.bind(store),
        getObservedLinks: store.getObservedLinks.bind(store),
        getCalibration,
        shareStore,
        rateLimit,
      }
    : { rateLimit },
);

app
  .listen({ port, host })
  .then((address) => {
    // eslint-disable-next-line no-console
    console.log(`[ukmesh-planner-api] listening on ${address}`);
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[ukmesh-planner-api] failed to start', err);
    process.exit(1);
  });

async function shutdown(): Promise<void> {
  await store?.close();
  if (sharePool) await sharePool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
