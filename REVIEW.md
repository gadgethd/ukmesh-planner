# Stage 4 WebGPU review

Branch: `burn/webgpu-stage4-20261022`

Implementation: `5977b9b45be067894b1eb37b8d56a8ff6c4f9497`

PR: https://github.com/gadgethd/ukmesh-planner/pull/3

The starting checkout already contained a WGSL engine and historical staging
measurements. This change completes the missing bounds, lifecycle and repeatable
verification around that engine. The checkout initially included the unrelated
RF-ranking experiment from PR #2; only this Stage 4 commit was transplanted onto
`main` (`ece6bd8`). The experiment branch and its commits were left intact.

## What landed against Stage 4

| Requirement | Delivered |
| --- | --- |
| Browser-portable tiled WGSL | One DEM storage binding, two output storage bindings and one uniform binding. Output/readback buffers hold at most 8,192 cells / 32 KiB each; row bands honor device limits. DEM is capped at 96 MiB and output at 512². Partial final bands are guarded in WGSL. |
| Dispatch, memory and device lifecycle | Validate dimensions, binding/buffer/workgroup limits before allocation. Reuse an idle worker, selected device and pipeline; release every temporary GPU buffer on success or failure. WASM scratch arrays reuse geometric capacity instead of leaking under the stub runtime. |
| Selection and fallback | Hardware/otherwise unrecognized adapters use WebGPU; recognized software adapters and missing/failed API/adapter/device requests choose WASM. GPU compile, validation, allocation, limit or device-loss failure retries the same frozen DEM/site/RF/geometry on WASM and disables repeated attempts on that broken device. |
| CPU ceiling and cancellation | WASM preserves requested detail. A failed WASM asset/core falls back to JS CPU, normally capped at 128² with a visible notice. Superseding work, clearing coverage and hiding the tab terminate the worker; visibility resumes the current input. All RF work remains in the browser. |
| Render contract and parity | Preserve geometry, cell codes, RGBA palette and transferred raster buffers. Add model/terrain result revisions. Nine fixed terrain/RF fixtures include every cell-code/color class, reference PAM renders, SHA-256 hashes and numerical references. |
| Rendering races | Generation checks prevent delayed style retries from resurrecting a removed overlay or overwriting a newer raster. Late errors from retired workers cannot reject a new job. |
| Benchmarks and regression coverage | Three representative DEM/output sizes with raw samples, parity checks and documented medians; five offline browser tests and 221 unit tests. CI runs the browser gate and uploads its artifacts. |

## Parity evidence

Reference inputs/renders: [`fixtures/webgpu`](fixtures/webgpu/). Details:
[`docs/rf/parity-fixtures.md`](docs/rf/parity-fixtures.md). Committed measured
hashes, boundary cells, fallback results, UI state and engine/renderer source
hashes: [`webgpu-parity-2026-10-22.json`](docs/performance/webgpu-parity-2026-10-22.json).
The recorded source hashes were checked after transplanting the commit to `main`.

- Nine 32² fixtures: flat, ridge, hills, coast, missing DEM, range cutoff,
  raised mast, high latitude and low RF budget. CPU codes/RGBA match the golden
  hashes; repeated CPU output is deterministic. WASM codes/RGBA match CPU exactly.
- GPU: three boundary classification changes across 9,216 fixture cells;
  unknown/range masks match exactly. Worst fixture mean margin error is
  0.063526 dB. WASM/Chromium CPU maximum difference is 0.006208 dB.
- The existing GPU gate remains mean absolute margin error ≤0.3 dB, class
  changes ≤0.25%, and only documented boundary exceptions; unknown/range
  mismatches fail. CPU reference margins allow 0.01 dB across Node/Chromium.
- Benchmark rasters also pass parity at 128², 256² and 512². Isolated GPU margin
  differences reach 12.162 dB; 0.3 dB is a mean limit, not a per-cell guarantee.
  Maxima and all class changes are recorded in the raw benchmark report.
- Real Chromium tests inject invalid WGSL and destroy a real GPU device, then
  verify same-input WASM output and no repeated GPU request. Desktop forces
  WebGPU; a 390×844 viewport removes the API in both page and worker and
  auto-selects WASM. Both test pause/resume and overlay removal.

## Benchmark proof

