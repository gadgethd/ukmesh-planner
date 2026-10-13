/**
 * Link-quality calibration — mirrors the live MeshCore analytics system's
 * weighted-quantile scheme (viewshed-worker refresh_rf_calibration) so the
 * planner's "viable" thresholds track the network the same way.
 *
 * Deviation, documented: the live system weights each observed link by
 * sqrt(packet_count) x an SNR-band factor. Packet-level SNR is not (yet)
 * part of the planner export, so weights here use sqrt(observed_count) x a
 * neutral factor (1.0) — the quantiles remain data-driven, just without the
 * SNR tilt. See the deployment report for the follow-up (expose median SNR
 * in the export view to make the weighting exact).
 */

export interface CalibrationInput {
  pathLossDb: number;
  observedCount: number;
}

export interface LinkCalibration {
  usablePathLossDb: number;
  green: number;
  amber: number;
  samples: number;
}

/**
 * Live neighbours-map link thresholds (analytics frontend mapConfig.ts).
 * The live map draws green <= 121.5 dB and amber <= 129.5 dB, and treats
 * anything above the amber threshold as not viable — it is never drawn.
 * The planner mirrors this exactly (Ben's rule: non-viable links are not
 * shown at all).
 */
export const MAP_LINK_GREEN_THRESHOLD_DB = 121.5;
export const MAP_LINK_AMBER_THRESHOLD_DB = 129.5;

export type MapLinkBand = 'green' | 'amber';

/**
 * Band a modelled path loss exactly like the live neighbours map, or null
 * when the link must not be drawn at all (> amber threshold).
 */
export function mapLinkBand(pathLossDb: number | null): MapLinkBand | null {
  if (pathLossDb === null || !Number.isFinite(pathLossDb)) return null;
  if (pathLossDb <= MAP_LINK_GREEN_THRESHOLD_DB) return 'green';
  if (pathLossDb <= MAP_LINK_AMBER_THRESHOLD_DB) return 'amber';
  return null;
}

/** Live-system constants (rf/config.py). */
export const DEFAULT_USABLE_PATH_LOSS_DB = 137.5;
export const CALIBRATION_MIN_LINKS = 24;
export const CALIBRATION_PERCENTILE = 0.9;
export const CALIBRATION_EXTRA_MARGIN_DB = 0.5;
export const CALIBRATION_MAX_THRESHOLD_BOOST_DB = 2;

function defaultCalibration(): LinkCalibration {
  return {
    usablePathLossDb: DEFAULT_USABLE_PATH_LOSS_DB,
    green: Math.max(116.0, DEFAULT_USABLE_PATH_LOSS_DB - 16.0),
    amber: Math.max(124.0, DEFAULT_USABLE_PATH_LOSS_DB - 8.0),
    samples: 0,
  };
}

/**
 * Weighted quantile — exact port of the live system's step-function version
 * (worker.py weighted_quantile): sort by value, cumulative weights,
 * first index whose cumulative weight reaches q x total (numpy
 * searchsorted side='left'). No interpolation.
 */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const order = values
    .map((value, i) => ({ value, weight: Math.max(0, weights[i] ?? 0) }))
    .sort((a, b) => a.value - b.value);
  const cumulative: number[] = [];
  let running = 0;
  for (const e of order) {
    running += e.weight;
    cumulative.push(running);
  }
  const target = Math.min(1, Math.max(0, q)) * running;
  let idx = cumulative.findIndex((c) => c >= target);
  if (idx < 0) idx = order.length - 1;
  return order[Math.max(0, Math.min(idx, order.length - 1))]!.value;
}

/**
 * Calibrate the viability thresholds from the snapshot's observed links.
 * Mirrors refresh_rf_calibration: green = q35, amber = q65,
 * usable = q90 + 0.5 (clamped to [110, default + 2]); fewer than 24 usable
 * links falls back to the documented defaults.
 */
export function calibrateFromObservedLinks(rows: CalibrationInput[]): LinkCalibration {
  const usable = rows.filter((r) => Number.isFinite(r.pathLossDb));
  if (usable.length < CALIBRATION_MIN_LINKS) return defaultCalibration();

  const losses = usable.map((r) => r.pathLossDb);
  const weights = usable.map((r) => Math.min(24.0, Math.max(0.5, Math.sqrt(Math.max(1, r.observedCount)) * 1.0)));

  const green = weightedQuantile(losses, weights, 0.35);
  const amberRaw = weightedQuantile(losses, weights, 0.65);
  const observedTail = weightedQuantile(losses, weights, CALIBRATION_PERCENTILE);
  let usablePathLossDb = observedTail + CALIBRATION_EXTRA_MARGIN_DB;
  usablePathLossDb = Math.min(DEFAULT_USABLE_PATH_LOSS_DB + CALIBRATION_MAX_THRESHOLD_BOOST_DB, usablePathLossDb);
  usablePathLossDb = Math.max(110.0, usablePathLossDb);
  const greenClamped = Math.min(green, usablePathLossDb);
  const amberClamped = Math.min(Math.max(greenClamped, amberRaw), usablePathLossDb);

  return {
    usablePathLossDb: round2(usablePathLossDb),
    green: round2(greenClamped),
    amber: round2(amberClamped),
    samples: usable.length,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Band a path loss against calibrated thresholds (live naming). */
export function pathLossBand(pathLossDb: number, calibration: LinkCalibration): 'green' | 'amber' | 'red' {
  if (pathLossDb < calibration.green) return 'green';
  if (pathLossDb < calibration.amber) return 'amber';
  return 'red';
}
