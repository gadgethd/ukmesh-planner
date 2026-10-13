import { describe, expect, it } from 'vitest';
import type { IngestBounds } from './config.js';
import type { SourceLinkRow, SourceRepeaterRow } from './source.js';
import { validateSnapshot } from './validate.js';

const B: IngestBounds = {
  repeaterMin: 1,
  repeaterMax: 1000,
  linkMin: 0,
  linkMax: 10_000,
  shrinkRatioMin: 0.5,
  growRatioMax: 2,
};

const A = 'A'.repeat(64);
const Bb = 'B'.repeat(64);

function rep(id: string, over: Partial<SourceRepeaterRow> = {}): SourceRepeaterRow {
  return {
    canonical_id: id,
    name: `R ${id.slice(0, 4)}`,
    lat: 54.6,
    lon: -1.6,
    last_seen: new Date(),
    is_online: true,
    hardware_model: 'Heltec V3',
    firmware_version: '1.10.0',
    iata: 'NCL',
    advert_count: 5,
    identity_member_count: 1,
    ...over,
  };
}

function link(s: string, t: string, over: Partial<SourceLinkRow> = {}): SourceLinkRow {
  return {
    source_id: s,
    target_id: t,
    observed_count: 3,
    strong_observation_count: 1,
    count_a_to_b: 2,
    count_b_to_a: 1,
    last_observed: new Date(),
    path_loss_db: 120,
    itm_viable: true,
    force_viable: false,
    ...over,
  };
}

describe('validateSnapshot', () => {
  it('accepts a clean snapshot', () => {
    const v = validateSnapshot({ repeaters: [rep(A), rep(Bb)], links: [link(A, Bb)] }, B, null);
    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
    expect(v.sanitizedRepeaters).toHaveLength(2);
  });

  it('rejects non-canonical ids', () => {
    const v = validateSnapshot({ repeaters: [rep('not-hex'), rep(Bb)], links: [] }, B, null);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain('hex64');
  });

  it('rejects duplicate repeater ids', () => {
    const v = validateSnapshot({ repeaters: [rep(A), rep(A)], links: [] }, B, null);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('duplicate'))).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    const v = validateSnapshot({ repeaters: [rep(A, { lat: 120 })], links: [] }, B, null);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('lat'))).toBe(true);
  });

  it('rejects links with unknown endpoints / self links / dup pairs', () => {
    const v = validateSnapshot(
      {
        repeaters: [rep(A), rep(Bb)],
        links: [link(A, 'C'.repeat(64)), link(A, A), link(A, Bb), link(A, Bb)],
      },
      B,
      null,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('link rows failed'))).toBe(true);
  });

  it('rejects counts outside hard bounds', () => {
    const v = validateSnapshot({ repeaters: [rep(A)], links: [] }, { ...B, repeaterMin: 10 }, null);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('hard bounds'))).toBe(true);
  });

  it('rejects relative shrink vs previous published snapshot', () => {
    const prev = { snapshotId: 'snap-prev', repeaters: 100, links: 50 };
    const v = validateSnapshot({ repeaters: [rep(A)], links: [] }, B, prev);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('relative guard'))).toBe(true);
  });

  it('accepts growth within the guard', () => {
    const prev = { snapshotId: 'snap-prev', repeaters: 2, links: 1 };
    const v = validateSnapshot({ repeaters: [rep(A), rep(Bb)], links: [link(A, Bb)] }, B, prev);
    expect(v.ok).toBe(true);
  });

  it('truncates overlong fields with a warning instead of failing', () => {
    const v = validateSnapshot({ repeaters: [rep(A, { name: 'x'.repeat(500) })], links: [] }, B, null);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes('truncated'))).toBe(true);
    expect(v.sanitizedRepeaters[0]!.name).toHaveLength(200);
  });
});
