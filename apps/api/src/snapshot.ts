/**
 * Planner datastore access — published snapshot metadata + bounded derived
 * reads (repeaters, observed links).
 *
 * The API serves ONLY from the planner's own datastore; it never touches the
 * source DB (build brief §8.2). All reads are bounded: bbox + limit +
 * keyset cursor, on the single published snapshot.
 */
import { Client } from 'pg';
import type {
  PlannerObservedLink,
  PlannerRepeater,
  SnapshotMeta,
} from '@ukmesh-planner/contracts';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface RepeaterQuery {
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  limit: number;
  cursor: string | null;
}

export interface LinkQuery {
  bbox: [number, number, number, number];
  limit: number;
  cursor: { sourceId: string; targetId: string } | null;
}

export interface PlannerStore {
  getSnapshotMeta(): Promise<SnapshotMeta | null>;
  getRepeaters(snapshotId: string, query: RepeaterQuery): Promise<Page<PlannerRepeater>>;
  getObservedLinks(snapshotId: string, query: LinkQuery): Promise<Page<PlannerObservedLink>>;
  close(): Promise<void>;
}

export function makePlannerStore(dbUrl: string): PlannerStore {
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

  const REPEATERS_PAGE_SQL = `
    SELECT canonical_id, name, lat, lon, last_seen, is_online,
           hardware_model, firmware_version, iata, advert_count, identity_member_count
      FROM source_repeaters
     WHERE snapshot_id = $1
       AND lat BETWEEN $2 AND $3
       AND lon BETWEEN $4 AND $5
       AND ($6 = '' OR canonical_id > $6)
     ORDER BY canonical_id
     LIMIT $7`;

  const LINKS_PAGE_SQL = `
    SELECT l.source_id, l.target_id, l.observed_count, l.strong_observation_count,
           l.count_a_to_b, l.count_b_to_a, l.last_observed, l.path_loss_db,
           l.itm_viable, l.force_viable
      FROM source_observed_links l
     WHERE l.snapshot_id = $1
       AND (l.source_id > $2 OR (l.source_id = $2 AND l.target_id > $3))
       AND EXISTS (
         SELECT 1 FROM source_repeaters r
          WHERE r.snapshot_id = l.snapshot_id
            AND r.canonical_id IN (l.source_id, l.target_id)
            AND r.lat BETWEEN $4 AND $5
            AND r.lon BETWEEN $6 AND $7
       )
     ORDER BY l.source_id, l.target_id
     LIMIT $8`;

  interface RepeaterDbRow {
    canonical_id: string;
    name: string | null;
    lat: number;
    lon: number;
    last_seen: Date | null;
    is_online: boolean;
    hardware_model: string | null;
    firmware_version: string | null;
    iata: string | null;
    advert_count: number;
    identity_member_count: number;
  }

  interface LinkDbRow {
    source_id: string;
    target_id: string;
    observed_count: number;
    strong_observation_count: number;
    count_a_to_b: number;
    count_b_to_a: number;
    last_observed: Date;
    path_loss_db: number | null;
    itm_viable: boolean | null;
    force_viable: boolean | null;
  }

  function mapRepeater(r: RepeaterDbRow): PlannerRepeater {
    return {
      canonicalId: r.canonical_id,
      name: r.name,
      lat: r.lat,
      lon: r.lon,
      lastSeen: r.last_seen ? r.last_seen.toISOString() : null,
      isOnline: r.is_online,
      hardwareModel: r.hardware_model,
      firmwareVersion: r.firmware_version,
      iata: r.iata,
      advertCount: r.advert_count,
      identityMemberCount: r.identity_member_count,
    };
  }

  function mapLink(l: LinkDbRow): PlannerObservedLink {
    return {
      sourceId: l.source_id,
      targetId: l.target_id,
      observedCount: l.observed_count,
      strongObservationCount: l.strong_observation_count,
      countAToB: l.count_a_to_b,
      countBToA: l.count_b_to_a,
      lastObserved: l.last_observed.toISOString(),
      pathLossDb: l.path_loss_db,
      itmViable: l.itm_viable,
      forceViable: l.force_viable,
      evidence: 'observed',
    };
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

    async getRepeaters(snapshotIdArg: string, query: RepeaterQuery): Promise<Page<PlannerRepeater>> {
      const c = await getClient();
      const [w, s, e, n] = query.bbox;
      const res = await c.query(REPEATERS_PAGE_SQL, [
        snapshotIdArg, s, n, w, e, query.cursor ?? '', query.limit + 1,
      ]);
      const rows = res.rows as RepeaterDbRow[];
      const more = rows.length > query.limit;
      const page = more ? rows.slice(0, query.limit) : rows;
      return {
        items: page.map(mapRepeater),
        nextCursor: more ? page[page.length - 1]!.canonical_id : null,
      };
    },

    async getObservedLinks(snapshotIdArg: string, query: LinkQuery): Promise<Page<PlannerObservedLink>> {
      const c = await getClient();
      const [w, s, e, n] = query.bbox;
      const curA = query.cursor?.sourceId ?? '';
      const curB = query.cursor?.targetId ?? '';
      const res = await c.query(LINKS_PAGE_SQL, [
        snapshotIdArg, curA, curB, s, n, w, e, query.limit + 1,
      ]);
      const rows = res.rows as LinkDbRow[];
      const more = rows.length > query.limit;
      const page = more ? rows.slice(0, query.limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(mapLink),
        nextCursor: more && last ? `${last.source_id}:${last.target_id}` : null,
      };
    },

    async close(): Promise<void> {
      if (client) await client.end().catch(() => undefined);
      client = null;
    },
  };
}

/** Back-compat alias (stage-2c name). */
export const makeSnapshotReader = makePlannerStore;
export type SnapshotReader = PlannerStore;
