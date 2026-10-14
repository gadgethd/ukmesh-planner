# Progress log — ukmesh-planner

Evidence-backed execution log. Newest entries at the bottom of each stage.
All timestamps Europe/London (BST = UTC+1 during this build).

## 2026-10-13 — Stage 0: discovery & baseline

**Go received.** Ben: "implement this plan" for
`~/.hermes/plans/2026-10-12_ukmesh-planner-full-build-plan.md`; §16 decision
record (repo created, DB provisioning approved, DNS/Cloudflare ours, absolute
no-agents restriction, continuous execution, measure-first resources).

- **Repo bootstrap.** `gadgethd/ukmesh-planner` cloned (empty, public, `main`);
  git identity `hermes-gadget`; plan committed as `docs/BUILD-PLAN.md`.
- **Workspace.** Work root `~/ukmesh-planner-work/` (evidence + STATE.md);
  GitHub clone of ukmesh at `~/ukmesh-src` (`e0a27db…`, 2026-10-12).
- **VPS recon 1** (evidence: `recon.out.txt`): 8 vCPU / 22 GiB / 193 GB disk
  77% used / no swap / load ≈ 9.8; 67 running containers; `meshcore-analytics_default`
  = 172.30.0.0/24 shared bridge; compose projects mapped.
- **VPS recon 2** (evidence: `recon2.out.txt`): cloudflared topology (token
  tunnels, HTTP2 forced); TimescaleDB access via `docker exec … psql -U meshcore`;
  port map (backend 127.0.0.1:3000, website :3004, app :3003); public health
  codes (ukmesh.com 200, app.ukmesh.com 200, healthcheck 302, flasher 200);
  terrain tiles at `~/ukmesh/meshcore-analytics/terrain-tiles` (2.7 GB, z0–12).
- **VPS-authority steer (Ben, mid-recon).** Use the VPS ukmesh tree where it is
  ahead of GitHub — confirmed divergent (VPS carries unpushed migrations
  055/057–060 that define the live DB). Read-only snapshot at
  `~/ukmesh-vps-snapshot/` (210 MB); per-file diff vs GitHub in
  `evidence/diff-github-vs-vps.txt`.
- **DB deep-dive** (evidence: `db-deepdive.out.txt`): PG 16.11 + TimescaleDB
  2.25.1 (no PostGIS); canonical views, privacy functions, trigger inventory,
  counts (17,252 identities / 165,015 links / 14,321 links in 30d / 126 private
  prefixes / visibility generation = 810).
- **Docs written:** source contract (draft), host inventory, decisions log,
  privacy threat model skeleton (this commit).
- **Licence note.** ukmesh repo = MIT; `third_party/hopreach` = AGPL-3.0 +
  Commons Clause (non-commercial). Decision: clean-room RF implementation, no
  HopReach code reuse (D-003).
- **Next:** Stage 1 — independent foundation scaffold (contracts, rf-core, web,
  api, ingest, CI, compose isolation, healthz/readyz).

## 2026-10-13 — Stage 1: independent foundation (in progress)

- Monorepo scaffolded (npm workspaces): `packages/contracts` (zod schemas +
  compute protocol + API DTOs), `packages/rf-core` (clean-room RF engine:
  geodesic helpers, terrarium DEM decode/sampling, curvature/Fresnel profiles,
  ITU knife-edge + Deygout diffraction, link budget assessment),
  `apps/api` (Fastify: /healthz, /readyz, /api/v1/config), `apps/web`
  (React + Vite shell reading the config endpoint), `apps/ingest` (config
  skeleton; explicitly performs no DB work yet).
- Dependencies installed (TypeScript 7.0.2, vitest 5.0.4, vite 8.3.4,
  fastify, zod, react 19). Package-lock committed.
- **Gates green:** `npm run typecheck` 5/5 workspaces exit 0 · `npm test`
  23/23 tests (rf-core 20, api 3) · `npm run build` (web) OK.
- CI workflow added (`.github/workflows/ci.yml`): install → typecheck → test →
  build on push/PR — **first run green** (actions run 38322465082).
