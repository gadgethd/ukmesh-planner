/**
 * Ingester configuration — env-driven, validated, secret-free in logs.
 *
 * All knobs have conservative defaults; nothing here reads or prints the
 * database URLs. Bounds mirror the build brief's fail-closed rules: a
 * snapshot that looks truncated or exploded is REJECTED and the previous
 * published snapshot stays live.
 */
export interface IngestBounds {
  /** Hard sanity bounds — outside these the snapshot is rejected. */
  repeaterMin: number;
  repeaterMax: number;
  linkMin: number;
  linkMax: number;
  /**
   * Relative guard vs the previously published snapshot:
   * reject when new < prev * shrinkRatioMin or new > prev * growRatioMax.
   * (Ransomware/mass-change protection, mirroring the source's sync guards.)
   */
  shrinkRatioMin: number;
  growRatioMax: number;
}

export interface IngestConfig {
  sourceDbUrl: string;
  plannerDbUrl: string;
  intervalMs: number;
  jitterMs: number;
  statementTimeoutMs: number;
  /** Keep at most this many superseded snapshots (plus the published one). */
  pruneKeep: number;
  dryRun: boolean;
  once: boolean;
  bounds: IngestBounds;
}

function intEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`env ${name} must be a non-negative number`);
  return Math.floor(n);
}

function ratioEnv(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`env ${name} must be a positive number`);
  return n;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): IngestConfig {
  const once = argv.includes('--once');
  const dryRun = argv.includes('--dry-run') || process.env['INGEST_DRY_RUN'] === '1';
  const sourceDbUrl = process.env['SOURCE_DB_READONLY_URL'] ?? '';
  const plannerDbUrl = process.env['PLANNER_DB_URL'] ?? '';

  if (!dryRun) {
    if (!sourceDbUrl) throw new Error('SOURCE_DB_READONLY_URL is required');
    if (!plannerDbUrl) throw new Error('PLANNER_DB_URL is required');
  }

  return {
    sourceDbUrl,
    plannerDbUrl,
    intervalMs: intEnv('INGEST_INTERVAL_MS', 10 * 60_000),
    jitterMs: intEnv('INGEST_JITTER_MS', 60_000),
    statementTimeoutMs: intEnv('INGEST_STATEMENT_TIMEOUT_MS', 30_000),
    pruneKeep: intEnv('INGEST_PRUNE_KEEP', 5),
    dryRun,
    once,
    bounds: {
      repeaterMin: intEnv('INGEST_REPEATER_MIN', 100),
      repeaterMax: intEnv('INGEST_REPEATER_MAX', 50_000),
      linkMin: intEnv('INGEST_LINK_MIN', 100),
      linkMax: intEnv('INGEST_LINK_MAX', 2_000_000),
      shrinkRatioMin: ratioEnv('INGEST_SHRINK_RATIO_MIN', 0.7),
      growRatioMax: ratioEnv('INGEST_GROW_RATIO_MAX', 2.0),
    },
  };
}