Headless Chromium 153 / Google SwiftShader, Linux x86_64, AMD Ryzen 7 5825U
shared development VM, 10 logical CPUs and 16 GiB RAM. One warm-up plus three
measured runs per backend/case; medians below. Host load was not controlled.

| DEM tiles / square | Output cells | GPU bands | CPU | WASM | WebGPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| 9 / 10 km | 128² | 2 | 378.8 ms | 240.8 ms | 106.3 ms |
| 36 / 25 km | 256² | 8 | 4,970.1 ms | 5,945.9 ms | 1,541.1 ms |
| 110 / 50 km | 512² | 32 | 40,935.2 ms | 25,327.9 ms | 11,456.2 ms |

Includes GPU upload, dispatch, readback and cleanup, or CPU/WASM kernel work.
Excludes terrain fetch, input generation and shader/module initialization.
These measurements do not establish hardware-GPU or real-mobile performance.
Raw samples/limits/parity: [`webgpu-2026-10-22.json`](docs/performance/webgpu-2026-10-22.json).
Methodology and historical measurements: [`benchmarks.md`](docs/performance/benchmarks.md).

## Exact verification commands and results

Run from the repository root:

```sh
npm run typecheck
npm run typecheck:webgpu
npm test
npm run build
PARITY_CHROME=/home/ben/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run test:webgpu
PARITY_CHROME=/home/ben/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run benchmark:webgpu
git diff --check
```

Results: both typechecks pass; **221 unit tests pass** (RF 70, API 26,
ingest 16, web 109); production builds pass; **5 browser tests pass** with no
skips/flakes, including nine fixtures; **1 benchmark test / 3 sizes passes**.
Build reports the existing large-chunk advisory. The web unit command now uses
two workers and a 60-second correctness deadline for CPU-heavy fixtures.

Reproduction/setup: [`tools/webgpu/README.md`](tools/webgpu/README.md).
Local PNG/JSON artifacts are under `test-results/webgpu/` and benchmark artifacts
under `test-results/webgpu-benchmark/`. The committed JSON summaries preserve the
measured evidence. Current CI results are available on the
[PR checks page](https://github.com/gadgethd/ukmesh-planner/pull/3/checks).
SQL export/ingest fixtures run in CI's isolated scratch databases; no local live
database or service was used for verification.

**PROOF:** 221 unit tests + 5 browser tests + typechecks/build pass; benchmark
table and raw samples above; implementation commit
`5977b9b45be067894b1eb37b8d56a8ff6c4f9497`.
This review is committed separately after the implementation; the PR head is the
final handoff SHA.

## Deliberately left out, open questions and Stage 5

No deploy, live-service/config/database changes, hardware actions, main push,
merge, force-push, MissionDeck session or delegated agent was used. Implementation
and review happened in the owning session with ordinary compiler/test/Git tools.

Physical GPU drivers, Safari/Firefox and actual Android/iOS devices remain
unmeasured; software WebGPU and a mobile-size Chromium viewport are the available
evidence. Surveyed real-world terrain paths and a strict per-cell numerical
margin policy need separate validation. The hardware-only/software-fallback
selection policy is retained for portability even where forced SwiftShader is
faster in these measurements.

Stage 5 Advanced tools and the candidate engine already exist in this baseline
and are unchanged. This PR does not claim their full MODES/ADV acceptance gate;
any future candidate GPU integration needs its own parity fixtures and bounded
job policy. No additional Stage 5 feature work is included here.

## Honest mistake inventory

- Initially compared CPU margin hashes across runtimes as bit-exact; measured
  a 0.006208 dB difference and kept exact image/class hashes with a stated
  0.01 dB numerical reference tolerance.
- Early UI runs were disrupted by Vite reloads, and a long temporary path hit
  Chromium's Unix-socket limit. Test mode disables HMR and uses worktree `.t/`.
- The first no-GPU worker wrapper lost startup messages and broke relative
  fetch URLs. It now buffers messages and preserves the original HTTP base;
  tests require actual WASM selection and zero missing terrain on the flat DEM.
- Parallel CPU-heavy tests exceeded the old five-second deadline on the shared
  host. Web tests now bound concurrency and use a 60-second deadline; numerical
  parity retains the original mean/classification gate.
