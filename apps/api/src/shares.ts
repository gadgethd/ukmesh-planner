/**
 * Plan sharing (stage 6) — opt-in, private, server-backed shares.
 *
 * Visitor plans are never uploaded unless the user explicitly shares one;
 * a share is a blob under an unguessable UUID with a hard TTL and permanent
 * revocation. The storage contract is a tiny injectable interface so the
 * routes can be exercised against the in-memory store in tests and the
 * Postgres store in production (see server.ts).
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 30;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 90;
/** Cap on the serialized plan; keeps a share small enough to serve cheaply. */
const MAX_PLAN_BYTES = 64 * 1024;

export interface ShareRecord {
  id: string;
  plan: Record<string, unknown>;
  revokeToken: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type ShareLookup =
  | { status: 'ok'; plan: Record<string, unknown>; expiresAt: Date }
  | { status: 'not-found' }
  | { status: 'expired' }
  | { status: 'revoked' };

export type RevokeResult =
  | 'revoked'
  | 'not-found'
  | 'expired'
  | 'revoked-already'
  | 'bad-token';

export interface ShareStore {
  create(
    plan: Record<string, unknown>,
    ttlDays: number,
  ): Promise<{ id: string; expiresAt: Date; revokeToken: string }>;
  get(id: string): Promise<ShareLookup>;
  revoke(id: string, revokeToken: string): Promise<RevokeResult>;
}

export class MemoryShareStore implements ShareStore {
  private readonly records = new Map<string, ShareRecord>();

  /** `now` is injectable so TTL/expiry behaviour is testable with a fake clock. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(
    plan: Record<string, unknown>,
    ttlDays: number,
  ): Promise<{ id: string; expiresAt: Date; revokeToken: string }> {
    const id = randomUUID();
    const revokeToken = randomUUID();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ttlDays * DAY_MS);
    this.records.set(id, { id, plan, revokeToken, createdAt, expiresAt, revokedAt: null });
    return { id, expiresAt, revokeToken };
  }

  async get(id: string): Promise<ShareLookup> {
    const record = this.records.get(id);
    if (!record) return { status: 'not-found' };
    // Revocation is permanent, so it outranks expiry when both apply.
    if (record.revokedAt) return { status: 'revoked' };
    if (this.isExpired(record)) return { status: 'expired' };
    return { status: 'ok', plan: record.plan, expiresAt: record.expiresAt };
  }

  async revoke(id: string, revokeToken: string): Promise<RevokeResult> {
    const record = this.records.get(id);
    if (!record) return 'not-found';
    if (record.revokedAt) return 'revoked-already';
    if (this.isExpired(record)) return 'expired';
    if (record.revokeToken !== revokeToken) return 'bad-token';
    record.revokedAt = this.now();
    return 'revoked';
  }

  /** `now() >= expiresAt` is expired: a share is dead the instant its TTL lapses. */
  private isExpired(record: ShareRecord): boolean {
    return this.now().getTime() >= record.expiresAt.getTime();
  }
}

const createShareSchema = z.object({
  plan: z.unknown(),
  ttlDays: z.number().int().min(MIN_TTL_DAYS).max(MAX_TTL_DAYS).optional(),
});

const revokeShareSchema = z.object({ revokeToken: z.string().min(1) });

/** JSON bodies only ever carry plain objects here; arrays/null are rejected. */
function isPlanObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerShareRoutes(app: FastifyInstance, store: ShareStore): void {
  // Create a share. Rejects anything that is not a bounded plain-object plan:
  // a 400 for shape/ttl problems, a 413 for oversized plans.
  app.post('/api/v1/shares', async (req, reply) => {
    const parsed = createShareSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid-request' });
    const { plan } = parsed.data;
    if (!isPlanObject(plan)) return reply.code(400).send({ error: 'invalid-request' });
    if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > MAX_PLAN_BYTES) {
      return reply.code(413).send({ error: 'payload-too-large' });
    }
    const created = await store.create(plan, parsed.data.ttlDays ?? DEFAULT_TTL_DAYS);
    return reply.code(201).send(created);
  });

  // Fetch a share. Expired/revoked shares are gone (410), never rendered.
  app.get('/api/v1/shares/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await store.get(id);
    if (result.status === 'ok') {
      return reply.code(200).send({ plan: result.plan, expiresAt: result.expiresAt });
    }
    if (result.status === 'not-found') return reply.code(404).send({ error: 'not-found' });
    return reply.code(410).send({ error: result.status });
  });

  // Revoke a share with its revoke token; the token is the only secret.
  app.post('/api/v1/shares/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = revokeShareSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid-request' });
    const result = await store.revoke(id, parsed.data.revokeToken);
    switch (result) {
      case 'revoked':
        return reply.code(200).send({ revoked: true });
      case 'bad-token':
        return reply.code(403).send({ error: 'bad-token' });
      case 'not-found':
        return reply.code(404).send({ error: 'not-found' });
      case 'expired':
        return reply.code(410).send({ error: 'expired' });
      case 'revoked-already':
        return reply.code(410).send({ error: 'revoked' });
    }
  });
}
