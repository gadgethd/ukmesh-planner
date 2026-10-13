/**
 * Snapshot validation — fail closed.
 *
 * HARD ERRORS reject the whole snapshot (previous published snapshot stays).
 * SOFT issues are sanitized (truncation) with warnings, so a single cosmetic
 * anomaly can never brick ingestion while structural/privacy/count problems
 * always fail loudly. Rationale: build brief §4.3 — "atomically swap ... only
 * when nodes + links + visibility all pass validation".
 */
import type { SourceLinkRow, SourceRepeaterRow } from './source.js';
import type { IngestBounds } from './config.js';

export interface PrevCounts {
  snapshotId: string;
  repeaters: number;
  links: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  sanitizedRepeaters: SourceRepeaterRow[];
}

const CANONICAL_ID_RE = /^[0-9A-F]{64}$/;
const NAME_MAX = 200;
const MODEL_MAX = 120;
const FW_MAX = 64;
const IATA_MAX = 8;

function trunc(v: string | null, max: number): string | null {
  if (v === null) return null;
  return v.length > max ? v.slice(0, max) : v;
}

export function validateSnapshot(
  input: { repeaters: SourceRepeaterRow[]; links: SourceLinkRow[] },
  bounds: IngestBounds,
  prev: PrevCounts | null,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const sanitizedRepeaters: SourceRepeaterRow[] = [];

  // ---- repeaters -----------------------------------------------------------
  const seenIds = new Set<string>();
  for (const r of input.repeaters) {
    if (!CANONICAL_ID_RE.test(r.canonical_id)) {
      errors.push(`repeater id not canonical hex64: ${String(r.canonical_id).slice(0, 80)}`);
      continue;
    }
    if (seenIds.has(r.canonical_id)) {
      errors.push(`duplicate repeater id ${r.canonical_id}`);
      continue;
    }
    seenIds.add(r.canonical_id);

    if (!Number.isFinite(r.lat) || r.lat < -90 || r.lat > 90) {
      errors.push(`repeater ${r.canonical_id}: lat out of range (${r.lat})`);
      continue;
    }
    if (!Number.isFinite(r.lon) || r.lon < -180 || r.lon > 180) {
      errors.push(`repeater ${r.canonical_id}: lon out of range (${r.lon})`);
      continue;
    }
    if (r.name !== null && r.name.length > NAME_MAX) {
      warnings.push(`repeater ${r.canonical_id}: name truncated (${r.name.length} chars)`);
    }
    sanitizedRepeaters.push({
      ...r,
      name: trunc(r.name, NAME_MAX),
      hardware_model: trunc(r.hardware_model, MODEL_MAX),
      firmware_version: trunc(r.firmware_version, FW_MAX),
      iata: trunc(r.iata, IATA_MAX),
    });
  }

  // ---- links: both endpoints must be published repeaters -------------------
  const idSet = new Set(sanitizedRepeaters.map((r) => r.canonical_id));
  const seenPairs = new Set<string>();
  let linkErrors = 0;
  for (const l of input.links) {
    if (!CANONICAL_ID_RE.test(l.source_id) || !CANONICAL_ID_RE.test(l.target_id)) {
      linkErrors += 1;
      continue;
    }
    if (l.source_id === l.target_id) {
      linkErrors += 1;
      continue;
    }
    if (!idSet.has(l.source_id) || !idSet.has(l.target_id)) {
      linkErrors += 1;
      continue;
    }
    if (!Number.isFinite(l.observed_count) || l.observed_count < 1) {
      linkErrors += 1;
      continue;
    }
    const key = `${l.source_id}|${l.target_id}`;
    if (seenPairs.has(key)) {
      linkErrors += 1;
      continue;
    }
    seenPairs.add(key);
  }
  if (linkErrors > 0) {
    errors.push(`${linkErrors} link rows failed structural checks (endpoints/self/dup/count)`);
  }

  // ---- counts: hard bounds + relative guard vs previous published ----------
  const repCount = sanitizedRepeaters.length;
  const linkCount = seenPairs.size;
  if (repCount < bounds.repeaterMin || repCount > bounds.repeaterMax) {
    errors.push(`repeater count ${repCount} outside hard bounds [${bounds.repeaterMin}, ${bounds.repeaterMax}]`);
  }
  if (linkCount < bounds.linkMin || linkCount > bounds.linkMax) {
    errors.push(`link count ${linkCount} outside hard bounds [${bounds.linkMin}, ${bounds.linkMax}]`);
  }
  if (prev !== null) {
    const minRep = Math.floor(prev.repeaters * bounds.shrinkRatioMin);
    const maxRep = Math.ceil(prev.repeaters * bounds.growRatioMax);
    if (repCount < minRep || repCount > maxRep) {
      errors.push(
        `repeater count ${repCount} breaks relative guard vs ${prev.snapshotId} ` +
          `(${prev.repeaters} -> allowed [${minRep}, ${maxRep}])`,
      );
    }
    const minLink = Math.floor(prev.links * bounds.shrinkRatioMin);
    const maxLink = Math.ceil(prev.links * bounds.growRatioMax);
    if (linkCount < minLink || linkCount > maxLink) {
      errors.push(
        `link count ${linkCount} breaks relative guard vs ${prev.snapshotId} ` +
          `(${prev.links} -> allowed [${minLink}, ${maxLink}])`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings, sanitizedRepeaters };
}
