/**
 * Shared plan state for Simple and Advanced modes.
 *
 * One plan, one data store (plan §5.2): switching modes never discards the
 * proposed site, antenna heights, RF edits or advanced selections. All
 * transitions are pure functions so mode behaviour is unit-testable without
 * the DOM.
 */
import { DEFAULT_UK_RF_SETTINGS, type RfSettings } from '@ukmesh-planner/contracts';

export type Mode = 'simple' | 'advanced';

export interface PlannedSite {
  lat: number;
  lon: number;
  antennaHeightAglM: number;
}

export interface ProfilePair {
  /** Existing repeater (or second point) side of the profile. */
  repeaterId: string | null;
  label: string;
  lat: number;
  lon: number;
  antennaHeightAglM: number;
}

export interface PlanState {
  mode: Mode;
  site: PlannedSite | null;
  /** Editable RF settings — shared by Simple and Advanced (plan §5.2.2). */
  rf: RfSettings;
  advanced: {
    /** Profile target; null = no profile shown. */
    profilePair: ProfilePair | null;
    showObserved: boolean;
    showPredicted: boolean;
  };
}

export const initialPlanState: PlanState = {
  mode: 'simple',
  site: null,
  rf: { ...DEFAULT_UK_RF_SETTINGS },
  advanced: {
    profilePair: null,
    showObserved: true,
    showPredicted: true,
  },
};

export function setMode(state: PlanState, mode: Mode): PlanState {
  return { ...state, mode };
}

export function setSite(state: PlanState, site: PlannedSite | null): PlanState {
  return { ...state, site };
}

export function setRf(state: PlanState, rf: RfSettings): PlanState {
  return { ...state, rf };
}

export function setProfilePair(state: PlanState, profilePair: ProfilePair | null): PlanState {
  return { ...state, advanced: { ...state.advanced, profilePair } };
}

export function setAdvancedToggles(
  state: PlanState,
  toggles: Partial<Pick<PlanState['advanced'], 'showObserved' | 'showPredicted'>>,
): PlanState {
  return { ...state, advanced: { ...state.advanced, ...toggles } };
}