- `.env.example` secret template added (no values).
- Container layer verified locally: api/ingest/web images build clean;
  full E2E on a scratch network — web serves the SPA + /healthz and proxies
  `/api/v1/config` to the api container (200 OK). `docker compose config`
  validates (own project, 127.0.0.1-bound port, resource caps; only `ingest`
  joins the source network per D-005).
- Planner datastore: `db/planner-migrations/0001_core.sql` + fixture applied on
  a scratch Postgres 16 — row counts verified; single-published-snapshot guard
  proven by negative test; re-apply idempotent.
- Source-export provisioning drafted (`db/source-export-provision/`): reader
  role (read-only txns, timeouts, connlimit 2), three privacy-filtered views,
  grants, rollback. Password flows via env only. Fixture-testing next.
- Nginx upstream resolution hardened (request-time DNS; survives api restarts).

## Stage 2 — Safe DB snapshots (in progress)

- Source-export provisioning drafted (`db/source-export-provision/`): dedicated
  `ukmesh_planner_reader` role (read-only transactions, statement/idle/lock
  timeouts, connection limit 2, no superuser/createdb/createrole/bypassrls),
  three privacy-filtered views (`public_repeaters_v1`,
  `public_observed_links_v1`, `visibility_fence_v1`), grants, rollback script.
- Conservative scan (`fixtures/source/`): synthetic source-shaped fixture +
  `test-export.sh` — **29/29 checks green**, including member-wide 🚫 exclusion
  via an alias-only private member, sighting-scoped membership, link filters on
  both endpoints, reader permission denials (raw tables, writes, DDL) and a
  full rollback proof.
- Key finding: functions called from a view execute as the *view user* —
  `meshcore_canonical_node_id()` inside an export view returned permission
  denied for the reader. Fixed by using set-based alias joins (migration 037's
  pattern) in both the export views and the fixture. CI now runs the suite.
- Next: read-only live pre-checks (object shapes, pre-state snapshot), then
  apply during a quiet window with the fixture-proven SQL.

- **Live provisioning applied 2026-10-13 00:04–00:16 UTC** (quiet window: load
  4.8, 2 active queries, gen 810): `ukmesh_planner_reader` role +
  `planner_export` schema/views created (rc=0 both). Post-checks: 0 waiting
  locks, generation unchanged, ukmesh.com 200, backend + timescaledb healthy.
- Reader verified over the exact ingest path (bridge DNS name, scram):
  repeaters=8,797 (8,798 minutes later as live data drifted), links=37,075,
  fence=810; write/DDL/raw-table probes all denied.
- Plan-safety experiments (why the view is the shape it is): join-form with
  nested loops enabled = 389s (double nested loop from CTE estimates
  collapsing to rows=1); an IN-form rewrite was also plan-unstable (stuck
  >8 min, terminated). Final: join-form + **role-level `enable_nestloop=off`**
  → links 513ms / repeaters 296ms / fence 5.6ms under pure defaults.
- Fixture suite extended (privacy union incl. prefix-registry source,
  force_viable, reader hash-join default): **32/32 green**.
- Rollback kept ready: `db/source-export-provision/99_rollback.sql`
  (drops only the three views + schema + role; touches no source data).

- **Ingester implemented + e2e green (2026-10-13).** `apps/ingest`: config /
  logger / source (REPEATABLE READ + fence, nestloop-off, bounded timeouts) /
  validate (fail-closed: structural checks, hard count bounds, relative guard
  vs previously published) / planner (single-txn build → supersede → promote,
  plus prune) / run (fence re-check with one re-fetch retry) / main (once-mode
  and jittered loop with backoff). Unit tests 15/15; the e2e
  (`fixtures/source/test-ingest.sh`) exercises publish, supersede and
  floor-rejection on scratch databases — 12/12 checks; wired into CI.
