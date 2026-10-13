/**
 * Planner API — small, rate-limited, same-origin service.
 *
 * Serves planner-owned data only (published snapshots + bounded derived
 * reads); it is not an SQL proxy to the source DB (build brief §8.2).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_BOUNDS,
  RF_MODEL_VERSION,
  SOURCE_CONTRACT_VERSION,
  type PlannerObservedLink,
  type PlannerRepeater,
  type SnapshotMeta,
} from '@ukmesh-planner/contracts';
import type { LinkQuery, Page, RepeaterQuery } from './snapshot.js';
import { makeRateLimiter } from './rateLimit.js';

export interface AppDeps {
  getSnapshotMeta?: () => Promise<SnapshotMeta | null>;
  getRepeaters?: (snapshotId: string, query: RepeaterQuery) => Promise<Page<PlannerRepeater>>;
  getObservedLinks?: (snapshotId: string, query: LinkQuery) => Promise<Page<PlannerObservedLink>>;
  rateLimit?: { windowMs: number; max: number };
}

const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 20_000;

const limitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT);
const cursorIdSchema = z.string().regex(/^[0-9A-F]{64}$/);
const linkCursorSchema = z.string().regex(/^[0-9A-F]{64}:[0-9A-F]{64}$/);

type Bbox = [number, number, number, number];

/**
 * Parse `bbox=w,s,e,n`. Absent => `{ ok: true, bbox: null }` (no spatial
 * filter — the full published snapshot; the dataset legitimately contains
 * repeaters outside the UK core bounds). Malformed => `{ ok: false }`.
 */
export function parseBbox(raw: unknown): { ok: true; bbox: Bbox | null } | { ok: false } {
  if (raw === undefined) return { ok: true, bbox: null };
  if (typeof raw !== 'string') return { ok: false };
  const parts = raw.split(',').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return { ok: false };
  const [w, s, e, n] = parts as Bbox;
  if (s < -90 || n > 90 || w < -180 || e > 180) return { ok: false };
  if (w >= e || s >= n) return { ok: false };
  return { ok: true, bbox: [w, s, e, n] };
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const limiter = makeRateLimiter(deps.rateLimit ?? { windowMs: 60_000, max: 240 });

  // Rate-limit all data routes (health probes exempt).
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/v1/') && !limiter.allow(req.ip)) {
      await reply.code(429).send({ error: 'rate-limited' });
    }
  });

  // Liveness — must not touch any database.
  app.get('/healthz', async () => ({ ok: true }));

  // Readiness — planner datastore / snapshot state.
  app.get('/readyz', async () => {
    if (!deps.getSnapshotMeta) {
      return { ready: true, sourceContract: SOURCE_CONTRACT_VERSION, snapshot: null };
    }
    try {
      const snapshot = await deps.getSnapshotMeta();
      return { ready: true, sourceContract: SOURCE_CONTRACT_VERSION, snapshot };
    } catch {
      return {
        ready: false,
        sourceContract: SOURCE_CONTRACT_VERSION,
        snapshot: null,
        error: 'planner-db-unreachable',
      };
    }
  });

  // Public configuration: bounds, versions, advertised compute backends.
  app.get('/api/v1/config', async () => {
    let snapshot: SnapshotMeta | null = null;
    try {
      snapshot = deps.getSnapshotMeta ? await deps.getSnapshotMeta() : null;
    } catch {
      snapshot = null;
    }
    return {
      bounds: DEFAULT_BOUNDS,
      modelVersion: RF_MODEL_VERSION,
      datasetVersion: snapshot?.id ?? null,
      computeBackends: ['wasm', 'webgpu'],
      snapshot,
    };
  });

  // Published snapshot metadata.
  app.get('/api/v1/snapshot/meta', async (_req, reply) => {
    if (!deps.getSnapshotMeta) return reply.code(503).send({ error: 'store-not-configured' });
    try {
      const snapshot = await deps.getSnapshotMeta();
      if (!snapshot) return reply.code(503).send({ error: 'no-snapshot' });
      return { snapshot };
    } catch {
      return reply.code(503).send({ error: 'planner-db-unreachable' });
    }
  });

  // Paginated repeaters (bbox + keyset cursor on canonical_id).
  app.get('/api/v1/repeaters', async (req, reply) => {
    if (!deps.getRepeaters || !deps.getSnapshotMeta) {
      return reply.code(503).send({ error: 'store-not-configured' });
    }
    const q = req.query as Record<string, unknown>;
    const parsed = parseBbox(q['bbox']);
    if (!parsed.ok) return reply.code(400).send({ error: 'invalid-bbox' });
    const lim = limitSchema.safeParse(q['limit'] ?? DEFAULT_LIMIT);
    if (!lim.success) return reply.code(400).send({ error: 'invalid-limit' });
    let cursor: string | null = null;
    if (q['cursor'] !== undefined) {
      const c = cursorIdSchema.safeParse(q['cursor']);
      if (!c.success) return reply.code(400).send({ error: 'invalid-cursor' });
      cursor = c.data;
    }
    try {
      const meta = await deps.getSnapshotMeta();
      if (!meta) return reply.code(503).send({ error: 'no-snapshot' });
      const page = await deps.getRepeaters(meta.id, { bbox: parsed.bbox, limit: lim.data, cursor });
      return { snapshotId: meta.id, items: page.items, nextCursor: page.nextCursor };
    } catch {
      return reply.code(503).send({ error: 'planner-db-unreachable' });
    }
  });

  // Paginated observed links (bbox touches either endpoint + keyset cursor).
  app.get('/api/v1/observed-links', async (req, reply) => {
    if (!deps.getObservedLinks || !deps.getSnapshotMeta) {
      return reply.code(503).send({ error: 'store-not-configured' });
    }
    const q = req.query as Record<string, unknown>;
    const parsed = parseBbox(q['bbox']);
    if (!parsed.ok) return reply.code(400).send({ error: 'invalid-bbox' });
    const lim = limitSchema.safeParse(q['limit'] ?? DEFAULT_LIMIT);
    if (!lim.success) return reply.code(400).send({ error: 'invalid-limit' });
    let cursor: { sourceId: string; targetId: string } | null = null;
    if (q['cursor'] !== undefined) {
      const c = linkCursorSchema.safeParse(q['cursor']);
      if (!c.success) return reply.code(400).send({ error: 'invalid-cursor' });
      const [sourceId, targetId] = c.data.split(':') as [string, string];
      cursor = { sourceId, targetId };
    }
    try {
      const meta = await deps.getSnapshotMeta();
      if (!meta) return reply.code(503).send({ error: 'no-snapshot' });
      const page = await deps.getObservedLinks(meta.id, { bbox: parsed.bbox, limit: lim.data, cursor });
      return { snapshotId: meta.id, items: page.items, nextCursor: page.nextCursor };
    } catch {
      return reply.code(503).send({ error: 'planner-db-unreachable' });
    }
  });

  return app;
}
