/**
 * Reads the currently published snapshot metadata from the planner datastore.
 * The API never touches the source DB (build brief §8.2 — the API is not an
 * SQL proxy; it serves planner-owned data only).
 */
import { Client } from 'pg';
import type { SnapshotMeta } from '@ukmesh-planner/contracts';

export interface SnapshotReader {
  getSnapshotMeta(): Promise<SnapshotMeta | null>;
  close(): Promise<void>;
}

export function makeSnapshotReader(dbUrl: string): SnapshotReader {
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  async function getClient(): Promise<Client> {
    if (client) return client;
    if (!connecting) {
      const c = new Client({ connectionString: dbUrl, application_name: 'ukmesh-planner-api' });
      // A dead connection must be a handled error: drop it and reconnect lazily.
      c.on('error', (err) => {
        console.error('[api] planner-db client error:', err.message);
        client = null;
      });
      connecting = c
        .connect()
        .then(() => {
          client = c;
          connecting = null;
          return c;
        })
        .catch((err: unknown) => {
          connecting = null;
          throw err;
        });
    }
    return connecting;
  }

  return {
    async getSnapshotMeta(): Promise<SnapshotMeta | null> {
      const c = await getClient();
      const res = await c.query(
        `SELECT id, source_generation, fence_checked_at, repeater_count, link_count
           FROM source_snapshots
          WHERE status = 'published'
          LIMIT 1`,
      );
      if (res.rows.length === 0) return null;
      const r = res.rows[0] as {
        id: string;
        source_generation: string | number;
        fence_checked_at: Date;
        repeater_count: number;
        link_count: number;
      };
      return {
        id: r.id,
        generation: Number(r.source_generation),
        fetchedAt: r.fence_checked_at.toISOString(),
        repeaters: r.repeater_count,
        links: r.link_count,
      };
    },
    async close(): Promise<void> {
      if (client) await client.end().catch(() => undefined);
      client = null;
    },
  };
}