- Notable bug found & fixed by the e2e: `return promise` inside `try/finally`
  let the finally end the pg clients while the publish transaction was still in
  flight — the server logged an EOF abort and pg rejected the query with
  "Connection terminated" as an uncaught crash. Fixed with `return await` plus
  an explanatory comment; `main.ts` now also guards against uncaught
  rejections.

- **Stage 2c — staging stack LIVE on the VPS (2026-10-13 00:34–00:35 UTC).**
  `ukmesh-planner` compose project: db/api/web/ingest all healthy; web on
  127.0.0.1:3400 (public routing later via tunnel). First **live snapshot
  published**: `snap-20261013T003449Z-g810-7ba8` — 8,798 repeaters / 37,076
  links @ privacy generation 810; fetch ~1.7s (repeaters 0.7s / links 1.0s
  through the real ingest path), publish ~8.9s. API `/readyz` serves snapshot
  metadata; UK Mesh untouched (site 200, containers healthy). Footprints:
  ingest 66MB · api 77MB · web 13MB · db 91MB — well inside caps.
- Log hygiene: `redactUrl` now strips userinfo entirely; unit-tested.

- **Stage 3 step 1 — data endpoints live (2026-10-13 ~00:41 UTC).**
  `GET /api/v1/snapshot/meta`, `/api/v1/repeaters` (bbox + keyset cursor) and
  `/api/v1/observed-links` (either-endpoint bbox + composite cursor), plus
  in-process rate limiting on `/api/v1/*` (health probes exempt). API unit
  tests 12/12; deployed to staging and smoke-tested through the web→api chain
  with real data (Newcastle bbox: real repeaters, directional link evidence
  with force_viable, working pagination, 400 on invalid bbox, live
  `datasetVersion`).

- **Stage 3 step 2 — Simple-journey map UX (2026-10-13 ~01:00–02:40 UTC).**
  MapLibre map (OpenFreeMap basemap, Terrarium terrain + hillshade from the
  read-only tile mount), clustered repeater pins coloured by freshness,
  click/drag placement of a proposed site, browser-worker RF assessment
  (rf-core + terrain provider over `/terrain-tiles/`), result sheet with
  counts, top links, explanations, antenna-height control, undo/clear,
  light/dark themes. Web unit tests green (tilemath clamp regression included).
  Verified in a real browser against staging through a tunnel: 8,798 repeaters
  load; a Newcastle site assesses 300 of 631 in-range candidates in ~1–2 s
  warm; 42 likely / 258 blocked at 2 m, 86/214 at 30 m (physically sensible);
  undo restores the previous site exactly; theme switch re-installs overlays.
  Evidence: `evidence/stage3/` screenshots (light + dark, green solid / red
  dashed links).

- **Four real bugs found by that verification (all fixed):**
  1. MapLibre's tile worker was broken in the Vite build ("Worker failed to
     load") — the basemap never rendered. Fixed by importing
     `maplibre-gl-worker.mjs?url` and `setWorkerUrl()`; nginx now serves
     `.mjs` as `text/javascript` (stock mime.types only maps `.js`).
  2. Overlay install depended on the `load` event, which did not fire in
     testing even with a healthy style. Overlays are now installed
     idempotently on `styledata`/`load`/`idle` (the theme-switch path already
     used `styledata`).
  3. Terrain edge bug: profile samples in the outer 1-px band of a tile's
     right/bottom edge were rejected by `bilinearSample` (pixel-centre
     contract) and reported as "missing terrain" — 246/300 paths affected on
     the first E2E. Local tile coordinates are now clamped (≤ 1 px error) —
     see docs/rf/model-assumptions.md.
  4. API default bbox silently dropped ~30 % of the dataset (continental
     repeaters are legitimately present in the published snapshot). `bbox` is
     now opt-in; the full snapshot is served by default. Tile fetch failures
     are also retried once instead of being cached as permanently missing.

