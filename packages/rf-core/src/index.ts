/**
 * @ukmesh-planner/rf-core — CPU reference implementation of the RF/terrain
 * models used by every planner backend (browser WASM, WebGPU parity oracle,
 * tests). All equations implemented from documented sources; no third-party
 * code copied (decision D-003).
 */
export * from './geo.js';
export * from './dem.js';
export * from './los.js';
export * from './diffraction.js';
export * from './assess.js';

export type { LinkClassification, LinkResult, RfSettings } from '@ukmesh-planner/contracts';
export {
  calibrateFromObservedLinks,
  pathLossBand,
  weightedQuantile,
  DEFAULT_USABLE_PATH_LOSS_DB,
  type CalibrationInput,
  type LinkCalibration,
} from './calibration.js';
