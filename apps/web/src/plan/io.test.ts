import { describe, expect, it } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import { exportPlanJSON, parsePlanJSON, planToCSV, planToGeoJSON, type ExportLink } from './io.js';
import type { SerializedPlan } from './store.js';

const site = { lat: 54.9648, lon: -1.6237, antennaHeightAglM: 2 };
const links: ExportLink[] = [
  {
    targetId: 'AAAA0001',
    targetName: 'Bank House',
    targetLat: 54.97,
    targetLon: -1.61,
    classification: 'likely',
    distanceKm: 1.5,
    marginDb: 32.1,
  },
  {
    targetId: 'BBBB0002',
    targetName: null,
    targetLat: 54.9,
    targetLon: -1.7,
    classification: 'blocked',
    distanceKm: 9.2,
    marginDb: null,
  },
];

describe('plan export', () => {
  it('geojson carries the site point and one feature per link', () => {
    const fc = JSON.parse(planToGeoJSON(site, links)) as {
      features: Array<{ geometry: { type: string }; properties: Record<string, unknown> }>;
    };
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0]?.geometry.type).toBe('Point');
    expect(fc.features[0]?.properties.kind).toBe('proposed-site');
    expect(fc.features[1]?.properties.classification).toBe('likely');
    expect(fc.features[2]?.properties.marginDb).toBeNull();
  });

  it('csv has a stable header and one row per link, escaping names', () => {
    const csv = planToCSV(site, [...links, { ...links[0]!, targetName: 'A, "B"' }]);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toBe(
      'site_lat,site_lon,site_antenna_m,target_id,target_name,target_lat,target_lon,classification,distance_km,margin_db',
    );
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain('54.964800,-1.623700,2,AAAA0001,Bank House');
    expect(rows[3]).toContain('"A, ""B""');
  });

  it('json round-trips through parsePlanJSON', () => {
    const plan: SerializedPlan = {
      version: 1,
      mode: 'advanced',
      site,
      rf: DEFAULT_UK_RF_SETTINGS,
    };
    const res = parsePlanJSON(exportPlanJSON(plan));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.plan).toEqual(plan);
  });

  it('rejects garbage, wrong version and bad rf values', () => {
    expect(parsePlanJSON('not json').ok).toBe(false);
    expect(parsePlanJSON('{"version":2}').ok).toBe(false);
    const bad = JSON.stringify({
      version: 1,
      mode: 'simple',
      site: null,
      rf: { ...DEFAULT_UK_RF_SETTINGS, frequencyMhz: -1 },
    });
    expect(parsePlanJSON(bad).ok).toBe(false);
  });

  it('accepts a null site (empty plan)', () => {
    const plan: SerializedPlan = { version: 1, mode: 'simple', site: null, rf: DEFAULT_UK_RF_SETTINGS };
    const res = parsePlanJSON(exportPlanJSON(plan));
    expect(res.ok).toBe(true);
  });
});