- **Stage 3 exit gate — SIMPLE-01…05 verified on desktop and mobile
  (2026-10-13 ~03:00–04:10 UTC).** All checks run against the staging stack
  in a real Chromium via CDP:
  - SIMPLE-01: load → click → site → lines + list, no account/modal. ✔
  - SIMPLE-02: six rapid clicks at different spots → final state equals the
    last click, no stale overwrite (debounce + job-id gating). ✔
  - SIMPLE-03: antenna height 2 m → 30 m reran and updated (42→86 likely at
    Newcastle); undo restored the previous site and its results exactly. ✔
  - SIMPLE-04: site in Great Langdale (deep valley) → 251 blocked / 0 clear;
    sheet states "Every path within range is blocked by terrain — try a
    higher antenna height or a nearby high point." (never "no nodes"/green). ✔
  - SIMPLE-05a: basemap unreachable (blocked OpenFreeMap) → app starts on a
    built-in minimal style; terrain hillshade, repeaters, links and the full
    assessment pipeline remain usable (screenshot evidence). ✔
  - SIMPLE-05b: DEM tiles missing (404 via a fixture server serving the real
    build) → all 300 paths report `unknown-terrain`, site elevation unknown,
    sheet: "Terrain data is unavailable along the paths within range — no
    honest prediction is possible here." No crash; map usable. ✔
  - Mobile (390×844): one-line top bar, controls clear of the header,
    bottom sheet with results and scroll, tap placement works. ✔
- **Two robustness changes from this gate:** (1) the app now constructs the
  map with a built-in minimal style and asynchronously *upgrades* to the
  remote basemap (fetch with 7 s timeout) — MapLibre v6's `setStyle()` is a
  silent no-op when the initial style fetch has failed, so a style-less map
  must never exist; (2) mobile CSS (nowrap title, compact bar, dataset line
  hidden < 520 px, map controls offset below the header).
- **Verification-environment note (not an app defect):** this headless
  Chromium throttles `requestAnimationFrame` until forced frames occur and
  its software rasterizer occasionally flushes partial frames into captures
  after heavy interaction (blank-map artifact in some post-interaction mobile
  screenshots). The renderer is healthy throughout (queryRenderedFeatures
  350–700+), canvas sizing is correct, and the same build renders fully when
  quiet and at desktop size. Real-device mobile verification stays on the
  Stage 7 checklist. Fixture: `evidence/stage3/missing-dem-server.py`.

- **Stage 4 — coverage tier + WebGPU path (2026-10-13 ~04:10–05:05 UTC).**
  Bounded 50×50 km coverage preview behind the Simple-mode sheet: shared
  geometry (`coverage/params.ts`), WGSL kernel (one invocation per cell,
  Deygout-3 mirroring the CPU oracle), CPU fallback bounded at 128×128 with a
  notice, backend auto-selection (hardware WebGPU only; software adapters
  fall back). UI: toggle + detail selector; raster overlay on the map.
