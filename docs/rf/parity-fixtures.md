# RF parity fixtures (WebGPU vs CPU oracle)

The WebGPU coverage kernel must reproduce the shared TypeScript CPU core
(`packages/rf-core`) within documented tolerances on identical input. This
file records the fixtures used, how to reproduce them, and the boundary
exceptions with their causes.

## Fixtures

1. **Synthetic flat raster** (`tools/parity/probes/synthetic-flat-raster.js`,
   expectation in `tools/parity/synthetic-flat-expected.json`): a flat 50 m
   DEM at the Newcastle test site (-1.6237, 54.9648), 128 x 128 cells, 25 km
   half-size. Expected GPU counts `[5190, 0, 0, 11194, 0, 0]` vs CPU oracle
   `[5186, 0, 0, 11198, 0, 0]` (4-cell f32 threshold noise), centre margin
   69.0 dB, corner 3.9 dB. Isolates geometry + link-budget math from DEM
   content; a shift-blind check by construction (uniform terrain).
2. **Real-data parity run** (`tools/parity/wgpu-probe.py`): the deployed
   worker runs the coverage kernel once on WebGPU (forced) and twice on the
   CPU over the same site/geometry/rf, then diffs margins and classifications.
   Expected: `verdict: pass` with mean |delta| ~0.24 dB and the mismatches
   limited to the boundary classes below.
3. **WASM core vs CPU oracle** (`tools/parity/wgpu-probe.py`, node-side
   fixture in `apps/web/src/compute/wasm/wasm-parity.test.ts`): the WASM
   backend must match the CPU oracle exactly. Measured: **0/16,384
   classification mismatches and 0.000 dB margin difference** on the real
   window (both f64); the node test asserts the same over a synthetic window
   with ridge + nodata features.
4. **Boundary exception fixture**
   (`tools/parity/parity-boundary-analysis.json`): the eight worst mismatch
   cells with their f64 profile analysis. Each cell has interior samples
   within ~1 m of the horizon (minimum positive clearance 2.5 mm - 0.9 m);
   each mismatch is one `knifeEdge(v~0)` = 6.03 dB inclusion step flipping on
   f32-vs-f64 sample-position differences (~1 - 2 m).

## Boundary exception taxonomy

Both classes are inherent to f32 (GPU) vs f64 (CPU) arithmetic; neither is a
model difference. Do not "fix" them by loosening the model; re-run the probe
after any kernel change and re-validate the counts.

- **Class A - threshold proximity.** The margin sits within ~2 dB of the
  15 dB (likely) or 5 dB (marginal) boundary; a sub-0.1 dB numerical
  difference flips the label. Example: cell 6735, GPU 15.00 vs CPU 15.05 dB.
- **Class B - near-horizon knife edge.** An interior sample grazes the
  chord (h within ~1 m of 0). One implementation includes the sub-edge
  (~6.03 dB), the other skips it (`h <= 0`). Examples: cells 6859, 6991,
  7994, 8273 (delta 6.0 - 6.4 dB).

## Invariants verified by the probe

- CPU runs are deterministic (identical unknown sets across runs).
- The CPU unknown-terrain set is empty for the test window: the provider's
  `warmPath` samples at exactly the profile's spacing (same `n` => identical
  sample positions), so no profile sample can hit an unloaded tile.
  (Historic bug: 400 m warm sampling vs 90 m profile sampling skipped
  corner-clipped tiles -> 42 spurious unknown cells; fixed.)
- The coverage window's 110 terrain tiles all fetch OK; tile failures are
  never cached as absent permanently.

## Numerical preconditions

- The shader carries its own `sin`/`cos`/`atan2` (Cody-Waite + Taylor,
  ~2e-7). SwiftShader's built-ins measured ~3e-5 (non-normalised) and broke
  parity by displacing sample points >200 m. Keep the shader implementations
  in place; `probes/trig-accuracy.js` verifies them (`pass: true`).
- Params/geometry come from shared code (`coverage/params.ts`); the kernel's
  `n` formula mirrors `buildProfile` exactly.

## Offline regression fixtures (2026-10-22)

The branch now adds a local suite independent of the staging deployment:
[`tools/webgpu/README.md`](../../tools/webgpu/README.md). Nine fixed 32×32
rasters read deterministic, tile-aligned synthetic DEM windows at native z12
resolution. A fixed north-up, zero-pitch 512×512 canvas renders the same RGBA
palette used by the map. CPU reference images, SHA-256 code/RGBA hashes and
millidecibel margin arrays live in [`fixtures/webgpu`](../../fixtures/webgpu/).
Reference regeneration is an explicit command, never part of a test.

The verified Chromium/SwiftShader fixture runs measured:

| Terrain | Mean GPU margin error (dB) | Max error (dB) | Class changes / 1,024 |
| --- | ---: | ---: | ---: |
| Flat 50 m | 0.000382 | 0.0157 | 0 |
| Ridge | 0.041329 | 3.1426 | 0 |
| Unequal hills | 0.057961 | 6.0695 | 2 |
| Coast / valid sea level | 0.041112 | 6.0348 | 0 |
| Missing DEM stripe | 0.000376 | 0.0128 | 0 |
| 5 km range cutoff | 0.000842 | 0.0044 | 0 |
| Raised mast | 0.016075 | 1.0601 | 0 |
| High-latitude UK hills | 0.063526 | 6.0446 | 1 |
| Low RF budget (marginal/unlikely colors) | 0.000151 | 0.0044 | 0 |

All unknown and out-of-range masks matched exactly. Across all nine fixtures, WASM codes and RGBA hashes
matched CPU on every fixture; the largest WASM/Chromium CPU margin difference
was 0.006208 dB (flat terrain), with all other fixtures exact in this run. Node
and Chromium also differ slightly in transcendental arithmetic, so numerical
reference margins use a 0.01 dB cross-runtime tolerance while reference code
and RGBA hashes remain exact. CPU hashes must repeat exactly within a runtime.
The GPU gate retains the previously documented 0.3 dB mean, 0.25% class-change
ceiling and boundary-exception policy; missing/range mismatches always fail.

The real UI is tested separately on synthetic Terrarium PNGs, forcing WGSL at
1280×800 and removing WebGPU in both page and worker at 390×844. Compile failure
and real device destruction are also injected in a browser: each job must return
WASM output for the same site/RF/DEM and stop retrying the broken GPU. Unit tests
cover allocation, asynchronous validation errors, partial allocation cleanup,
limit checks, device reuse and cancellation. These checks exercise the current
engine rather than a separately reconstructed shader runner.
