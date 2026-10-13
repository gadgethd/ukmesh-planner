/**
 * One ingestion run: fetch -> validate -> fence re-check -> atomic publish.
 *
 * All collaborators are injectable (unit tests run the whole orchestration
 * against in-memory fakes; production uses the real Postgres clients).
 *
 * Fail-closed guarantees:
 *   - validation failure => nothing is published; previous snapshot stays;
 *   - fence changed after fetch => re-fetch once; still changed => skip the
 *     cycle entirely (previous snapshot stays; next cycle tries again);
 *   - any error => previous published snapshot remains authoritative.
 */
import type { Client } from 'pg';
import type { IngestConfig } from './config.js';
import { log } from './logger.js';
import {
  fetchSnapshot as realFetchSnapshot,
  makeSourceClient as realMakeSourceClient,
  readFence as realReadFence,
  type FetchResult,
  type FenceRow,
} from './source.js';
import { getPrevPublished as realGetPrevPublished, makePlannerClient as realMakePlannerClient, pruneSnapshots as realPruneSnapshots, publishSnapshot as realPublishSnapshot } from './planner.js';
import { validateSnapshot as realValidateSnapshot, type PrevCounts, type ValidationResult } from './validate.js';
import type { SourceLinkRow, SourceRepeaterRow } from './source.js';

export interface IngestDeps {
  makeSourceClient(cfg: IngestConfig): Client;
  makePlannerClient(cfg: IngestConfig): Client;
  fetchSnapshot(src: Client, cfg: IngestConfig): Promise<FetchResult>;
  readFence(src: Client, cfg: IngestConfig): Promise<FenceRow>;
  getPrevPublished(client: Client): Promise<PrevCounts | null>;
  publishSnapshot(client: Client, cfg: IngestConfig, snap: PublicationInput): Promise<void>;
  pruneSnapshots(client: Client, cfg: IngestConfig): Promise<void>;
  validate(repeaters: SourceRepeaterRow[], links: SourceLinkRow[], cfg: IngestConfig, prev: PrevCounts | null): ValidationResult;
}

export interface PublicationInput {
  id: string;
  generation: number;
  fenceCheckedAt: Date;
  repeaters: SourceRepeaterRow[];
  links: SourceLinkRow[];
  notes: string;
}

export interface RunResult {
  status: 'published' | 'skipped' | 'failed';
  snapshotId?: string;
  generation?: number;
  repeaters?: number;
  links?: number;
  error?: string;
  timingsMs?: Record<string, number>;
}

export const defaultDeps: IngestDeps = {
  makeSourceClient: realMakeSourceClient,
  makePlannerClient: realMakePlannerClient,
  fetchSnapshot: realFetchSnapshot,
  readFence: realReadFence,
  getPrevPublished: realGetPrevPublished,
  publishSnapshot: (client, _cfg, snap) => realPublishSnapshot(client, snap),
  pruneSnapshots: realPruneSnapshots,
  validate: (repeaters, links, cfg, prev) => realValidateSnapshot({ repeaters, links }, cfg.bounds, prev),
};

export function makeSnapshotId(generation: number, d = new Date()): string {
  const iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const rand = Math.random().toString(16).slice(2, 6);
  return `snap-${iso}-g${generation}-${rand}`;
}

