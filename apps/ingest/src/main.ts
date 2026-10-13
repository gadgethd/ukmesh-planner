/**
 * Ingester entrypoint.
 *
 *   --once       run a single snapshot cycle and exit (non-zero on failure)
 *   --dry-run    full fetch + validation, no publish
 *   (default)    loop: interval + jitter, exponential backoff on failures
 *
 * The loop mode is what the compose service runs. SIGTERM/SIGINT stop the
 * loop cleanly between cycles.
 */
import { loadConfig } from './config.js';
import { log, redactUrl } from './logger.js';
import { runOnce } from './run.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const cfg = loadConfig();

log('info', 'ukmesh-planner-ingest starting', {
  mode: cfg.once ? 'once' : 'loop',
  dryRun: cfg.dryRun,
  intervalMs: cfg.intervalMs,
  jitterMs: cfg.jitterMs,
  pruneKeep: cfg.pruneKeep,
  sourceDb: cfg.sourceDbUrl ? redactUrl(cfg.sourceDbUrl) : null,
  plannerDb: cfg.plannerDbUrl ? redactUrl(cfg.plannerDbUrl) : null,
});

if (cfg.once) {
  try {
    const result = await runOnce(cfg);
    log(result.status === 'failed' ? 'error' : 'info', 'ingest run finished', { ...result });
    process.exit(result.status === 'failed' ? 1 : 0);
  } catch (err) {
    // Belt-and-braces: runOnce is fail-closed internally, but a rejection must
    // never escape as an uncaught top-level crash.
    log('error', 'ingest run crashed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
  log('info', 'SIGTERM received — stopping after current cycle');
});
process.on('SIGINT', () => {
  stopping = true;
  log('info', 'SIGINT received — stopping after current cycle');
});

let consecutiveFailures = 0;
while (!stopping) {
  const result = await runOnce(cfg);
  const ok = result.status === 'published' || result.status === 'skipped';
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1;

  const backoff = ok
    ? cfg.intervalMs
    : Math.min(cfg.intervalMs * 2 ** consecutiveFailures, 60 * 60_000);
  const wait = backoff + Math.floor(Math.random() * cfg.jitterMs);
  log('info', 'cycle complete', { status: result.status, consecutiveFailures, nextInMs: wait });
  await sleep(wait);
}
log('info', 'ingest loop stopped');
process.exit(0);
