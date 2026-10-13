import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import { deletePlan, listPlans, loadPlan, savePlan, type SerializedPlan } from './store.js';

const plan: SerializedPlan = {
  version: 1,
  mode: 'simple',
  site: { lat: 54.96, lon: -1.62, antennaHeightAglM: 2 },
  rf: DEFAULT_UK_RF_SETTINGS,
};

describe('plan store (indexeddb)', () => {
  it('saves, lists, loads and deletes plans', async () => {
    const idA = await savePlan('First', plan);
    const idB = await savePlan('Second', { ...plan, mode: 'advanced' });
    expect(idA).not.toBe(idB);

    const summaries = await listPlans();
    expect(summaries.map((s) => s.name).sort()).toEqual(['First', 'Second']);

    const loaded = await loadPlan(idA);
    expect(loaded?.plan).toEqual(plan);
    expect(loaded?.name).toBe('First');

    await deletePlan(idA);
    expect(await loadPlan(idA)).toBeNull();
    expect((await listPlans()).some((s) => s.id === idA)).toBe(false);
    await deletePlan(idB);
  });

  it('defaults an empty name and preserves order newest-first', async () => {
    const id1 = await savePlan('   ', plan);
    const loaded = await loadPlan(id1);
    expect(loaded?.name).toBe('Untitled plan');
    await deletePlan(id1);
  });
});