- **Parity verification (the hard part).** Two real defects found by
  GPU-vs-CPU diffing on real terrain, both fixed:
  1. SwiftShader's runtime `sin`/`cos` are inaccurate (~3e-5, non-normalised —
     norm² 1.00007) while literal (const-folded) values are exact; every
     great-circle sample point was displaced by >200 m, wrecking terrain
     clearance on hilly paths (665/16,384 classification mismatches). The
     shader now implements `sin`/`cos`/`atan2` with Cody-Waite reduction +
     Taylor polynomials (~2e-7 ≈ 1 f32 ulp) — deterministic across GPU
     implementations (`probes/trig-accuracy.js`: pass).
  2. `warmPath` preloaded tiles at 400 m sampling while `buildProfile`
     samples at 90 m (60 m in Simple mode): tiles the path only corner-clipped
     were never loaded, and `elevationAt` returned null for their samples →
     42/16,384 spurious "unknown terrain" cells (deterministic, reproduced
     tile-by-tile). `warmPath` now samples at exactly the profile's spacing
     (callers pass their profile opts) → 0 unknowns.
  Also: Deygout obstacle tops in the shader now use the full-path earth bulge
  (mirrors the oracle's `earthBulgeAdjM`), and the WGSL NaN is a runtime
  uniform (const-eval rejects constant NaN).
- **Stage 4 parity result (low detail, 16,384 cells):** mean |Δmargin|
  0.241 dB; 15/16,384 (0.092 %) classification mismatches, all boundary-class
  (margin within 2 dB of the 15/5 dB thresholds, or one knifeEdge(v≈0) =
  6.03 dB grazing-inclusion step at |h| < 1 m — verified per-cell in
  `tools/parity/parity-boundary-analysis.json`); CPU runs deterministic;
  tile health 110/110. Documented tolerance in docs/performance/benchmarks.md
  (adjusted from the initial ≤0.3 dB proposal with this measured evidence).
- **Stage 4 performance (software WebGPU / SwiftShader):** GPU 1.5–1.9 s vs
  CPU 3.8–4.9 s at 128×128 (~2.5–3.3×); medium 256×256 = 65,536 cells in
  ~18–20 s in the UI. Hardware-GPU numbers deferred to Stage 7.
- **Stage 4 UI evidence:** coverage preview driven through the real UI with
  the WebGPU backend forced (`window.__plannerForceBackend`), 65,536 cells
  rendered as a raster overlay (red field + green river-valley patches) —
  `evidence/stage4/coverage-webgpu-ui-zoom.png`; CPU fallback UI earlier:
  `coverage-cpu-fallback.png`.
- **Tooling committed:** `tools/parity/` (worker-level parity probe with
  two-CPU determinism + tile-health checks, page-probe runner with
  trig/synthetic probes, UI test script, boundary fixture) and docs
  (`docs/performance/benchmarks.md`, `docs/rf/parity-fixtures.md`).

- **Stage 4b — WASM CPU core (2026-10-13 ~05:05–05:25 UTC).** Tier B now has
  its WASM backend per plan §6.2/§6.3: an AssemblyScript (f64) port of the
  coverage kernel (`apps/web/src/compute/wasm/coverage-core.ts`, built by
  `npm run build:wasm`, wired as prebuild/pretest), a loader/runner with no
  AS runtime dependency, and backend selection updated — hardware WebGPU →
  `webgpu`; no/software adapter → `wasm`; `cpu` remains the oracle and
  fallback-of-last-resort. Verified: node parity test (0 mismatches, margins
  < 0.01 dB over a ridge+nodata synthetic window); live four-way probe —
  **WASM vs CPU: 0/16,384 mismatches, 0.000 dB** (bit-exact on real data),
  WASM 2.3 s vs CPU 5.7 s vs SwiftShader GPU 1.9 s at 128×128; no-GPU UI path
  auto-selected WASM and rendered the heatmap at full medium detail
  (65,536 cells) — evidence `evidence/stage4/coverage-wasm-ui.png`.

- **Stage 5 step 1 — Advanced mode shell + precision profiles + RF editor
  (2026-10-13 ~05:30–05:45 UTC).** `Simple | Advanced` switch sharing one plan
  state (mode switch preserves site, RF edits and advanced selections —
  `plan/planState.ts` + MODES unit tests); the advanced sheet hosts the
  precision LOS cross-section (DTV terrain, terrain+4/3-Earth effective line,
  antenna chord, first Fresnel band, worst-obstruction marker, clearance
  stats, source/model notes) computed by the assess worker's new `profile`
  request; and the shared RF editor (UK presets 868 / 869.525 / low-power,
  editable budget fields, advisory EIRP, explicit per-repeater-preset
  assumption). RF edits re-run assessment + coverage + profile live.
  Verified in-browser: switch preserves state both ways; profile for
  site→Gateshead_StJames shows margin 46.8 dB, clearance 0.36 @ 0.4 km, 4 m
  worst obstruction; preset switch to 869.525 re-ran the assessment.
  Evidence: `evidence/stage5/adv-profile.png`.

- **Stage 5 step 2 — topology, site removal, candidate search, observed links
  (2026-10-13 ~05:35–05:55 UTC).** Advanced analysis now includes:
  (a) **observed links** loaded on demand (snapshot `/api/v1/observed-links`,
  bbox-bounded) and drawn as their own layer under the predicted links —
  reciprocal evidence solid, one-way reports dashed (legend updated);
  (b) **network topology** over all repeaters with observed + predicted edges
  (weak components, largest component, isolated counts; pure iterative-Tarjan
  module, 10k-node/40k-edge test) plus a **site-removal scenario** select
  (components before/after, split-off nodes, newly-isolated list);
  (c) **candidate-site search**: bounded worker job — high-ground screening
  over the 50×50 km box (quantile + local-prominence scoring), fine evaluation
  of the top 32 candidates against their nearest repeaters, deterministic
  ranking with explainable factors for goals reach/resilience/balanced
  (`advanced/candidates.ts` + hand-checked fixture, 13 tests). One candidate
  can be applied directly as the proposed site. Verified in-browser: 12,776
  observed links drawn; topology 8,800 nodes / 12,776 observed / 75 predicted
  edges, 6,930 components (mostly isolated repeaters — expected), largest
  1,862; candidate #1 (420 m ASL ridge west of Newcastle) reaches 39 repeaters
  at ~40 dB avg top margins; applying it raised likely links 75 → 153.
  Evidence: `evidence/stage5/adv-candidates.png`.
- **Stage 5 scope note:** plan §5.2 items beyond the stage exit gate (bridge
  route planner, height optimiser, feasibility/power checklists, field
  surveys, scenario history, viewshed-vs-existing delta) remain deferred and
  are tracked for Stage 6/7 polish; the exit gate itself (MODES/ADV tests,
  RF suite, deterministic candidate fixtures with explainable rank) is met.

## 2026-10-13 — Stage 7: production staging, rollout and verification

- **Released `bb85db4`** (previous release `66b1182` kept as the tagged
  rollback target). Images tagged per-SHA on the host; compose project
  `ukmesh-planner` unchanged in shape (own network/volume, 127.0.0.1:3400).
- **Staged public URL live: `https://ukmesh-planner.justarobot.uk`** — own
  cloudflared tunnel (`cf-tunnel-ukmesh-planner`, http2, token-managed via
  the CF API), DNS CNAME created in `justarobot.uk`; verified 200 + full
  browser E2E (assess 75/225, coverage auto-selected **wasm**, advanced
  topology) through the public edge. Evidence `evidence/stage7/`.
- **`planner.ukmesh.com` publish BLOCKED (recorded):** the host CF token is
  scoped to `justarobot.uk` only; ukmesh.com's tunnel is dashboard-managed.
  Exact remedies in `docs/deployment-report.md` → Blockers.
- **Pre/post UK Mesh health:** ukmesh.com / app / healthcheck / flasher all
  match the Stage-0 baseline (200/200/302/200); resources within variance.
- **Rollback executed and verified:** deploy `66b1182` → config reverts to
  two tiers → roll forward `bb85db4` → three tiers; public healthz ok.
- **Backup/restore verified:** pg_dump 15.3 MB → scratch restore → counts
  identical (6 / 52,794 / 222,601 / 3) → scratch dropped; dump retained at
  `/home/ben/backups/ukmesh-planner/`.
- **Incident + fix:** an `rsync --delete` wiped the host deploy `.env` during
  the rollback test (running stack unaffected); reconstructed from container
  env, 0600, validated; runbook updated to ban `--delete`.
- **Docs:** `docs/deployment-report.md`, `docs/operations/deploy-runbook.md`.
- **CI:** green on every push (latest run 38350492669).

## 2026-10-13 — Neighbour dB ratings: MeshCore-convention ITM + calibration

Ben's steer: "the db ratings should be in how meshcore measures neighbours
with proper simulation". Investigation found the live analytics system's own
neighbour model (viewshed-worker rf/): ITM-style path loss (FSPL + knife-edge
diffraction from the max Fresnel v, 4/3-earth bulge, p75 terrain roughness),
viability = v <= 1.12 AND loss < calibrated threshold, thresholds calibrated
from real packet-SNR-weighted quantiles of observed links.

Delivered:
- **rf-core/itm.ts** — bit-for-bit port of the live scalar model (68 golden
  tests vs the original Python: max |TS-Python| = 0.0 across 804 values;
  reproducible generator at tools/parity/gen-itm-golden.py).
- **rf-core/calibration.ts** — exact mirror of the live weighted-quantile
  calibration (step-function quantiles, q35/q65/q90+0.5, clamps, min 24).
  Documented deviation: neutral SNR weight until median SNR is exposed in the
  export view.
- **API** — GET /api/v1/calibration (per-snapshot, cached). Live now:
  samples=37,274, usable=139.5 dB, green=130 (data-driven).
- **Worker/UI** — every predicted link now carries ITM path loss + viability
  + band; result rows show the ITM dB figure with a viable/not-viable chip;
  3D link colours follow the live bands; default view = viable links only
  (non-viable appear via "Show blocked links"). Observed links gained a click
  popup with the live system's recorded path loss + viability.
- Verified live: rows read e.g. "0.2 km · 87 dB · viable · likely" (FSPL at
  200 m ≈ 77 dB + roughness/diffraction — consistent); 7 viable of 300
  candidates at the Newcastle test point (stricter and more realistic than
  the previous margin model, as Ben asked).

## 2026-10-13 (night) — map-invisible incident: two root causes found and fixed

Ben: "its broken... I cant see the map at all". Reproduced in a fresh browser
load (UI chrome fine, map canvas white — the earlier "blank frames" blamed on
renderer flakiness were THIS bug).

**Cause 1 (layout):** the 3D-links commit added `.app { position: relative; }`
to anchor the 3D button, overriding `.app { position: fixed; inset: 0 }`. The
app shell collapsed to height 0; the map canvas fell back to 300 px at the top
of the page. Fix: remove the override (the fixed shell is already a containing
block) + explicit button placement (below topbar; left of the sheet column).

**Cause 2 (rendering):** Link3DLayer.render() projected through
`options.modelViewProjectionMatrix` — under MapLibre v6 that matrix does not
accept mercator [0..1] input; the layer drew nothing (isolated raw-GL probes:
clip-space triangle ✓, mvp triangle ✗, `defaultProjectionData.mainMatrix`
triangle ✓). Fix: project through `defaultProjectionData.mainMatrix` with the
`tileMercatorCoords` conversion; also `frustumCulled = false` for fat-line
geometry. Custom-layer contract verified empirically end-to-end.

Live verification after fixes: map renders (tiles), ITM rows + viable chips
populate, 7-9 viable links draw and A/B-diff (121 px), tilt applies
(230k px frame change, pitch 55), calibration served (139.5/130, 37,284
samples). Commit 24c012e.

## 2026-10-13 (night 2) — neighbour display matched to the live MeshCore app

Ben's feedback: "not viable links needs to not be shown at all, also its still
not like the meshcore app with the db's, also the ui with likely blocked is a
fucking mess".

Studied the live app source (meshcore-analytics frontend) — the neighbours
map's conventions, now mirrored exactly:
- **mapConfig.ts**: green <= 121.5 dB, amber <= 129.5 dB; nothing worse is
  ever drawn (the map's own `itm_viable = path_loss <= 129.5`).
- **geojsonBuilders.ts**: line widths 3 / 2.1 px; palette #22c55e / #fbbf24.
- **PlannedRepeaterPopup.tsx**: rows "● Name · 9.5 km · 111 dB", dot coloured
  by band; empty state "No viable links to nearby repeaters".
- Planned links list = viable only, ordered best (lowest loss) first.

Planner changes (all live):
- Map: only green/amber links (<= 129.5 dB) ever render; red/non-viable are
  gone entirely — no toggle.
- Results sheet: likely/blocked chips, viability chips, the blocked toggle
  and the counts summary are all removed; rows are the live-app format;
  panel title "Predicted links (N)"; better empty states.
- Link3DLayer: live palette + per-band line widths (3 / 2.1).
- Identity aliases (the same node under several keys, common in the source
  data with corrupted name bytes) are merged for the link list — same name
  within ~110 m, then exact-position duplicates; cleanest name kept. Link
  list at the Crathorne test point: 53 -> 39 rows, no more 10x TS17 repeats.
- Corrupted name bytes (U+FFFD) stripped from display names.
- rf-core: MAP_LINK_GREEN/AMBER_THRESHOLD_DB + mapLinkBand() (live map
  semantics), tested.

## 2026-10-13 (night 3) — links visible in ALL views

Two more rendering truths found while verifying after the neighbours-map
redesign:
1. Custom layers draw during the render pass but never mark the map dirty —
   with MapLibre's render-on-demand frames, freshly computed link geometry
   stayed off-screen until the next pan/zoom. `setLinks3D` now calls
   `triggerRepaint()`.
2. Depth-testing buried knife-edge-viable links inside the ridges their
   straight line crosses (the model can be right *because* of diffraction over
   the obstruction; the buried line read as "missing"). Links now render with
   depthTest/depthWrite off — always-visible floating 3D objects; terrain
   profile detail stays in the Advanced profile view.

Verified: flat view A/B 20,676 changed px (was 0), tilted 16k; the 39-link
list fans out green/amber to the repeaters.
## 2026-10-13 (night 4) — terrain-clearing links, 14-day activity filter, cache fix

Ben: "your lines are literally going into the hill" + "it should only use
nodes active in the last 14d ... I see a bunch of repeaters there that dont
exist anymore".

- **Links never enter terrain (structural):** the worker now emits a drawn
  path per link — the straight sight ray where it clears, lifted to
  terrain + 12 m wherever the ray would clip a hill (<=24 points, from the
  same ITM profile). The 3D layer draws these polylines (depth test off), so
  the line visibly rides UP OVER ridges and can never be inside a hill.
  Verified in the tilted view: "lines ride up over the high ground and stay
  visibly above the terrain surface".
- **14-day activity filter:** only repeaters seen on the network in the last
  14 days are loaded (map markers, candidates, everything downstream).
  Live: 8,821 -> 2,739 repeaters; Crathorne candidates 981 -> 252. Topbar
  and legend updated ("2,739 repeaters active in 14 d"; legend now two
  freshness classes + the viable/marginal bands).
- **Stale-bundle fix:** index.html served with Cache-Control: no-cache (the
  old shell was being cached by browsers, hiding deploys — a likely reason
  Ben saw the pre-fix behaviour after the fix shipped).

## 2026-10-14 (early) — links finally read as 3D arcs in the air

Ben: "the lines still arent 3d in the air". Root cause chain (all verified
by pixel measurements, not screenshots-by-eye):

1. The pitch projection DOES displace altitude, but weakly: pixel-measured
   ~25 px per 1500 m at z10/pitch 60 (the earlier "altitude does nothing"
   read came from a pitch-0 matrix dump — at pitch 0 the z->y term is
   zero, as it must be).
2. At true scale every honest altitude (2 m antenna, 20 m clearance, 500 m
   arc) is therefore visually flat at these zooms.
3. The fix: the arc is a VISUAL device (same spirit as terrain
   exaggeration) — arc component x6 (DRAWN_ARC_VISUAL_MULT), endpoints stay
   exactly at the antennas, terrain-clearing floor unchanged. Pixel-traced
   the drawn line profile: y 473 -> 190 -> 291 across the fan = a 280 px
   bow. Visible, verified.
4. Also fixed en route: `getProjectionData({tileID: ...})` throws with a
   null/absent tile ID and DISABLES the layer (render failed -> fail());
   `modelViewProjectionMatrix` renders nothing with mercator input; the
   working matrix is `defaultProjectionData.mainMatrix` (with the pitch
   z->y term). tmc stays [0,0,1,1] at pitch.

Note: at pitch 0 (flat) no projection can show height — the 3D button tilt
is where the arcs read. Ben's flat-view screenshots can never show this.
