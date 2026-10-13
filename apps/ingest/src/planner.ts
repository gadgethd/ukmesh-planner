/**
 * Planner-datastore side: snapshot build, atomic publish, prune.
 *
 * Publish model (mirrors db/planner-migrations/0001_core.sql):
 *   1. INSERT the snapshot row as 'building' + all repeaters + links in ONE
 *      transaction — readers never see partial data (a failed publish rolls
 *      back everything, leaving the previous published snapshot untouched);
 *   2. demote the previous 'published' row to 'superseded';
 *   3. promote the new row to 'published' — a partial unique index guarantees
 *      at most one published snapshot at any instant.
 */
import { Client } from 'pg';
import type { IngestConfig } from './config.js';
import type { SourceLinkRow, SourceRepeaterRow } from './source.js';
import type { PrevCounts } from './validate.js';

export function makePlannerClient(cfg: IngestConfig): Client {
  return new Client({
    connectionString: cfg.plannerDbUrl,
    application_name: 'ukmesh-planner-ingest',
  });
}

export interface SnapshotInput {
  id: string;
  generation: number;
  fenceCheckedAt: Date;
  repeaters: SourceRepeaterRow[];
  links: SourceLinkRow[];
  notes: string;
}

export async function getPrevPublished(client: Client): Promise<PrevCounts | null> {
  const res = await client.query(
    `SELECT id, repeater_count, link_count FROM source_snapshots WHERE status = 'published' LIMIT 1`,
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0] as { id: string; repeater_count: number; link_count: number };
  return { snapshotId: row.id, repeaters: row.repeater_count, links: row.link_count };
}

const REPEATER_COLS =
  'snapshot_id, canonical_id, name, lat, lon, last_seen, is_online, hardware_model, firmware_version, iata, advert_count, identity_member_count';

async function insertRepeaters(client: Client, snapshotId: string, rows: SourceRepeaterRow[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((r, j) => {
      const b = j * 12;
      values.push(
        snapshotId, r.canonical_id, r.name, r.lat, r.lon, r.last_seen, r.is_online,
        r.hardware_model, r.firmware_version, r.iata, r.advert_count, r.identity_member_count,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`;
    });
    await client.query(
      `INSERT INTO source_repeaters (${REPEATER_COLS}) VALUES ${tuples.join(',')}`,
      values,
    );
  }
}

const LINK_COLS =
  'snapshot_id, source_id, target_id, observed_count, strong_observation_count, count_a_to_b, count_b_to_a, last_observed, path_loss_db, itm_viable, force_viable';

async function insertLinks(client: Client, snapshotId: string, rows: SourceLinkRow[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((l, j) => {
      const b = j * 11;
      values.push(
        snapshotId, l.source_id, l.target_id, l.observed_count, l.strong_observation_count,
        l.count_a_to_b, l.count_b_to_a, l.last_observed, l.path_loss_db, l.itm_viable, l.force_viable,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
    });
    await client.query(`INSERT INTO source_observed_links (${LINK_COLS}) VALUES ${tuples.join(',')}`, values);
  }
}

export async function publishSnapshot(client: Client, snap: SnapshotInput): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO source_snapshots
         (id, source_generation, fence_checked_at, status, repeater_count, link_count, notes)
       VALUES ($1, $2, $3, 'building', $4, $5, $6)`,
      [snap.id, snap.generation, snap.fenceCheckedAt, snap.repeaters.length, snap.links.length, snap.notes],
    );
    await insertRepeaters(client, snap.id, snap.repeaters);
    await insertLinks(client, snap.id, snap.links);
    await client.query(
      `UPDATE source_snapshots SET status = 'superseded' WHERE status = 'published' AND id <> $1`,
      [snap.id],
    );
    await client.query(
      `UPDATE source_snapshots SET status = 'published', finished_at = now() WHERE id = $1`,
      [snap.id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Keep the newest `keep` superseded snapshots; drop stale incomplete rows. */
export async function pruneSnapshots(client: Client, cfg: IngestConfig): Promise<void> {
  await client.query(
    `DELETE FROM source_snapshots
      WHERE status = 'superseded'
        AND id NOT IN (
          SELECT id FROM source_snapshots
           WHERE status = 'superseded'
           ORDER BY finished_at DESC NULLS LAST
           LIMIT $1
        )`,
    [cfg.pruneKeep],
  );
  await client.query(
    `DELETE FROM source_snapshots
      WHERE status IN ('building', 'failed')
        AND started_at < now() - interval '24 hours'`,
  );
}
