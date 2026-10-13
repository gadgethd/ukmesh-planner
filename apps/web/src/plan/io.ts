/**
 * Plan export/import (Stage 6): deterministic, dependency-free serialisations.
 *
 * - GeoJSON: site point + predicted link lines (properties carry the
 *   assessment factors so the export explains itself in any GIS tool).
 * - CSV: one row per link, stable column order.
 * - JSON: the full plan (round-trips through import).
 */
import { z } from 'zod';
import { DEFAULT_UK_RF_SETTINGS, rfSettingsSchema } from '@ukmesh-planner/contracts';
import type { SerializedPlan } from './store.js';

export interface ExportLink {
  targetId: string;
  targetName: string | null;
  targetLat: number;
  targetLon: number;
  classification: string;
  distanceKm: number;
  marginDb: number | null;
}

export interface ExportSite {
  lat: number;
  lon: number;
  antennaHeightAglM: number;
}

export function planToGeoJSON(site: ExportSite, links: ExportLink[]): string {
  const features = [
    {
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [site.lon, site.lat] },
      properties: {
        kind: 'proposed-site',
        antennaHeightAglM: site.antennaHeightAglM,
      },
    },
    ...links.map((l) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [site.lon, site.lat],
          [l.targetLon, l.targetLat],
        ],
      },
      properties: {
        kind: 'predicted-link',
        targetId: l.targetId,
        targetName: l.targetName,
        classification: l.classification,
        distanceKm: l.distanceKm,
        marginDb: l.marginDb,
      },
    })),
  ];
  return JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
}

export function planToCSV(site: ExportSite, links: ExportLink[]): string {
  const header = [
    'site_lat',
    'site_lon',
    'site_antenna_m',
    'target_id',
    'target_name',
    'target_lat',
    'target_lon',
    'classification',
    'distance_km',
    'margin_db',
  ].join(',');
  const rows = links.map((l) =>
    [
      site.lat.toFixed(6),
      site.lon.toFixed(6),
      site.antennaHeightAglM,
      l.targetId,
      csvEscape(l.targetName ?? ''),
      l.targetLat.toFixed(6),
      l.targetLon.toFixed(6),
      l.classification,
      l.distanceKm.toFixed(3),
      l.marginDb === null ? '' : l.marginDb.toFixed(2),
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const serializedPlanSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['simple', 'advanced']),
  site: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      antennaHeightAglM: z.number().min(0).max(100),
    })
    .nullable(),
  rf: rfSettingsSchema,
});

export type ParseResult = { ok: true; plan: SerializedPlan } | { ok: false; error: string };

export function parsePlanJSON(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  const parsed = serializedPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Not a UK Mesh Planner plan file (schema mismatch).' };
  }
  return { ok: true, plan: parsed.data };
}

export function exportPlanJSON(plan: SerializedPlan): string {
  return JSON.stringify(plan, null, 2);
}

export const DEFAULT_PLAN_RF = DEFAULT_UK_RF_SETTINGS;
