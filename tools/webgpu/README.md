# Offline Stage 4 verification

Run from the repository root, on Node 22 or newer:

```sh
npm ci
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright"
npx playwright install chromium --only-shell
npm run test:webgpu
npm run benchmark:webgpu
```

`PARITY_CHROME=/absolute/path/to/chrome` uses an existing Chromium installation.
No staging URL, SSH tunnel, source database, snapshot, real terrain or credentials
are required. The Vite server binds to loopback port 5184, and Chromium is forced
to use software WebGPU so a machine without a GPU exercises WGSL. Normal app
auto-selection still prefers WASM for software adapters. Browser profiles and
socket files live in the ignored `.t/` directory; the short name avoids Linux's
108-byte Unix socket path limit in a deep worktree.

`npm run typecheck:webgpu` checks the harness, fixtures and Playwright tests.
`npm run fixtures:webgpu` intentionally regenerates the checked-in CPU oracle
renders and hashes; inspect the diff before accepting any model/palette change.
The lossless `.pam` images preserve raw RGBA, including transparent out-of-range
cells. `references.json` also records margin values in millidecibels. All inputs
and the fixed 512×512, north-up, zero-pitch display are defined in `fixtures.ts`.

The parity gate runs nine 32×32 output rasters over full-resolution synthetic
z12 DEM windows: flat, ridge, unequal hills, coast/sea level, missing terrain,
range cutoff, raised mast, high-latitude UK geometry and a low RF budget
that exercises likely/marginal/unlikely classes. It checks repeat CPU
hashes, exact CPU/WASM cell codes and RGBA hashes, and CPU reference margin
agreement within 0.01 dB across runtimes. GPU agreement retains the existing
Stage 4 policy: mean margin error ≤0.3 dB, at most 0.25% classification changes,
and each changed cell must satisfy a documented RF-boundary exception. Unknown
and out-of-range masks must agree exactly. Tolerances are never fitted to a
fresh output. Per-fixture JSON and viewable PNGs are written by Playwright.

UI tests use the real application and worker with intercepted synthetic terrain
and snapshot responses. They assert that the map receives the coverage image
layer, and that removing coverage removes the layer. It also verifies that hiding the
tab pauses work/removes the overlay and visibility resumes the current input. One test forces WGSL on a
desktop viewport; the other strips `navigator.gpu` from both the page and worker
and verifies automatic WASM on a 390×844 viewport. Synthetic fixture data stays
in the test process and is never served by the production bundle.

Benchmarks use 9, 36 and 110 input DEM tiles at 128², 256² and 512² output cells
respectively (10, 25 and 50 km squares). Each backend gets one warm-up and three
measured runs, performed serially. Times include kernel work and, for WebGPU,
upload, dispatch, per-band readback and cleanup; exclude local input generation,
network fetch and shader/module initialization. The report includes all samples,
medians, browser/adapter, limits, window size and output-band counts. This is a
bounded browser kernel benchmark, not a national coverage job or evidence for
hardware-GPU speed. Do not compare an old real-terrain measurement directly to
these synthetic measurements.

Artifacts are under `test-results/webgpu/` (benchmarks: `test-results/webgpu-benchmark/`); CI uploads them as `webgpu-parity`.
The benchmark is opt-in, separate from the default test suite. Do not run a
second suite against the same port, or edit app sources while UI tests run.