function attachErrorLogging(client: Client, label: string): void {
  // pg emits 'error' on the client when a connection dies unexpectedly; without
  // a listener that event is an uncaught exception that kills the process
  // before fail-closed handling can run.
  const emitter = client as unknown as {
    on?: (event: string, cb: (err: unknown) => void) => unknown;
  };
  emitter.on?.('error', (err) => {
    log('error', `${label}-client error`, {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function runOnce(cfg: IngestConfig, deps: IngestDeps = defaultDeps): Promise<RunResult> {
  const t0 = Date.now();
  const src = deps.makeSourceClient(cfg);
  const planner = deps.makePlannerClient(cfg);
  attachErrorLogging(src, 'source');
  attachErrorLogging(planner, 'planner');
  try {
    await src.connect();
    await planner.connect();

    const fetched = await deps.fetchSnapshot(src, cfg);
    log('info', 'snapshot fetched', {
      generation: fetched.fence.generation,
      repeaters: fetched.repeaters.length,
      links: fetched.links.length,
      timingsMs: fetched.timingsMs,
    });

    const prev = await deps.getPrevPublished(planner);
    const validated = deps.validate(fetched.repeaters, fetched.links, cfg, prev);
    for (const w of validated.warnings) log('warn', 'validation warning', { warning: w });
    if (!validated.ok) {
      const error = validated.errors.join('; ');
      log('error', 'snapshot rejected — previous published snapshot retained', { errors: validated.errors });
      return { status: 'failed', error, generation: fetched.fence.generation };
    }

    // Fence re-check: privacy generation must not have moved since the fetch.
    const fenceAfter = await deps.readFence(src, cfg);
    if (fenceAfter.generation !== fetched.fence.generation) {
      log('warn', 'fence changed mid-run — re-fetching once', {
        before: fetched.fence.generation,
        after: fenceAfter.generation,
      });
      const refetched = await deps.fetchSnapshot(src, cfg);
      const fenceAfter2 = await deps.readFence(src, cfg);
      if (fenceAfter2.generation !== refetched.fence.generation) {
        return {
          status: 'skipped',
          generation: fenceAfter2.generation,
          error: 'fence changed twice during the run; deferring to next cycle',
        };
      }
      const validated2 = deps.validate(refetched.repeaters, refetched.links, cfg, prev);
      if (!validated2.ok) {
        const error = validated2.errors.join('; ');
        log('error', 're-fetched snapshot rejected', { errors: validated2.errors });
        return { status: 'failed', error, generation: refetched.fence.generation };
      }
      // `return await` is REQUIRED: the finally below ends both clients, and a
      // bare `return promise` would run the finally while this publish is still
      // in flight — ending the connection mid-transaction (pg rejects the query
      // with "Connection terminated"; server logs an EOF abort). Real bug, found
      // by the e2e; do not simplify these awaits away.
      return await publish(planner, cfg, deps, refetched.fence, validated2, refetched.links, t0);
    }

    // See note above: `return await` keeps the finally from ending clients
    // while this publish is still running.
    return await publish(planner, cfg, deps, fetched.fence, validated, fetched.links, t0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'ingest run failed', { error: message });
    return { status: 'failed', error: message };
  } finally {
    await src.end().catch(() => undefined);
    await planner.end().catch(() => undefined);
  }
}

async function publish(
  planner: Client,
  cfg: IngestConfig,
  deps: IngestDeps,
  fence: FenceRow,
  validated: ValidationResult,
  links: SourceLinkRow[],
  t0: number,
): Promise<RunResult> {
  const id = makeSnapshotId(fence.generation);
  if (cfg.dryRun) {
    log('info', 'dry-run: snapshot validated, publish skipped', {
      wouldPublish: id,
      repeaters: validated.sanitizedRepeaters.length,
    });
    return {
      status: 'skipped',
      snapshotId: id,
      generation: fence.generation,
      repeaters: validated.sanitizedRepeaters.length,
      error: 'dry-run',
    };
  }
  await deps.publishSnapshot(planner, cfg, {
    id,
    generation: fence.generation,
    fenceCheckedAt: fence.queried_at,
    repeaters: validated.sanitizedRepeaters,
    links,
    notes: `gen=${fence.generation}`,
  });
  await deps.pruneSnapshots(planner, cfg);
  log('info', 'snapshot published', {
    id,
    generation: fence.generation,
    repeaters: validated.sanitizedRepeaters.length,
    elapsedMs: Date.now() - t0,
  });
  return {
    status: 'published',
    snapshotId: id,
    generation: fence.generation,
    repeaters: validated.sanitizedRepeaters.length,
    timingsMs: { total: Date.now() - t0 },
  };
}
