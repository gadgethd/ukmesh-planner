/**
 * Source-side (read-only) snapshot fetch.
 *
 * Contract with the `ukmesh_planner_reader` role (docs/integration/
 * source-contract.md):
 *   - one REPEATABLE READ, READ ONLY transaction per fetch so fence + data
 *     are consistent;
 *   - `SET LOCAL enable_nestloop = off` (role default too — belt and braces;
 *     nested-loop plans over the canonical view are ~1000x slower);
 *   - bounded statement timeout;
 *   - at most ONE connection (role connection limit is 2).
 */
import { Client } from 'pg';
import type { IngestConfig } from './config.js';

export interface SourceRepeaterRow {
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

export interface SourceLinkRow {
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

export interface FenceRow {
  generation: number;
  updated_at: Date;
  queried_at: Date;
}

export interface FetchResult {
  fence: FenceRow;
  repeaters: SourceRepeaterRow[];
  links: SourceLinkRow[];
  timingsMs: { fenceBefore: number; repeaters: number; links: number; total: number };
}

export function makeSourceClient(cfg: IngestConfig): Client {
  // One connection only (a Client, not a Pool); the role's own settings
  // (read-only txn, statement timeout, connlimit 2, enable_nestloop=off)
  // back up everything this module sets explicitly.
  return new Client({
    connectionString: cfg.sourceDbUrl,
    application_name: 'ukmesh-planner-ingest',
  });
}

const REPEATERS_SQL = `
  SELECT canonical_id,
         name,
         lat,
         lon,
         last_seen,
         is_online,
         hardware_model,
         firmware_version,
         iata,
         advert_count,
         identity_member_count
    FROM planner_export.public_repeaters_v1
   ORDER BY canonical_id`;

const LINKS_SQL = `
  SELECT source_id,
         target_id,
         observed_count,
         strong_observation_count,
         count_a_to_b,
         count_b_to_a,
         last_observed,
         path_loss_db,
         itm_viable,
         force_viable
    FROM planner_export.public_observed_links_v1
   ORDER BY source_id, target_id`;

const FENCE_SQL = `
  SELECT generation, updated_at, queried_at
    FROM planner_export.visibility_fence_v1`;

function mapFence(row: { generation: string | number; updated_at: Date; queried_at: Date }): FenceRow {
  // pg returns int8 (bigint) as a string; generations are small.
  return {
    generation: Number(row.generation),
    updated_at: row.updated_at,
    queried_at: row.queried_at,
  };
}

/** Read the privacy fence alone (used for the pre-publish re-check). */
export async function readFence(src: Client, cfg: IngestConfig): Promise<FenceRow> {
  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await src.query(`SET LOCAL statement_timeout = ${cfg.statementTimeoutMs}`);
    const res = await src.query(FENCE_SQL);
    await src.query('COMMIT');
    if (res.rows.length !== 1) throw new Error(`fence view returned ${res.rows.length} rows`);
    return mapFence(res.rows[0] as never);
  } catch (err) {
    await src.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Fetch fence + repeaters + links in one consistent read-only transaction. */
export async function fetchSnapshot(src: Client, cfg: IngestConfig): Promise<FetchResult> {
  const t0 = Date.now();
  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await src.query(`SET LOCAL statement_timeout = ${cfg.statementTimeoutMs}`);
    await src.query('SET LOCAL enable_nestloop = off');

    const tFence = Date.now();
    const fenceRes = await src.query(FENCE_SQL);
    const tRepeaters = Date.now();
    const repeatersRes = await src.query(REPEATERS_SQL);
    const tLinks = Date.now();
    const linksRes = await src.query(LINKS_SQL);
    const tEnd = Date.now();

    await src.query('COMMIT');

    if (fenceRes.rows.length !== 1) throw new Error(`fence view returned ${fenceRes.rows.length} rows`);

    return {
      fence: mapFence(fenceRes.rows[0] as never),
      repeaters: repeatersRes.rows as SourceRepeaterRow[],
      links: linksRes.rows as SourceLinkRow[],
      timingsMs: {
        fenceBefore: tRepeaters - tFence,
        repeaters: tLinks - tRepeaters,
        links: tEnd - tLinks,
        total: tEnd - t0,
      },
    };
  } catch (err) {
    await src.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
