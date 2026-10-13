# RF model assumptions (v1 — uncalibrated)

Every number below is implemented in `packages/rf-core` and shared by the
browser worker (and, later, the WebGPU tier). This document is the honest
boundary of what a planner prediction does and does not claim.

## Link budget

- Frequency 868 MHz, TX power 22 dBm, TX gain 3 dBi, RX gain 0 dBi,
  RX sensitivity −124 dBm (`DEFAULT_UK_RF_SETTINGS`).
- Free-space loss: 32.44 + 20·log10(km) + 20·log10(MHz).
- Terrain loss: Deygout 3-edge diffraction over the sampled profile.
- Earth curvature: 4/3 effective-radius bulge subtracted at each sample.
- Margin = rxPower − sensitivity. Classification:
  - `likely` margin ≥ 15 dB
  - `marginal` margin ≥ 5 dB and first-Fresnel clearance ratio ≥ 0
  - `blocked` clearance ratio < 0 and below margins
  - `unlikely` clear geometry but margin < 5 dB
  - `unknown-terrain` any profile sample without terrain data (fail closed —
    never reported as a green link)

## Terrain sampling

- Terrarium PNG tiles, z ≤ 12 (~22 m/px at UK latitudes), bilinear sampling.
- Water is encoded as negative bathymetry-like values (sea ≈ −50 m); these are
  real data and are used as-is.
- NODATA pixels (−32768) are treated as unknown. A sample landing on NODATA
  makes the whole path `unknown-terrain`.
- Tile-edge handling: samples are clamped to the addressable pixel range
  [0, 255] of their tile (≤ 1 px ≈ 22 m positional error). Without this clamp,
  every sample in the outer pixel band of a tile edge is rejected by
  `bilinearSample` (which accepts pixel-centre coordinates only) — observed as
  spurious "missing terrain" on ~half of all paths during Stage 3 testing.
- Tile fetch failures are retried once and are never cached permanently
  (a transient network error must not poison a tile for the session).

## What a prediction is not

- Not a survey: terrain is OS Terrain 50 (50 m source resolution), no
  clutter/vegetation/buildings, no antenna patterns, no ducting.
- Not calibrated: v1 uses the documented budget above. Observed links
  (`/api/v1/observed-links`) are the calibration/validation evidence base and
  are kept distinct from predictions everywhere in the UI.
- Missing data fails closed: paths without terrain are `unknown-terrain`.
