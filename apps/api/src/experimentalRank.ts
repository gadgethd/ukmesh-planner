/**
 * Experimental RF ranking proxy (stage: planner-validation1).
 *
 * Mounts only when an external ranking service URL is configured. The service is
 * intentionally out-of-process: the frozen model and its Python featuriser are
 * research artefacts, not part of this application's runtime contract. Nothing
 * here is enabled by default and nothing here is a production endpoint.
 *
 * The route returns relative link rankings. It must never return, and this proxy
 * never adds, any probability or guaranteed-connectivity claim.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export interface ExperimentalRankOptions {
  /** Base URL of the experimental ranking service, e.g. http://127.0.0.1:8799 */
  url: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const endpointSchema = z.object({
  id: z.string().min(1).max(128),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  antenna_height_m: z.number().positive().max(200).nullish(),
  role: z.number().int().nullish(),
});

const requestSchema = z.object({
  candidate: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    antenna_height_m: z.number().positive().max(200).nullish(),
    role: z.number().int().nullish(),
  }),
  repeaters: z.array(endpointSchema).min(1).max(500),
  top_k: z.number().int().min(1).max(100).optional(),
});

export function registerExperimentalRank(app: FastifyInstance, opts: ExperimentalRankOptions): void {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  app.get('/api/v1/experimental/rank/health', async (_req, reply) => {
    try {
      const r = await doFetch(`${opts.url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return reply.code(503).send({ error: 'ranking-service-unavailable' });
      return await r.json();
    } catch {
      return reply.code(503).send({ error: 'ranking-service-unavailable' });
    }
  });

  app.post('/api/v1/experimental/rank', async (req, reply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid-request', issues: parsed.error.issues });
    }
    try {
      const r = await doFetch(`${opts.url}/rank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) {
        return reply.code(502).send({ error: 'ranking-service-error', status: r.status });
      }
      return await r.json();
    } catch {
      return reply.code(504).send({ error: 'ranking-service-timeout' });
    }
  });
}
