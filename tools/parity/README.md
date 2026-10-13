# Parity + performance tooling

Scripts used to verify the WebGPU coverage kernel against the CPU oracle (the
shared TypeScript core) and to measure performance. See
`docs/rf/parity-fixtures.md` for the results and the boundary-exception
taxonomy, and `docs/performance/benchmarks.md` for timings.

## Prerequisites

- The deployed app reachable at `http://127.0.0.1:13400/` (e.g. via
  `ssh -f -N -L 13400:127.0.0.1:3400 <vps>` to the staging host). Probes fetch
  terrain tiles and the built worker relative to the page origin.
- A Chromium build with WebGPU enabled (SwiftShader is enough). Set
  `PARITY_CHROME` to its path; default is the dev box's known-good build.
- Python 3 with `websockets` (and `Pillow` + `numpy` only for the ad-hoc
  boundary analysis in `parity-boundary-analysis.json`).

## Scripts

- `run-page-probe.py` — runs a page-level probe JS in a WebGPU Chromium and
  prints its JSON result. Probes may reference `__WGSL__`, which the runner
  replaces with the JSON-quoted contents of `--wgsl`.
  - `probes/trig-accuracy.js` — checks the shader's precision-safe
    transcendentals against f64 `Math` (expect `pass: true`, errors ~2e-7).
  - `probes/synthetic-flat-raster.js` — full kernel over a synthetic flat DEM;
    compare against `synthetic-flat-expected.json`.
- `wgpu-probe.py` — the worker-level parity probe: runs the deployed
  coverage worker once on WebGPU and twice on the CPU over the same input and
  reports timing, unknown-set stability, tile health and parity statistics.
  Prints `{"verdict": "pass"}` when the documented tolerance is met.
- `ui-gpu-test.py` — drives the real UI in the WebGPU Chromium: places a site,
  enables the coverage preview with the backend forced to WebGPU, zooms in and
  screenshots the rendered heatmap (evidence for the Stage 4 UI gate).

## Notes

- The WebGPU Chromium is launched with `--enable-unsafe-webgpu
  --use-webgpu-adapter=swiftshader`; software adapters are normally NOT used
  for WebGPU in the app (`select.ts` gates them), the probe forces them to get
  GPU-path coverage in a GPU-less environment.
- SwiftShader's own `sin`/`cos` are inaccurate (~3e-5, non-normalised); the
  shader therefore carries its own transcendental implementations. Do not
  replace them with built-ins "for cleanliness" — parity depends on it.
