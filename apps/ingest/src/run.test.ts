import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import type { IngestConfig } from './config.js';
import { makeSnapshotId, runOnce, type IngestDeps, type PublicationInput } from './run.js';
import type { FetchResult, FenceRow } from './source.js';
import type { PrevCounts, ValidationResult } from './validate.js';

const A = 'A'.repeat(64);
const Bb = 'B'.repeat(64);

export function testConfig(over: Partial<IngestConfig> = {}): IngestConfig {
  return {
    sourceDbUrl: 'postgres://reader@source/db',
    plannerDbUrl: 'postgres://planner@planner/db',
    intervalMs: 1000,
    jitterMs: 0,
    statementTimeoutMs: 5000,
    pruneKeep: 5,
    dryRun: false,
    once: true,
    bounds: { repeaterMin: 1, repeaterMax: 1000, linkMin: 0, linkMax: 10_000, shrinkRatioMin: 0.5, growRatioMax: 2 },
    ...over,
  };
}

function fence(generation: number): FenceRow {
  return { generation, updated_at: new Date(), queried_at: new Date() };
}

function fetch(gen: number): FetchResult {
  return {
    fence: fence(gen),
    repeaters: [
      { canonical_id: A, name: 'One', lat: 54.6, lon: -1.6, last_seen: new Date(), is_online: true, hardware_model: null, firmware_version: null, iata: null, advert_count: 1, identity_member_count: 1 },
      { canonical_id: Bb, name: 'Two', lat: 54.7, lon: -1.5, last_seen: new Date(), is_online: false, hardware_model: null, firmware_version: null, iata: null, advert_count: 2, identity_member_count: 1 },
    ],
    links: [
      { source_id: A, target_id: Bb, observed_count: 2, strong_observation_count: 0, count_a_to_b: 1, count_b_to_a: 1, last_observed: new Date(), path_loss_db: null, itm_viable: null, force_viable: false },
    ],
    timingsMs: { fenceBefore: 1, repeaters: 2, links: 3, total: 6 },
  };
}

function okValidation(): ValidationResult {
  const f = fetch(1);
  return { ok: true, errors: [], warnings: [], sanitizedRepeaters: f.repeaters };
}

interface Spy {
  fetches: number[];
  fencesRead: number;
  published: PublicationInput[];
  prunes: number;
}

function makeDeps(script: { fenceReads: number[]; fetchGens?: number[]; validation?: ValidationResult }): { deps: IngestDeps; spy: Spy } {
  const spy: Spy = { fetches: [], fencesRead: 0, published: [], prunes: 0 };
  const fetchGens = script.fetchGens ?? [810];
  let fetchIdx = 0;
  const deps: IngestDeps = {
    makeSourceClient: () => ({ connect: async () => {}, end: async () => {} } as unknown as Client),
    makePlannerClient: () => ({ connect: async () => {}, end: async () => {} } as unknown as Client),
    fetchSnapshot: async () => {
      const gen = fetchGens[Math.min(fetchIdx, fetchGens.length - 1)]!;
      spy.fetches.push(gen);
      fetchIdx += 1;
      return fetch(gen);
    },
    readFence: async () => {
      const g = script.fenceReads[Math.min(spy.fencesRead, script.fenceReads.length - 1)]!;
      spy.fencesRead += 1;
      return fence(g);
    },
    getPrevPublished: async (): Promise<PrevCounts | null> => null,
    publishSnapshot: async (_c, _cfg, snap) => {
      spy.published.push(snap);
    },
    pruneSnapshots: async () => {
      spy.prunes += 1;
    },
    validate: () => script.validation ?? okValidation(),
  };
  return { deps, spy };
}

describe('runOnce', () => {
  it('publishes when the fence is stable', async () => {
    const { deps, spy } = makeDeps({ fenceReads: [810] });
    const res = await runOnce(testConfig(), deps);
    expect(res.status).toBe('published');
    expect(spy.published).toHaveLength(1);
    expect(spy.published[0]!.generation).toBe(810);
    expect(spy.published[0]!.repeaters).toHaveLength(2);
    expect(spy.prunes).toBe(1);
  });

  it('re-fetches once when the fence moved, then publishes the fresh data', async () => {
    const { deps, spy } = makeDeps({ fenceReads: [811, 811], fetchGens: [810, 811] });
    const res = await runOnce(testConfig(), deps);
    expect(res.status).toBe('published');
    expect(spy.fetches).toEqual([810, 811]);
    expect(spy.published[0]!.generation).toBe(811);
  });

  it('skips the cycle when the fence moves twice', async () => {
    const { deps, spy } = makeDeps({ fenceReads: [811, 812], fetchGens: [810, 811] });
    const res = await runOnce(testConfig(), deps);
    expect(res.status).toBe('skipped');
    expect(spy.published).toHaveLength(0);
  });

  it('does not publish when validation fails', async () => {
    const bad: ValidationResult = { ok: false, errors: ['too few repeaters'], warnings: [], sanitizedRepeaters: [] };
    const { deps, spy } = makeDeps({ fenceReads: [810], validation: bad });
    const res = await runOnce(testConfig(), deps);
    expect(res.status).toBe('failed');
    expect(spy.published).toHaveLength(0);
  });

  it('dry-run validates but does not publish', async () => {
    const { deps, spy } = makeDeps({ fenceReads: [810] });
    const res = await runOnce(testConfig({ dryRun: true }), deps);
    expect(res.status).toBe('skipped');
    expect(spy.published).toHaveLength(0);
  });
});

describe('makeSnapshotId', () => {
  it('produces a deterministic shape', () => {
    const id = makeSnapshotId(810, new Date('2026-10-13T00:22:11.123Z'));
    expect(id).toMatch(/^snap-20261013T002211Z-g810-[0-9a-f]{4}$/);
  });
});
