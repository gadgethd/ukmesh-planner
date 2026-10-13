import { describe, expect, it } from 'vitest';
import {
  initialPlanState,
  setAdvancedToggles,
  setMode,
  setProfilePair,
  setRf,
  setSite,
  type PlanState,
} from './planState.js';

function withSite(): PlanState {
  return setSite(initialPlanState, { lat: 54.97, lon: -1.61, antennaHeightAglM: 4 });
}

describe('plan state transitions (MODES)', () => {
  it('mode switch preserves site, rf and advanced selections', () => {
    let s = withSite();
    s = setRf(s, { ...s.rf, frequencyMhz: 869.525, txPowerDbm: 27 });
    s = setProfilePair(s, { repeaterId: 'r1', label: 'R1', lat: 54.9, lon: -1.7, antennaHeightAglM: 2 });
    s = setAdvancedToggles(s, { showObserved: false });
    const adv = setMode(s, 'advanced');
    const back = setMode(adv, 'simple');
    expect(back.site).toEqual(s.site);
    expect(back.rf.frequencyMhz).toBe(869.525);
    expect(back.rf.txPowerDbm).toBe(27);
    expect(back.advanced.profilePair?.repeaterId).toBe('r1');
    expect(back.advanced.showObserved).toBe(false);
    expect(back.mode).toBe('simple');
  });

  it('site updates preserve mode and rf', () => {
    let s = setMode(initialPlanState, 'advanced');
    s = setRf(s, { ...s.rf, rxSensitivityDbm: -120 });
    s = setSite(s, { lat: 51.5, lon: -0.1, antennaHeightAglM: 10 });
    expect(s.mode).toBe('advanced');
    expect(s.rf.rxSensitivityDbm).toBe(-120);
    expect(s.site?.lat).toBe(51.5);
  });

  it('clearing the site leaves mode, rf and advanced intact', () => {
    let s = withSite();
    s = setMode(s, 'advanced');
    s = setProfilePair(s, { repeaterId: null, label: 'point', lat: 55, lon: -2, antennaHeightAglM: 2 });
    s = setSite(s, null);
    expect(s.site).toBeNull();
    expect(s.mode).toBe('advanced');
    expect(s.advanced.profilePair?.label).toBe('point');
  });

  it('does not mutate the previous state object', () => {
    const s0 = withSite();
    const s1 = setMode(s0, 'advanced');
    const s2 = setRf(s1, { ...s1.rf, txGainDbi: 9 });
    expect(s0.mode).toBe('simple');
    expect(s1.rf.txGainDbi).toBe(s0.rf.txGainDbi);
    expect(s2.mode).toBe('advanced');
    expect(s0).not.toBe(s1);
    expect(s1).not.toBe(s2);
  });
});
