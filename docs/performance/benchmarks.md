# Benchmarks and measured performance

## Current offline tiled engine — 2026-10-22

Measured locally on an AMD Ryzen 7 5825U development VM (10 logical CPUs,
16 GiB RAM), Linux x86_64, Headless Chromium 153, Google SwiftShader software
WebGPU. The shared host's concurrent load was not controlled. Each backend ran
serially, with one warm-up and three measured runs per case; the table gives
medians. Raw samples, device limits, every classification boundary cell and
numerical summaries are in [`webgpu-2026-10-22.json`](webgpu-2026-10-22.json).

| Square | DEM tiles | Output cells | GPU bands | CPU (ms) | WASM (ms) | WebGPU (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 km | 9 | 128² / 16,384 | 2 | 378.8 | 240.8 | 106.3 |
| 25 km | 36 | 256² / 65,536 | 8 | 4,970.1 | 5,945.9 | 1,541.1 |
| 50 km | 110 | 512² / 262,144 | 32 | 40,935.2 | 25,327.9 | 11,456.2 |

All cases use the deterministic unequal-hills DEM, without a deployed service.
Times include GPU upload, per-band dispatch/readback and cleanup, or CPU/WASM
kernel execution. They exclude input generation, terrain fetching and initial
shader/module compilation. These are software-adapter observations under a
shared host's load; they do not establish hardware-GPU or mobile performance.
The older real-terrain timings below use different inputs and methodology.

The GPU uses one DEM storage buffer, two output storage buffers and one uniform
buffer. Each output/readback buffer is at most 32 KiB (8,192 cells), independent
of final raster size. A dispatch covers at most 8,192 output cells / 64 rows;
rows shrink with output width and actual device limits. The DEM ceiling is
96 MiB, further restricted by device storage/buffer limits; output is capped
at 512×512. Buffers are released even on partial allocation or readback failure.

| Output | Mean GPU margin error (dB) | Max error (dB) | Class changes | Unknown/range mask changes |
| --- | ---: | ---: | ---: | ---: |
| 128² | 0.157831 | 12.1451 | 25 / 16,384 (0.153%) | 0 |
| 256² | 0.095474 | 12.1574 | 48 / 65,536 (0.073%) | 0 |
| 512² | 0.051837 | 12.1617 | 71 / 262,144 (0.027%) | 0 |

All cases pass the existing mean-error/classification/boundary gate below.
WASM classifications match CPU exactly, with maximum margin differences below
0.000002 dB in these runs. Isolated GPU margin errors are larger than the mean,
consistent with approximately two knife-edge inclusion steps near grazing
geometry (an inference from the measured deltas and historical boundary analysis);
**0.3 dB is a mean-error limit, not a per-cell guarantee**. The checked-in raw
report includes these maxima and every changed classification. See the nine
fixed reference-render fixtures in [`../rf/parity-fixtures.md`](../rf/parity-fixtures.md).

Hardware adapters are auto-selected for WebGPU. No API/adapter, a software
adapter, or adapter/device request failure selects WASM. Software adapters remain
on WASM by default for portability and reproducibility, even though forced
SwiftShader was faster here; the test-only force explicitly exercises WGSL.
GPU compile/validation/OOM/limit/device-loss failure destroys the device and
replays the same frozen DEM, site, RF and geometry on WASM. Further jobs avoid
retrying that broken GPU until a new worker or explicit backend mode change.
WASM preserves requested detail; if it cannot run, JS CPU defaults to 128² with
an explicit reduction notice. No backend sends RF work to the VPS. Hidden tabs
cancel coverage and discard the overlay; returning recomputes the current input.

Reproduce with `npm run test:webgpu` and `npm run benchmark:webgpu`; setup,
assumptions and browser overrides are in [`../../tools/webgpu/README.md`](../../tools/webgpu/README.md).
Validation errors need explicit asynchronous error scopes; this follows the
[WebGPU error model](https://gpuweb.github.io/gpuweb/explainer/#error-scopes).

## Historical staging measurements (before the 2026-10-22 changes)

All numbers below were measured during Stage 4 (browser WebGPU path +
correctness) on the staging deployment (VPS container, app served over an SSH
tunnel) with a headless Chromium **software** WebGPU adapter (SwiftShader).
Hardware-GPU numbers will be recorded on real devices at Stage 7; software
numbers are the conservative floor.

## Coverage preview kernel (50 x 50 km, site near Newcastle)

| Backend | Detail | Cells | Samples/path (avg) | Wall time |
| --- | --- | --- | --- | --- |
| CPU core (shared TS oracle, browser worker) | low (128 x 128) | 16,384 | ~280 | 3.8 - 5.7 s |
| WASM core (AssemblyScript, f64) | low (128 x 128) | 16,384 | ~280 | **2.2 - 2.3 s** |
| WebGPU (SwiftShader) | low (128 x 128) | 16,384 | ~280 | **1.5 - 1.9 s** |
| WASM core | medium (256 x 256) | 65,536 | ~280 | ~10 s (UI flow verified) |
| WebGPU (SwiftShader) | medium (256 x 256) | 65,536 | ~280 | ~18 - 20 s |

- Speed-ups at low detail: WASM ~2.4x vs the CPU core; WebGPU (software
  rasterizer) ~2.5 - 3.3x. WASM and the software GPU are comparable (2.3 s vs
  1.9 s) — the WASM tier is preferred for software/no-GPU environments for
  determinism and portability, and it runs full requested detail (no
  resolution reduction). Hardware GPUs are expected to be substantially
  faster (to be measured at Stage 7).
- The CPU core fallback is bounded: the worker caps CPU detail at 128 x 128
  cells with an explicit notice ("CPU fallback computes at reduced detail
  ..."); it remains the parity oracle and the fallback of last resort.
- No VPS compute is used for assessments or coverage: the API only serves
  snapshot data; all RF math runs in the visitor's browser.

## Simple-mode assessment (single site, nearest 300 repeaters)

- Worker assessment of 300 candidate links (full profile + Deygout-3 per
  link): well under a second on the dev box in the normal flow; dominated by
  terrain tile fetches on first use (tiles are HTTP-cached).

## Parity (WebGPU vs CPU oracle, identical input)

Measured on the staging site (low detail, 16,384 cells):

| Metric | Value |
| --- | --- |
| WASM vs CPU: classification mismatches | **0 / 16,384** |
| WASM vs CPU: mean / max margin difference | **0.000 / 0.000 dB** (f64 both) |
| Mean absolute margin difference (GPU vs CPU) | **0.241 dB** |
| Classification mismatches | 15 / 16,384 (**0.092 %**) |
| Mismatch classes | all boundary cases (see below) |
| CPU unknown-terrain cells | 0 (deterministic across runs) |
| Window tile health (110 tiles) | 110 / 110 OK |

Documented tolerance (adjusted from the initial <= 0.3 dB proposal with this
measured evidence):

- typical numerical agreement: **mean |delta margin| <= 0.3 dB** (measured
  0.241);
- classification identical for >= 99.75 % of cells (measured 99.908 %);
- every residual mismatch must be boundary-class: a margin within 2 dB of a
  classification threshold (15 / 5 dB) or a single knife-edge inclusion step
  (|delta| <= 7 dB ~ one `knifeEdge(v~0)` = 6.03 dB) at grazing geometry.
  Both classes are inherent f32-vs-f64 sample-position sensitivity
  (~1 - 2 m on 6 - 10 km paths), not model differences - see
  `docs/rf/parity-fixtures.md` and `tools/parity/parity-boundary-analysis.json`.

## Methodology notes

- Both backends run the same geometry (`coverage/params.ts`), the same
  profile sampling (identical `n` => identical great-circle sample
  positions), the same diffraction model and constants.
- The WebGPU kernel implements its own `sin`/`cos`/`atan2` with Cody-Waite
  reduction + Taylor polynomials: SwiftShader's built-ins measured ~3e-5
  absolute error (non-normalised), which displaced sample points by >200 m and
  produced spurious parity failures. The in-shader implementations are
  accurate to ~2e-7 (~1 f32 ulp) and make the kernel deterministic across
  implementations (see `apps/web/src/compute/coverage/shader.wgsl`).
- The parity probe runs the CPU twice to prove determinism and compares
  unknown-cell sets; window tile health is checked separately.
- `warmPath` must sample at exactly the profile's spacing: a coarser sampling
  skipped tiles the path only corner-clipped, surfacing as spurious
  "unknown terrain" cells (42/16,384 before the fix, 0 after).

## Reproduce

See `tools/parity/README.md` (`wgpu-probe.py`, `ui-gpu-test.py`,
`run-page-probe.py` + probes). UI evidence:
`coverage-webgpu-ui-zoom.png` (forced WebGPU) and `coverage-wasm-ui.png`
(no-GPU path, WASM auto-selected) in the Stage 4 evidence bundle.
