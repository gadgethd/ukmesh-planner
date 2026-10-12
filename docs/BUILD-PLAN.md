# UK Mesh Planner — Complete Autonomous Build & Deployment Brief

**Project:** `ukmesh-planner`  
**Repository:** `gadgethd/ukmesh-planner` — created 2026-10-13 (public; default branch `main`)  
**Intended public domain:** `planner.ukmesh.com`  
**Related existing repository:** `gadgethd/ukmesh`  
**Status:** Implementation instructions, not a claim that anything below has been deployed. **Decisions recorded 2026-10-13 (see §16); execution not started — awaiting Ben's go.**  
**Prepared:** 2026-10-12  
**Source inspection baseline:** `gadgethd/ukmesh` `main` at `e0a27dbebed4545b4568c6552e77849e08b27091` (verify the live HEAD before writing code)

> **PRIMARY DIRECTIVE TO THE IMPLEMENTING AI:** Execute this project **end to end yourself**. Investigate the host and repos, design, implement, test, deploy, validate and document the finished system. **Do not use MissionDeck agents for any part of this task. Do not spawn, assign, invoke, or delegate work to MissionDeck, subagents, coding agents, review agents, Codex agents, OpenCode agents, or other autonomous assistants.** Do the programming, code review, debugging, testing and deployment in your own session using ordinary shell, editor, browser, GitHub and test tools. Do not ask for routine decisions that can be settled through inspection, tests, established UK Mesh practices or this specification. Do not falsely report a pass, deployment or feature as complete. Where permissions or infrastructure genuinely prevent a step, finish all nonblocked work, document the exact blocker and evidence, and do not silently substitute a stub.

---

## 0. Executive objective

Deliver a **fully separate**, production-quality UK Mesh repeater-planning application, built and deployed on the **same VPS/machine** as the current UK Mesh services, but with its **own Git repository, runtime services, state, migrations, CI, monitoring, deployment/rollback path and domain**.

The system must display **all publicly displayable, geographically positioned repeaters** in its selected coverage area, with staleness/online distinctions. It must enable someone to place a hypothetical repeater, immediately see **predicted links** to existing nodes, see line-of-sight and a basic coverage preview, and compare that deployment to the existing network. It must support more capable RF/GIS and network-optimisation features without overwhelming first-time visitors.

**Non-negotiable UX requirement:** Two modes using **the same plan and underlying map**:

- **Simple (default):** Open map -> click/tap to drop a repeater -> see its predicted links to existing repeaters and an understandable viability explanation. Minimal controls, no account, no forms, no required tutorial.
- **Advanced (opt-in):** Everything in Simple plus detailed terrain, Fresnel/LOS, RF assumptions, graph resilience, site recommendations, hardware/power/site feasibility, compare scenarios, rich exports, field survey and diagnostics. Toggling modes must never discard or mutate the plan.

**Compute requirement:** The current UK-wide HopReach calculation reportedly took about **16 hours of VPS CPU time**. **Do not repeat national full-coverage calculations during normal planner operation** and do not require a GPU in the VPS. Use **client-side WebGPU compute where supported**; otherwise **WebAssembly CPU** in Workers. Use bounded regional jobs and caches; the VPS serves map/terrain data, snapshots, saved plans and small indexed queries rather than doing unbounded raster maths. Keep interactive features useful even without WebGPU.

**Data integration requirement (updated):** As everything runs on the **same machine**, integrate **directly with the existing UK Mesh PostgreSQL/TimescaleDB**, not by building a new public data API or scraping the live map. **Use a dedicated read-only source database role with access only to safe, explicitly reviewed read views**. Never grant the planner write access to the existing UK Mesh operational database or reuse its admin/application credentials. Keep *planner-owned writable state* in a separate planner datastore.

**Delivery standard:** A genuinely running, independently deployable project with smoke-tested HTTPS URL, working Simple and Advanced journeys, meaningful automatic tests, documentation, rollback, performance metrics and proof of privacy. No dummy data on the live site, no mocked success screens, no untested “done”.

---

## 1. Hard execution rules for the AI

1. **NO MISSIONDECK, NO AGENT DELEGATION — ABSOLUTE.** Do all tasks personally in the active AI session. Do not invoke MissionDeck tasks/workers even for research, architecture, code review, testing or expediency. Do not create hidden subagent jobs. Ordinary compilers, unit tests, linters, scripts, SQL clients and browsers **are permitted tools, not agents**.
2. **Own the entire delivery.** Do not stop at scaffolding, “MVP plan” or PR creation. Implement as much of the specified product as can actually be verified, iterate on failing tests, deploy behind the independent site, verify, then deliver an exact report. Never invent credentials or assert infrastructure was changed when it was not.
3. **No regression to UK Mesh.** Keep the current site, live map, MQTT, database, owner portal and HopReach operational. Do not rewrite their data or broaden public exposure. No `docker compose down -v`, `docker volume prune`, destructive DB resets or forced migration of existing data.
4. **No privileged shortcuts.** Production DB reader remains SELECT-only on vetted export views, including when the reader is compromised. Secrets stay out of Git, client bundles and CI logs. Do not expose PostgreSQL to the internet.
5. **Treat the radio/geospatial predictions as models, not truth.** Clearly label predicted vs observed links, assumptions, radio-preset compatibility and uncertainty. Never claim a single observed hop implies strong two-way RF connectivity.
6. **Do not copy licensed competitor code blindly.** Inspect licence obligations before reusing HopReach (AGPL-3.0 + Commons Clause), MeshBench (GPL-3.0-or-later), Mesh Community Planner (CC BY-NC-SA) or data/tiles. The new project may reuse appropriately licensed software **only with required notices/source terms**; when incompatible, implement its own math/shaders against documented equations and parity fixtures. Review the current vendored licences in the actual tree.
7. **Use isolated staged releases and rollbacks.** No direct `main` deployment of unvalidated builds; no reconfiguration of shared production services just to make a local test pass.
8. **Be resource-conscious.** Measure actual VPS CPU, RAM, disk and existing Docker load before setting resource budgets. Don't run an expensive national compute or DB backfill “to see what happens”. Use bounded queries and read-only snapshots.
9. **No unnecessary approvals.** You are authorised to implement this requested independent application. Make sensible technical decisions and record them. If a necessary external action is genuinely blocked (DNS control, production credentials, permissions), report that precisely and finish everything else; don't ask repeatedly.
10. **Give concrete evidence.** Provide commits, test summaries, build IDs, HTTP checks, browser screenshots (redacted), timings, measured resource ceilings and outstanding limitations. No fabricated benchmark or claimed browser support.

---

## 2. Reconnaissance: inspect first, do not guess

Before code changes:

- Confirm the intended GitHub owner and remote: `gadgethd/ukmesh-planner`. **This repo was not visible through the research connection at drafting time (GitHub returned 404)**. Check through the actual agent's GitHub credentials and local remotes. If absent and permission exists, create this *new* repository; if inaccessible, create a local git project and record the permission blocker. Do **not** accidentally put the planner inside `gadgethd/ukmesh`.
- Read current `gadgethd/ukmesh` HEAD, Docker Compose effective config, active deployment manifests, health/status endpoints, existing terrain mount/volume and network topology. The baseline SHA above is a research reference, **not** authority over later changes.
- Important production deployment detail: `docker-compose.live.yml` describes the external `meshcore-analytics_default` network with existing static proxy addresses; `docker-compose.infra-client.yml` moves stateful services into a separate `meshcore-infra` project. **Find the live DB container, its real network, credentials provisioning and data source before connecting.** Don't launch a second “timescaledb” accidentally or alter the production `172.30.0.0/24` address allocation.
- Inspect VPS resources: `lscpu`, `/proc/meminfo`, `free -h`, `df -h`, `docker ps`, `docker stats --no-stream`, `docker network ls/inspect`, Compose versions, container health and recent error logs. Record in `docs/operations/host-inventory.md` **without secrets**.
- Verify domain/DNS/tunnel/reverse-proxy access and current TLS/Cloudflare configuration. Use the existing supported edge pattern **without stealing the existing app hostname or rewriting existing routes**. If tunnel credentials are unavailable, stage a secure internal URL and record only that final DNS publish is blocked.
- Inspect all relevant source paths enumerated below; refresh signatures and schema definitions against current HEAD. Record `docs/integration/source-contract.md` with source revision/date.
- Inventory licence notices for terrain, map tiles and RF code, plus high-resolution DEM download rules and attribution.
- Establish initial health baseline for existing UK Mesh; run the same health checks after every deployment stage.

**Research-confirmed UK Mesh paths to inspect:**

| Live project component | Path | Why it matters |
|---|---|---|
| Canonical repeater identities | `backend/src/db/migrations/036_node_identity_merge.sql`, `037_node_identity_view_perf.sql`, `backend/src/db/nodeIdentity.ts` | Stable IDs, aliases, duplicate merging, correct role and location |
| Canonical nodes | `node_identity_nodes` SQL view | Source positions/role/last seen; examine provenance and membership |
| Network membership | `node_identity_sightings` SQL view | Must include UK-relevant nodes despite representative row `network` |
| Observed links | `node_identity_links` view; `node_links` base table | Historical links and directional counts, filtering and performance |
| Public privacy rules | `backend/src/api/utils/privateNode.ts`, `backend/src/nodes/publicMap.ts`, `docs/privacy.md`, `public_visibility_state` | Never leak private/opted-out nodes or inferred exact coordinates |
| Recent topology implementation | `backend/src/repositories/networkAnalysis.ts`, `backend/src/api/routes/topology.ts` | Existing graph modelling; public `/api/topology` is **bounded**, not a national bulk source |
| Read-only HopReach data compatibility | `backend/src/api/hopreachCompatibility.ts` | Shows UK scope rules and observed link shapes; **internal-only**, don't expose it |
| Terrain data | `frontend/src/components/Map/mapConfig.ts`, `nginx.app.conf`, `nginx.website.conf` | Existing `/terrain-tiles/{z}/{x}/{y}.png`; Terrarium, tileSize=256, maxzoom=12 |
| Terrain/source architecture | `docs/architecture.md`, `docs/rf-coverage-rollout.md` | Separation of backend/HopReach, cache and publication |
| HopReach CPU/WASM preview | `third_party/hopreach/public/planner-worker.js`, `public/terrain.js`, `public/wasm-bridge.js`, `wasm/main.go` | Browser Worker approach, 35 km preview limit, existing physics fixture baseline |
| HopReach native WebGPU | `third_party/hopreach/internal/gpucompute/gpucompute.go` | WGSL algorithm and native dispatch; **not yet browser-portable as-is** |
| Existing RF assumptions | `rf-coverage/config.ukmesh.yaml` | Generic 868 MHz / TX / gain / sensitivity defaults are **assumptions**, not automatically actual radio settings |
| Public APIs (for reference only) | `backend/src/api/routes/nodes.ts`, `exports.ts`, `topology.ts` | Cross-check semantics; **don't use a public API as primary source on same host** |
| Legacy planned API | `backend/src/api/routes/plannedCoverage.ts` | Returns **410 Gone**; do not depend on or revive it |

**Don't make these source mistakes:** Existing public node map API `GET /api/nodes/map` is paginated and has freshness restrictions, so it isn't guaranteed to list all historical public repeaters. `/api/topology` has a limit parameter capped at 500 (bounded topology rows), and is not a complete nation-wide graph API. Existing HopReach `/hopreach` compatibility routes are purposely internal, and `/coverage/planned` is retired. Database read views are the primary integration.

---

## 3. Architecture and component boundaries

```text
                      SAME VPS / HOST

    Existing UK Mesh / TimescaleDB (source of truth)
       ├── canonical nodes, sighting/network membership
       ├── observed links and radio evidence
       ├── public visibility/opt-out generation
       └── [planner_export schema: safe, allowlisted views]
                   │
             SELECT-ONLY ROLE
                   │  only internal Docker/private network
                   ▼
       Planner snapshot ingester (bounded + audited)
                   │
                   ▼
   Separate planner-owned DB (PostgreSQL/PostGIS if viable)
       ├── sanitized node/link snapshots + generations
       ├── draft/saved plans and share tokens
       ├── field surveys + candidate sites + scored results
       └── versioned terrain/model/job metadata
                   │
       Planner API (small, rate-limited; no heavy raster loops)
                   │
             HTTPS planner.ukmesh.com
                   │
        Browser: React + MapLibre / Web Workers
       ├── SIMPLE: place site -> predicted links
       ├── ADVANCED: profiles, coverage, ranking etc.
       ├── WebGPU compute (browser GPU, optional)
       └── WASM CPU fallback (browser worker, guaranteed)
                   │
    terrain tiles / cached region DEM / optional LiDAR
```

### 3.1 Independent deployment

- One new repo only for planner application, with separate Compose project name (`ukmesh-planner`), image names, ports and volumes.
- Separate frontend (static assets), API, planner-owned DB and optional short-lived snapshot ingester service. **No heavyweight server-side RF worker by default**.
- Planner frontend/API connect only to planner-owned DB. A **separate, narrowly privileged ingest worker** connects to UK Mesh source DB using the read-only role; ideally it runs on a segregated, attach-only network and is not internet-facing. The live UK Mesh app never depends on planner.
- Source DB access may require joining the existing external Docker network; discover instead of guessing. Keep ingress/API containers off that network. Limit outbound network reachability where possible. Do not expose source DB ports to the host or public interface.
- Planner continues displaying the last **privacy-valid** snapshot if the source DB briefly fails; indicate `Snapshot from ...` and degrade observed freshness. Do **not** continue serving a previously public location if its opt-out status might have changed and visibility cannot be verified under the established fence policy.
- Planner state should not share a logical writable database/schema with UK Mesh. Prefer separate planner Postgres/PostGIS instance/volume on the same host if capacity allows; assess a lighter PostgreSQL setup or alternative geo index if RAM is very tight. Record capacity decision.
- Source data are *read-only replicated snapshots*. Never write “planned repeaters” into UK Mesh's source nodes or MQTT topics.
- Plan changes happen in the browser and optional planner-only persistence. A proposed repeater remains a hypothetical marker unless separately confirmed deployed through independent observation.

### 3.2 Recommended technology

- **Frontend:** React + TypeScript + Vite, MapLibre GL JS, focused component modules and one MapLibre instance, no whole-map React re-render per move; CSS with responsive mobile design.
- **Browser compute:** Worker-oriented pipeline; WebGPU (WGSL) first for sizeable raster workloads, WASM CPU for compatibility; abortable jobs and progressive results.
- **API:** TypeScript/Node with Fastify or comparable small server, `zod`/JSON Schema contracts, rate limiting, structured redacted logs, OpenAPI and health probes.
- **Planner DB:** PostgreSQL 16+/PostGIS where practical; separate credentials for migration and runtime, indexes on geospatial/site search, user plans and cache keys. Alternatively justify a smaller standalone DB with equivalent index/query correctness after host-capacity measurements.
- **Source ingest:** TS/Node or small Go binary with `pg` connection pool max 1–2, hard query/statement timeout, interval, full snapshot generation and atomic publish.
- **DEM data:** existing Terrarium tiles for base layer, plus prepared cached height tiles/profiles; later optional 1 m LiDAR for site inspection, not full-UK interactive VRAM loads.
- **CI:** unit/integration/contract/E2E/security/performance/regression coverage; pinned dependencies and lockfiles; build reproducibility and rollback.

---

## 4. Source DB integration: direct, safe, complete

### 4.1 Data contracts

**Primary sources (verify actual deployed schema before writing SQL):**

- `node_identity_nodes` for canonical repeater ID, name, lat/lon, role, last seen, metadata; don't double-count aliases.
- `node_identity_sightings` to confirm UK Mesh membership where representative node's `network` is not `ukmesh`.
- `node_identity_links` or an indexed/base-table query adapted from `backend/src/repositories/networkAnalysis.ts` for real observed connections (source/target, observations, multibyte evidence, directional counts, last_observed, path loss if present). A raw link record doesn't automatically equal a bidirectional RF path.
- `public_visibility_state` generation plus opt-out/alias rules; **privacy version**, not a general content update revision.
- Optional `node_identity_link_radio_reports` for last/best SNR and reporter evidence; only when needed and proven safe/efficient.

**Repeater source rules:**

- `role = 2` is repeater in current UK Mesh. Do **not** silently include role-null nodes as known repeaters. Show ambiguous nodes separately only in an explicitly flagged layer if justified.
- Correct UK/network filtering: follow the real UK Mesh compatibility rule (`n.network='ukmesh'` OR valid UK sighting) with current operational semantics. Never import `test` network nodes as live repeaters.
- Position must be valid and nonzero; apply boundary geometry to default scope. Respect published coordinates and precision. Do not reverse-geocode missing positions or derive exact private locations.
- Import **all eligible positioned repeater rows** including stale nodes; distinguish fresh / stale / long-unseen, with user filter. Don't inadvertently lose older repeaters by copying the public map's 28-day freshness policy.
- Preserve stable canonical ID for joining links. Handle merged/re-keyed identities, duplicates and canonical changes without inventing extra physical repeaters.
- A marker without antenna AGL, exact preset or power must carry an **unknown/assumed** value rather than suggesting the dataset measured it.

**Link source rules:**

- Normalize pair orientation and directional observation counts; retain evidence class and `last_observed`.
- Filter private/opted-out nodes on **both** endpoints. Use recent validated evidence window for the default graph; allow older history with a visible label but don't silently treat it as current.
- Distinguish `observed`, `modelled`, `uncertain` and `incompatible-radio` edges. A physically possible path is not proof packets have traversed it, and a missing packet is not a definitive failed RF link.
- Avoid a full expensive aggregation of `node_identity_links` on every request. Build scheduled materialized snapshots in planner DB from bounded source queries; compare query plans and EXPLAIN (ANALYZE only in safe controlled windows).

### 4.2 Minimal production DB permissions

**Provisioning model (illustrative — validate exact live schema and apply safely, with secrets generated outside Git):**

1. Create a dedicated **NOLOGIN/NOCREATEDB/NOCREATEROLE** policy/owner for the `planner_export` schema, with deployment/admin privileges only during controlled provisioning. Ensure only a privileged operator/migration step creates/replaces these read views.
2. Create a **LOGIN role `ukmesh_planner_reader`** with a strong secret, `default_transaction_read_only=on`, small connection limit, `statement_timeout`, idle transaction timeout. No membership in UK Mesh app roles. No `pg_read_all_data`, no write, no raw table privileges or broad schema usage.
3. Create `planner_export.public_repeaters_v1`, `public_observed_links_v1`, `visibility_fence_v1` using explicit output columns, safe underlying visibility policy, and `security_barrier` where appropriate. **Grant only `USAGE` on `planner_export` and `SELECT` on these views** to reader.
4. Revoke schema-wide PUBLIC privileges; configure credentials via deployment secret file/secret manager, read-only mount and file mode 0600. Do not print passwords or connection strings.
5. Only the **ingester container** receives `SOURCE_DB_READONLY_URL`. Planner frontend/API never sees it; no generic SQL endpoint is exposed.
6. Test permission denial against `INSERT`, `UPDATE`, `DELETE`, `CREATE`, direct `SELECT nodes`, `SELECT packets`, `SELECT private_node_prefixes`, owner auth and unrelated schemas. These attempts must **fail**. Reader must still read only approved views.
7. Keep changes to UK Mesh limited to the **additive** export schema/roles and optional documented migration needed to own those views. Treat source production schema changes as a deployment risk with a reviewed rollback plan; never rerun all existing migrations from the planner project.

**Example contract shapes (not copy/paste migration SQL):**

```ts
interface PlannerRepeaterV1 {
  canonicalId: string; // public canonical node ID
  name: string | null;
  lat: number;
  lon: number;
  lastSeen: string | null;
  advertisedRole: 2;
  hardwareModel: string | null;
  antennaHeightAglM: number | null; // unknown unless authoritative
  radioPreset: string | null;       // unknown unless authoritative
  sourceUpdatedAt: string | null;
}
interface PlannerObservedLinkV1 {
  sourceId: string;
  targetId: string;
  lastObserved: string;
  observationCount: number;
  strongObservationCount: number;
  countAToB: number;
  countBToA: number;
  pathLossDb: number | null;
  evidence: 'observed';
}
interface PlannerSourceFenceV1 {
  visibilityGeneration: string;
  queriedAt: string;
  dataRevision: string; // own monotonic snapshot ID, separate from privacy generation
}
```

**Privacy architecture — critical:** Public UK Mesh nodes with a `🚫` in their name are private. That is the *minimum* privacy condition; also account for aliases/canonical identity members, explicit privacy generation, historical path-derived privacy rules and any subsequently introduced source visibility policy. **Don't merely copy `WHERE canonical.name NOT LIKE '%🚫%'` and call it safe:** check all underlying identity members and current opt-out rules, and avoid any secondary datasets reintroducing private coordinates. The production export view must be the privacy authority for the planner.

Maintain an independent **privacy invalidation fence**:

- Capture source visibility generation and sanitised snapshot in one consistent `REPEATABLE READ` read-only transaction; on completing a snapshot, recheck generation before atomic publish.
- Refresh routinely (target around 5–15 minutes, adjustable by observed load); **check lightweight visibility generation frequently** (e.g., 15–30 seconds initially, measuring DB cost) or use a safe change notification mechanism. A generation mismatch must invalidate or quarantine derived/public datasets and replace them with a freshly sanitized snapshot **before re-exposure**.
- For public reads, ensure the generation is valid under a documented freshness bound. On source outage/unknown fence status, fail closed for identifying geometry or show only safe non-identifying UI while keeping private local plans usable. Don't promise instantaneous removal from someone else's already-open browser cache: implement versioned refresh, cache purge and clear documentation of limits.
- Purge old snapshots, linked plan annotations, share-page coordinates, caches, tile results, exports, search indexes and saved diagnostics that identify a now-hidden public node. Plan references to existing nodes should use stable IDs resolved through the current visibility filter rather than copying positional coordinates permanently into shared plans.
- Do not create a public node-by-node coordinate feed outside the sanctioned planner API if the source privacy policy wouldn't permit it. Rate-limit and ensure data exports are consistent with current visibility.
- Add end-to-end tests: public -> private while a user has the page open; alias becomes private; source temporarily offline during a privacy change; stale share link; stale cached GeoJSON; search and download after opt-out; hidden node in source link evidence.

### 4.3 Source snapshot job

- Run on startup in bounded mode, then on schedule; avoid piling jobs if one takes longer than refresh interval. Track `runId`, source DB revision/source HEAD metadata, privacy generation, counts, timestamps, duration, query latency and last error (no secrets).
- Atomically swap the planner's current sanitised source snapshot only when nodes + links + visibility all pass validation. Retain one last-good *sanitised and privacy-valid* snapshot for resiliency. Do not partially publish nodes and links from different generations.
- Incremental refresh if reliable watermarks exist, otherwise safe bounded snapshot refresh. Prefer indexed source table queries and explicit caps; **do not silently truncate** records — mark incomplete and keep prior valid set.
- Default reader connection pool ≤2; statement/query timeouts; backpressure; inspect query plans against production data.
- The current UK Mesh internal HopReach adapter is reference logic only; **do not route public planner traffic through it or remove its internal-only protection**.

---

## 5. Functional user experience — Simple and Advanced

### 5.1 Simple mode: the absolute default

**Design goal:** Someone with no RF experience can visit the page and, within a few clicks, test a location.

1. Load map centered sensibly on Great Britain, showing all current eligible repeater pins with distinct stale/fresh appearance, legend and a light search.
2. Above map show one clear cue: **“Click or tap anywhere to place a proposed repeater.”** No wizard, account, technical settings panel or mode selection required before doing this.
3. Click/tap: drop one proposed marker at that coordinate, show loading progress **without blocking pan/zoom**. The browser fetches only nearby terrain tiles and relevant repeater snapshot rows, then computes predicted direct links.
4. Draw lines to **potentially reachable existing repeaters** (default “likely”, “marginal”, “unlikely/blocked” distinctions with colour + dash + text). Use appropriately bounded spatial search and show a count, not an overwhelming hairball. Make it clear which links have actually been observed and which are just predicted from the hypothetical site. For likely links show basic distance and RF margin; user can tap any line for detail.
5. A small side/bottom sheet shows: **Proposed site**, terrain elevation, assumed antenna height (editable e.g. `2 m`), possible links (count), top nearby repeaters, nearest blockers, RF model confidence/limitations and **“View Advanced Analysis”**. If no links found, explain e.g. “no compatible repeaters within modelled range” vs “blocked by terrain” vs “terrain unavailable”.
6. Drag the marker to another spot and recalculate **debounced and cancellably**. Discard stale results when the marker has moved. Reuse tile/profile caches; keep the UI responsive.
7. Optional **Show Coverage Preview** toggle: bounded regional heatmap (never a national recomputation) with explicit low/medium detail and a higher-detail button. Default Simple journey should never require the preview to compute to show links.
8. Provide Undo, Clear, Copy/share local plan and Save/Export, without mandatory sign-in. Only one active proposed site by default; allow more in Advanced.
9. Site markers and links must remain usable on phones; use a compact bottom sheet and accessible controls rather than a desktop sidebar squeezed onto mobile.

**Acceptance journey S1:** Fresh private-browser profile -> homepage -> click any in-bound map point -> a proposed marker appears immediately -> predicted links and clear no-result/failure states appear -> change antenna height -> link assessment changes appropriately -> drag site -> results follow latest location only -> switch Advanced and back -> same plan remains. No unhandled exception; no mock data.

**Simple UI anti-complexity rules:** Don't land users on a dashboard, graphs, hardware selector, tabs of equations, modal onboarding, multi-step setup or menu of fifty GIS layers. Keep technical depth one tap away. Avoid unnecessary popups for first placement.

### 5.2 Advanced mode: serious repeater planning

Access via one labelled **Simple | Advanced** switch. Use the same map and `PlanState` model, not two separate data stores.

**Advanced panels/features:**

1. **Precision LOS / terrain profiles:** pick two points or any proposed/existing site pair; cross-section shows terrain/DTM, Earth curvature with documented effective-radius assumption, straight-line antenna path, first Fresnel zone, percent clearance and worst obstruction(s), antenna heights AGL and ASL, missing data segments. Show profile source/resolution/time.
2. **Link budget:** actual or explicit assumed UK radio preset, frequency, BW/SF/CR where relevant, device powers, antenna gain/pattern, cable loss, receiver sensitivity, fade margin, antenna AGL. Support asymmetric endpoints and warn when presets are incompatible. TX/EIRP/ERP regulatory helper is advisory and should identify assumptions, not assert legal approval.
3. **Viewshed / RF coverage:** projected terrain/RF margin in a user-selected area and resolution, proposed site(s) layered over existing coverage, new-vs-overlap delta, legend and explicit confidence. Don't present a simple geometric LOS polygon as a full propagation model.
4. **Network topology:** observed links versus predicted links; graph components, bridge/articulation points, weakly connected regions, alternative paths, site-removal scenario, predicted new connections. Distinguish one-way reports from reciprocal evidence.
5. **Candidate search:** selected polygon/corridor -> automatic potential sites using coarse screening and fine evaluation. Goals: link islands; resilience; new land/population coverage; fewer new repeaters; lower cost. Return location, rank factors, assumptions, before/after metrics and confidence. No LLM-made coordinates.
6. **Bridge route planner:** choose two existing repeaters or components, optimise one or multiple new repeater locations, rank alternatives by number of sites, RF headroom, route feasibility and network benefit.
7. **Antenna-height optimiser:** compare elevating current repeaters vs new deployment, with structural feasibility disclaimers.
8. **Site feasibility:** mapped paths/roads, existing masts where appropriately licensed, terrain slope, woodland/building/DSM hints, land constraints; clearly mark **potential**, not permission granted.
9. **Power / materials:** winter solar/battery assumptions, power draw, mounting/weatherproofing checklists, equipment bill of materials, optional cost input; keep vendor shopping data optional and not baked into RF assumptions.
10. **Field surveys:** GPS-tagged user-entered or safely imported radio measurements, repeated tests, path evidence and prediction-vs-observation plots. Surveys are private until explicitly published.
11. **Scenarios / history:** multiple candidate nodes, toggle enable/disable, compare before/after or plan A/B, save/version, export GeoJSON/KML/CSV and human-readable PDF optionally later.
12. **Model confidence diagnostics:** inspect DEM coverage, resolution, excluded unknown obstacles, radio assumptions, observed evidence counts, job compute backend and model revision.

**Switch behaviour:** Never discard coordinates, user custom antenna heights, planned sites, overlays or unsaved edits when toggling modes. Keep Advanced selections hidden in Simple unless directly relevant. The basic map interactions remain exactly the same in both.

### 5.3 Visual requirements

- An attractive, practical mapping tool, not an “AI-styled” dashboard. Consistent typographic scale, sparse panels, good contrast and obvious actionable affordances.
- Basemaps: modern light/dark street map, hillshade/terrain, optional satellite with legal provider attribution. One MapLibre instance.
- Planned sites visually distinct from existing repeaters; real observed links distinct from simulated links. Don't use colour as the sole differentiator.
- Cluster pins at national zoom for performance but not hide nodes from source counts/analysis.
- Explain empty areas and loading stages; show snapshot age and **assumptions** unobtrusively.
- Keyboard controls, focus states, screen-reader descriptions, mobile touch hit areas and reduced-motion support.

---

## 6. RF, terrain, LOS and browser compute design

### 6.1 Accurate, layered data sources

- **Base UK/GB:** re-use existing terrain tiles from UK Mesh, reported as **Terrarium encoding, 256 px, MapLibre `raster-dem` source `maxzoom: 12`**, served under `/terrain-tiles/{z}/{x}/{y}.png`. They are derived from OS Terrain 50 in current Nginx comments; verify provenance, actual resolution and licence. **Map zoom != terrain resolution**: overzoomed tiles must not be advertised as sub-metre data.
- Prefer a safe read-only copy/mount or independent planned-tile service; if proxying UK Mesh's existing static tiles, cache with an explicit budget and protect the live site from unlimited planner cache misses.
- Optional later high-resolution LiDAR: Environment Agency for England, DataMapWales for Wales, Scottish remote sensing where available, OSNI for Northern Ireland. Record extent, DTM/DSM distinction, vertical datum, acquisition date and licence. Do not assume full 1 m Scotland coverage.
- Use authoritative region boundaries. **Great Britain mainland** as initial viewport/default targeting focus, with selectable Northern Ireland, nearby islands, and Crown Dependencies where covered; don't silently conflate Isle of Man/Channel Islands with the political UK. The existing UK Mesh `uk-operational-v1.geojson` includes GB, NI, Isle of Man and Channel Islands and may be reused only with clear labels.
- DEM sampling must handle NODATA, sea surfaces, tile seams, projection, coordinate wrap and missing network data. Do not silently replace missing land elevations with 0 m and claim clear LOS.

### 6.2 Browser computation tiers

**Tier A — immediate graph/point-to-point:** pure JS or WASM Worker. Geodesic filtering + small path elevation profile + link budget. This is fast relative to raster calculations and should work on ordinary browsers without WebGPU. Always give this result first in Simple mode.

**Tier B — regional coverage:** WebGPU where supported. Request adapter/device dynamically using feature detection; compile and run a **browser-safe** WGSL shader. Parallelise across output pixels or candidate paths in bounded tiles/chunks. If the GPU is unavailable or fails, offer bounded WASM Worker compute at lower preview resolution with a clear user notice.

**Tier C — detailed advanced analysis:** on request, region-bounded multi-pass GPU/WebAssembly calculation. Background Worker progress, cancellation, timeouts, suspend/visibility policy and adjustable precision; never freeze the UI or start a 16-hour national CPU operation.

**Native HopReach source is a reference, not automatically browser-ready.** `third_party/hopreach/internal/gpucompute/gpucompute.go` uses `wgpu-native` on Vulkan and includes a WGSL compute shader. The existing native implementation declares **16 separate elevation bindings + parameters + sites + output**, exceeding portable browser WebGPU baseline storage binding counts. It also handles extremely large elevation buffers that ordinary browsers cannot assume. **Redesign memory layout for browser limits** before porting, likely processing local DEM tiles/strips with 1–2 elevation buffers and modest output chunks. Use `device.limits`/`adapter.limits` rather than hardcoding assumed VRAM, and avoid large initial allocations.

**CPU fallback:** The existing HopReach planner demonstrates Go/WASM via Web Worker and a capped 35 km local preview / DEM zoom 10. That is a helpful pattern/reference, not proof that the standalone app can legally paste the code. Implement or license a compatible WASM CPU core; run all client compute off main thread. No reliance on server-side CPU as a “fallback” that could hammer the VPS.

**Compute functional requirements:**

- Flexible max path distance with conservative preliminary link-budget and spatial filter; never test every national repeater unnecessarily.
- Terrain profile, 4/3 Earth effective-radius assumption (configurable/explained), Fresnel geometry, free-space path loss, appropriate knife-edge diffraction/model; clear separation of LOS vs RF viability.
- Range and height changes invalidate the right cache keys. Include DEM version, exact sampled geometry, model version and radio settings in cache keys.
- Cache terrain tiles in browser (respect provider licence/cache headers), decoded heights and derived path profiles with bounded IndexedDB/memory. Clear caches on source changes or when over budget.
- Two endpoint configurations (TX and RX), directional antennas and optional measured antenna patterns where provided. Keep unknowns explicit.
- Show **model assumptions and uncertainty**. No fabricated 99% reliability or false accuracy from 50 m terrain.
- Good handling of mixed MeshCore radio presets: don't draw a green workable link between radios with incompatible frequency/modulation settings just because terrain LOS is clear.

### 6.3 Practical WebGPU implementation contract

Build `src/compute/{engine,webgpu,wasm,protocol,...}` with one stable input and result schema:

```ts
type Backend = 'webgpu' | 'wasm';
type ModelClass = 'los' | 'terrain-link-budget' | 'regional-coverage';
interface ComputeRequest {
  jobId: string;
  modelVersion: string;
  terrainRevision: string;
  sourceSnapshotId: string;
  modelClass: ModelClass;
  plannedSites: PlannedSite[];
  receiverSites?: LinkEndpoint[];
  bounds?: [number, number, number, number];
  resolution?: { width: number; height: number };
  rf: RfSettings;
}
interface ComputeResult {
  jobId: string;
  backend: Backend;
  modelVersion: string;
  terrainRevision: string;
  output: LinkResult[] | RasterResult | ProfileResult;
  warnings: string[];
  elapsedMs: number;
}
```

- Detect `navigator.gpu` on a secure context; request a compatible adapter, inspect limits, create device and shaders once, reuse across compatible jobs.
- WebGPU is opt-in by capability; **no assumption of NVIDIA driver support just because the user has a GPU**. Linux Chrome/Edge, Firefox, Safari, Windows, macOS, Android/iOS and software-rasterizer cases must be tried where possible. A software adapter may be slower than WASM; benchmark it and select WASM when appropriate.
- Watch `device.lost`, compilation errors, validation errors, tab backgrounding, allocation failures, adapter unavailable or permission/environment restrictions. Recover cleanly and re-execute the **same input on WASM** if workload is within documented fallback ceiling, rather than pretending output is complete.
- GPU dispatches must be chunked to keep the UI responsive and avoid watchdog/device loss; use transferable buffers and backpressure rather than massive `postMessage` copies.
- Verify GPU numerical results against independent CPU/WASM oracle fixtures before trusting output; record tolerances and boundary classification exceptions with reasons.
- The browser's compute stops when its tab closes. Don't imply anonymous clients contribute persistent national compute. **No distributed visitor GPU farming without explicit, informed opt-in, limits and result verification.**
- Do not upload users' private coordinates/field surveys or unique hardware info to external APIs as a side effect of GPU testing.

### 6.4 Specific compute comparison tests

Prepare golden synthetic fixtures: flat plain, ridge exactly between sites, multiple hills, near-coast land/sea, missing DEM cell, a path near the range cutoff, two-way asymmetric radio settings, changed mast height, short path, 100 km long path and high-latitude UK geometry. Include a few known surveyed real-world paths with provenance/consent where available.

- CPU maths checked against independently computed formula values and/or an appropriately licensed/reference test oracle.
- GPU vs WASM: require agreed sign/classification away from thresholds; propose initial `≤0.3 dB` typical numerical tolerance for shared terrain link budget using 32-bit WGSL and adjust **only with measured precision evidence**. Investigate every material > threshold difference; reproduce with persisted fixture.
- Test 256×256, 512×512 and 1024×1024 local rasters; record GPU, WASM, terrain download, upload, total, memory, battery/thermal where observable, and cancellation.
- Test low GPU buffer limits and tiny memory budgets; verify zero **VPS** RF job cost on simple placement (aside from static tile/data traffic).
- For source DEM issues, return `unknown/missing terrain` rather than misleading green links.

---

## 7. Suggested repeater sites and network value

Implement an **incremental, bounded** optimiser, not an entire-UK brute force search.

1. Build a sanitized graph from the observed UK Mesh snapshot; label evidence age, source, directionality and confidence.
2. Identify disconnected components, articulation points, low-redundancy corridors, geographical coverage gaps and candidate service targets.
3. Generate candidates from a coarse terrain grid, high-ground features and open/licensed mapped structures **within the user-selected area**. Optionally score population and permitted site-access data. Include candidate elevation and terrain resolution.
4. Cheap rejection: not within target area, obviously impossible link-budget distance, unknown terrain, no likely network connection when connectivity is required, incompatible preset, too many unusable slopes or redundant overlap.
5. Detailed evaluation on shortlist: selected LOS paths, diffraction/link budgets, topology delta and (when requested) local regional coverage raster.
6. Rank with explicitly documented normalised objectives: additional useful coverage, connectivity between existing components, resilience, population benefited, expected congestion/airtime penalty, estimated practical difficulty/cost and uncertainty. Allow weights in Advanced; sensible preconfigured goal presets.
7. Show the **reason** for every suggestion, existing routes it could connect, predicted margins, assumptions and why some sites were rejected.
8. Avoid claiming land access or installations are permitted merely because OSM shows a mast or nearby path.

**Performance strategy:** spatial index (`PostGIS` GIST or in-memory R-tree), chunked candidate generation and adaptive coarse-to-fine refinement. Cache candidate link tests by terrain/model version. Cap polygon area, candidate count, radius and memory by documented policy. Long searches remain within user's browser, run in Workers, offer cancel/resume where feasible and never block Simple use.

**Numerical evaluation:** Compare suggested placements against straightforward baseline strategies (highest ground, nearest available repeater, random eligible site); measured improvements must be reproducible and not just UI decoration. No unsupported “best location in UK” claims.

**Stretch after verified core:** MeshBench-style real firmware simulations to model airtime collision/hidden-node effects for top scenarios, subject to licensing and browser/server feasibility. This is not a blocker for Simple mode and shouldn't overwhelm the VPS.

---

## 8. Planner-owned data model and API

### 8.1 Datastore (versioned migrations)

Recommended separate tables/entities:

- `source_snapshots`: snapshot ID, source visibility generation, start/finish time, status, counts, fingerprints, expiry, dataset revision.
- `source_repeaters` (or current snapshot+historical revision table): canonical ID, allowed coordinates/metadata, seen time, source version, boundary membership; indexed by geometry+ID.
- `source_observed_links`: canonical endpoints, observed counts/directions, last observed, evidence and revision.
- `plans`: ID, anonymous local owner or authenticated owner reference if auth introduced later, status, created/updated, version, scope, RF defaults; private by default.
- `plan_sites`: planned site IDs, coordinates, antenna/height/preset/settings, tags/comments; always kept separate from real repeater nodes.
- `plan_scenarios` / `plan_events`: compare alternatives and undo/versioning.
- `shares`: random opaque capability tokens stored **hashed** server-side, explicit audience/visibility/expiry, revoke status; no enumerability.
- `candidate_jobs` / `candidate_results`: selected geometry, input/model/snapshot hashes, computed rank facts, uncertainty, expiry; no accidental permanent location tracking.
- `surveys`: voluntarily entered field data, consent/public flag, captured time, sample location and radio settings; private by default.
- `terrain_cache_catalog`: DEM source, hash/version, geographic extent/resolution/licence, source and expiry.
- `audit_events`: compact security/plan-publication events with bounded retention, redacted sensitive values.

Retain no raw MQTT packets, DM contents, decrypted payload, full device status JSON, privileged owner information, auth secrets or user IP addresses for link calculations. Establish retention/erasure policy for plans/surveys and user data under UK GDPR. Review and document backups and recovery.

### 8.2 Planner API (same-origin `https://planner.ukmesh.com/api/...`)

Keep small, versioned, schema-validated endpoints; suggested initial routes:

```text
GET    /healthz                      liveness (no source DB query)
GET    /readyz                       planner DB / snapshot readiness
GET    /api/v1/config                public bounds, model/dataset/backend versions
GET    /api/v1/snapshot/meta         timestamp, completeness, privacy-safe version
GET    /api/v1/repeaters             paginated or bbox-filtered, sanitized; no private
GET    /api/v1/observed-links        bbox/endpoint filtered, sanitized
GET    /api/v1/terrain/catalog       available data/precision/licences
GET    /api/v1/terrain/tiles/:z/:x/:y bounded tiles, immutable cached
POST   /api/v1/plans                 private plan creation (if server persistence)
GET    /api/v1/plans/:id             authorised/capability-bound only
PUT    /api/v1/plans/:id             authenticated token/version-controlled
DELETE /api/v1/plans/:id             authorised deletion
POST   /api/v1/plans/:id/share       explicit grant w/ expiry and revoke
POST   /api/v1/plans/:id/revoke      revoke share access
GET    /api/v1/shares/:token         explicit shared plan; privacy-filter on read
GET    /api/v1/exports/plan/:id      authorised, sanitized GeoJSON/KML/CSV
```

Prefer client-side transient plans using IndexedDB for anonymous planning. Server persistence is optional until a user explicitly saves/shares; no user registration required for the core Simple experience. Validate all latitude/longitude and polygon shapes, byte sizes, number of points, field lengths, radio settings, max candidates, request IDs and filename arguments. Content Security Policy, CORS same-origin, cookie/capability handling and abuse rate limits are required; don't create an open compute execution API on VPS.

**Important:** Public planner data retrieval is served **from its own sanitized snapshot database**; the API is not an SQL proxy to source TimescaleDB. **Never expose source DB credentials or connection details to JavaScript.**

---

## 9. Scope decisions and out-of-scope boundaries

### 9.1 Ship in the first complete release

- Independent repo and working production domain/stack, safe source DB ingester, privacy-safe repeater and observed-link snapshot.
- Responsive national map, all eligible positioned repeater markers and freshness, map/layers/legend.
- **Simple placement -> predicted links with explained viability, antenna height, drag/undo, bounded local coverage preview**, WebGPU where supported + WASM fallback, no account.
- Advanced two-point LOS with terrain/Fresnel view, editable radio settings, before/after local raster, interactive observed topology and basic graph analysis.
- Advanced bounded candidate-site ranking and basic bridge recommendations in a user-selected region, with reproducible score and constraints.
- Local plan persistence/import/export, share workflow with privacy and limits (if server sharing implemented), explicit private surveys optional in later release.
- CI tests, mobile E2E, security/privacy protections, metrics, docs, backups and rollback proof.

### 9.2 Implement after the first release if necessary, but design interfaces now

- Nationwide background recommendation index, detailed population/LiDAR fusion, rooftop building-height/canopy models, full advanced solar/battery procurement, real-firmware MeshBench integrations, community project governance, rich PDF deployment cards, distributed volunteer GPU jobs.
- These can be separately phased without making the first public tool misleading or incomplete. **Do not pretend to implement them by adding nonfunctional UI buttons.**

### 9.3 Explicitly out of scope

- Running full UK HopReach precision recomputation in the visitor browser by default.
- Installing a GPU on the VPS or requiring GPU compute from its host.
- Changing live MeshCore repeater settings, publishing MQTT packets, or creating real nodes in the existing UK Mesh database.
- Radio regulatory certification, structural safety approval or landowner permission automation.
- Accessing private repeater coordinates through database privilege shortcuts.

---

## 10. Tests and engineering gates (implement, run, fix)

Create proper test fixtures; don't test only a “hello world” homepage. Every phase should add tests and produce visible evidence of passing outcomes.

### 10.1 Data integration and privacy

- Canonical identity aliases resolve to one repeater; two colocated but distinct repeaters remain separate; stale repeaters remain selectable with status; role-null and nonrepeater roles excluded from default inventory.
- UK network membership works through sightings even when representative `network` differs; `test` data excluded.
- Pagination/incomplete source reads never cause partial snapshots to be published; retry/resume cleanly; reader pool is bounded and does not starve live UK Mesh.
- Sanitized views block private names/coordinates/aliases and links to private endpoints, including when node renamed private after snapshot was built.
- Public visibility generation change purges invalid caches, stale saved-plan references, exports, search, share links, frontend state and derived outputs.
- DB reader permissions: SELECT on export views succeeds; writes, DDL, raw table reads, owner/packet tables all fail. Test against isolated DB fixture, not live destructive statements.
- Source DB down while source snapshot is safe/unsafe; verify exact fail-closed behaviour. Existing UK Mesh app must remain healthy throughout.

### 10.2 RF maths and model correctness

- Geodesic distance at UK latitudes; kilometres vs metres; AGL vs ASL; vertical datum; positive/negative elevations; earth curvature/refraction; Fresnel radius and clearance; diffraction/FsPL; cache invalidation on antenna changes.
- `unknown DEM`, sea, site at coast, missing tile, 180° longitude edge, polygon boundary, height=0, wrong radio preset and non-finite inputs.
- CPU/WASM vs WebGPU numerical parity on fixed and randomized seeded test paths; no material wrong clear/blocked classification away from threshold; deterministic outputs by model/DEM revision.
- Observed vs predicted evidence never collapsed together or asserted bidirectional without supporting data.

### 10.3 Browser/UI journeys (Playwright or equivalent)

1. **SIMPLE-01:** load -> click UK map -> proposed site -> lines + list; no account/modal required.
2. **SIMPLE-02:** drag marker repeatedly/quickly -> only latest job displayed; cancelled jobs don't mutate state.
3. **SIMPLE-03:** change mast height -> propagation reruns -> explanation and results update; undo restores.
4. **SIMPLE-04:** simulated blocked ridge -> explanation says terrain blockage, not “no nodes” or green.
5. **SIMPLE-05:** no internet / missing DEM -> honest unknown and usable map/state, no crash.
6. **SIMPLE-06:** no WebGPU -> WASM fallback works; GPU compile failure/device loss -> fallback works.
7. **MODES-01:** switch Simple -> Advanced -> Simple repeatedly -> all plan settings/sites preserved.
8. **ADV-01:** draw LOS chain -> terrain profile/Fresnel/clearance displayed; adjust endpoints changes chart.
9. **ADV-02:** plan 2+ sites -> compare scenarios -> observed vs proposed link visual distinction.
10. **ADV-03:** candidate search on a bounded polygon -> deterministic ranked sites and score breakdown; cancel works.
11. **ADV-04:** source graph articulation point test -> correct component count and simulated node removal effect.
12. **PLANS-01:** reload local draft -> coordinates/settings preserved; private share is not enumerable.
13. **PRIVACY-01:** simulated source visibility change while browsing -> private node disappears from all surfaces without exposing old coordinates in API.
14. **MOBILE-01:** touch placement, bottom sheet, pans/zooms, mode switch and editor are usable on narrow viewport.
15. **A11Y-01:** keyboard map navigation/controls, focus, contrast, meaningful link status text, reduced motion.

### 10.4 Nonfunctional/performance targets — benchmark, do not claim without measuring

Initial **targets** to validate/tune, not guaranteed results:

- **Simple:** after DEM data is locally available, first nearby link estimates should feel interactive (target ~1–2 s on representative modern desktop; degrade gracefully on mobile); no need to wait for full raster.
- Map pan/zoom should remain responsive (test browser long tasks/frames under normal UK node count, representative mobile hardware).
- GPU local coverage (e.g. 512×512 area) should show measurable speedup against WASM on tested supported GPU, **without numerical errors**; if not, dynamically choose WASM.
- Large jobs are explicitly user-triggered; chunked/cancellable; constrained by RAM and browser device limits; no unbounded visitor workload.
- VPS source DB reader at most 1–2 concurrent connections with fixed timeouts. The planner's **normal interactive RF request path uses no source DB raster queries and no source server RF CPU job**.
- Measure CPU/RAM, HTTP response sizes, tile transfer and disk cache under 1/10/50 simultaneous site users (within host budget). Test production stack does not affect live UK Mesh's health/latency beyond defined safe threshold.
- Unavailable source Postgres or planner-owned DB produces bounded errors and proper status, not infinite reconnect loops or request storms.

Publish exact benchmark machine/browser, GPU/driver, viewport, DEM version, preset, duration, warm/cold cache status, confidence limitations and job type in `docs/performance/benchmarks.md`. Never reuse the old 16-hour national run as proof of interactive performance.

### 10.5 Security and deployment

- Typecheck, lint, unit tests, package audit, dependency/license inventory, container build, vulnerability scan, API/OpenAPI contract tests, production config validation and secret scanning.
- Test CSP, HTTPS, secure cookies/opaque tokens, CORS, data validation, cache headers, robots/SEO decisions, denial of invalid/oversize geometry inputs, rate limiting, SQL injection, XSS in malicious repeater name and saved-plan description, CSRF on mutation routes as applicable.
- Test malicious source DB value (HTML, escaping, extreme coordinates, duplicate names) cannot execute code.
- Database backups and recoverability; restore a planner DB snapshot to a **disposable** test database and verify it loads; never restore over production.
- Run browser E2E against deployed release in real Chromium and at least one mobile-size viewport; try actual WebGPU hardware where available, and document unavailable test hardware as a limitation.
- Negative-test rollback and ensure live UK Mesh backend/MQTT/owner pages remain unaffected.

---

## 11. Step-by-step implementation stages with exit gates

**Stage 0 — Discovery and baseline**

- Inspect host, source schema, network, terrain, licences and deployment. Verify/create GitHub `gadgethd/ukmesh-planner` remote using authenticated access; work on a feature branch.
- Save resource baseline, assumptions, dependencies and privacy threats.
- **Exit:** source-contract document and verified host/deployment plan; existing UK Mesh healthy.

**Stage 1 — Independent foundation**

- Set up repo, frontend/API, type-check, tests, Docker builds, Compose project isolation, healthz/readyz, secret templates, docs, CI and a nonproduction preview URL.
- Add planner-owned state DB/migrations and sample fixture backend.
- **Exit:** CI green; `docker compose config` valid; prototype has no dependency on live UK Mesh restarts; no publicly exposed DB.

**Stage 2 — Safe direct DB data snapshots**

- Safely provision `planner_export` read views and SELECT-only role; run query-plan review; implement full sanitized repeater + observed-link snapshot import, privacy generation fence, cached indexed planner query endpoints and source outage behaviour.
- **Exit:** real positioned eligible repeaters in fixture/staging, canonical identities correct, no private data, permission-denial and opt-out tests pass; live source remains healthy.

**Stage 3 — Map and complete Simple UX**

- MapLibre basemap, real nodes, freshness, place/drag/clear site, terrain tile loader, first-pass WASM LOS/link engine, predicted links, simple results sheet and basic preview. No fancy Advanced pane until default path works.
- **Exit:** SIMPLE-01 through SIMPLE-05 green on desktop/mobile; sample real UK sites show plausible outputs vs independently verified terrain.

**Stage 4 — Browser WebGPU path + correctness**

- Implement browser-portable WGSL tiled engine, dispatch/memory caps, device-loss handling, exact parity fixtures and backend auto-selection. Instrument benchmarks and fallback.
- **Exit:** WebGPU supported device passes numerical and UI tests, no-GPU device passes WASM tests; measurable performance evidence; no CPU flood on VPS.

**Stage 5 — Advanced tools + recommendation engine**

- Add Advanced mode without replacing Simple map/plan state. Terrain profiles/Fresnel, RF editor, separate observed/predicted topology, site-removal analysis, bounded proposed coverage/delta and candidate optimisation.
- **Exit:** MODES/ADV tests green, RF unit suite correct, complete deterministic candidate fixtures with explainable rank.

**Stage 6 — Saved plans, collaboration and polish**

- Local IndexedDB persistence, export/import, optional private server-backed shares with revocation and TTL, clear UI accessibility, graceful mobile UI, field survey entry if time/capacity permits.
- **Exit:** plans persist and share only by opt-in; privacy revocation tests; mobile/accessibility checks pass.

**Stage 7 — Production staging, rollout and verification**

- Run all CI/security/e2e benchmarks, signed/versioned images, separate production deployment and TLS. Verify real `planner.ukmesh.com` resolves and serves over HTTPS, privacy/data/terrain/compute works across browsers, health probes and resource isolation.
- Run pre/post health/latency baseline against existing UK Mesh. Test rollback, secrets permissions and backups.
- **Exit:** published release is functional, traceable and independently roll-backable; no live regression; all hard acceptance gates met or explicitly identified as blockers.

**At every stage:** Commit granular coherent changes with test results. Review your own diff for data exposure, unbounded compute, accidental edits outside repo and licence notices. Do not use MissionDeck or any other agents to review your work.

---

## 12. Repository layout (suggested; adjust coherently)

```text
ukmesh-planner/
  README.md
  LICENSE                      # choose only after dependency/derivative review
  SECURITY.md
  CONTRIBUTING.md
  .env.example                 # no secret values
  .github/workflows/ci.yml
  .github/workflows/release.yml
  docker-compose.yml
  docker-compose.prod.yml
  Dockerfile.api
  Dockerfile.web
  packages/
    contracts/                # zod/types/OpenAPI and model protocol
    rf-core/                  # CPU reference + WASM build + tests
  apps/
    web/
      src/
        app/                  # route and shared plan state
        map/                  # single MapLibre ownership
        simple/               # minimal placement + result sheet
        advanced/             # terrain/RF/topology/search tools
        compute/              # browser GPU/WASM orchestrator + workers
        terrain/              # DEM decode/cache/profiles
        plans/                # local IndexedDB, import/export
        ui/                   # responsive common components
      e2e/
    api/
      src/
        routes/               # bounded public planner-only API
        database/             # migrations and repositories
        snapshots/            # read-only source importer (can be own service)
        privacy/              # policy/fence validation
  db/
    planner-migrations/
    source-export-provision/  # reviewed, ADDITIVE schema/role SQL only
  shaders/                    # WGSL, fixtures, licence provenance
  fixtures/
    dem/
    rf/
    snapshot/
  ops/
    nginx/
    monitoring/
    backup-and-restore/
    deployment/
  docs/
    architecture.md
    integration/source-contract.md
    security/privacy-threat-model.md
    rf/model-assumptions.md
    rf/parity-fixtures.md
    performance/benchmarks.md
    operations/host-inventory.md
    operations/runbook.md
    operations/rollback.md
    decisions/
    deployment-report.md
```

### Required documentation

- `README.md`: local setup, architecture, environment, test commands, developer workflow and release overview.
- `docs/integration/source-contract.md`: exact source DB views, columns, scoping, privacy, generation semantics, indexes, query budgets, tested source SHA.
- `docs/rf/model-assumptions.md`: radio defaults, propagation models, diffraction limits, Fresnel method, Earth correction, DEM and missing-data behaviour, modelling unknowns.
- `docs/security/privacy-threat-model.md`: data classification, role grants, plan-sharing privacy, opt-out invalidation, abuse and retention.
- `docs/performance/benchmarks.md`: actual measured CPU/WASM/WebGPU and host impact; include methodology.
- `docs/operations/runbook.md`: deploy, health, observed failures, snapshot recovery, GPU fallback, capacity, backups and restore.
- `docs/operations/rollback.md`: exact safe rollback without affecting existing UK Mesh.
- `docs/deployment-report.md`: real version/commit, what ran, HTTPS checks, screenshots, failed or skipped tests and blockers.

---

## 13. Production safety and operational implementation

- Deployment Compose project **must not change ownership** of UK Mesh's existing Docker services, Docker volumes or default network.
- Explicit network names and aliases; avoid duplicate static IPs. Put edge/frontend, planner API, planner DB and source-importer on **least-privilege** networks. Verify real published topology before joining source DB network.
- Use DNS or Cloudflare Tunnel based on the existing host's supported pattern, but create separate hostname routing. If edge changes affect existing UK Mesh, review/test effective config and have immediate rollback.
- Images pinned/tagged by source commit or immutable digest; no mutable production latest dependency. Separate image tags/volumes under `ukmesh-planner`.
- Container resource caps and security: read-only filesystems where practical, drop capabilities, `no-new-privileges`, nonroot users, tmpfs scratch, explicit health checks and bounded restart policy. Resource limits chosen from measured VPS capacity, not arbitrary guesses.
- Distinct source-reader and planner-writer credentials. DB runtime user cannot run migrations; migrate via controlled one-shot migration job. Credentials not in Compose CLI interpolated logs/screenshots. Verify source reader remains restricted.
- Metrics: source snapshot age, import success/failure, visibility generation state, DB pool pressure, API latency, tile cache hit rate, browser compute backend selection, job cancellation/device-loss events (privacy-safe), node/link count changes and CPU/RAM.
- Alert for stale/failed privacy fence or source importer, repeated browser GPU errors, low disk space, abnormal tile bandwidth, planner-ready failures and excessive source DB load.
- Backups: planner state DB, migration metadata and share/consent records; restore rehearsal into isolated test target. Cache/tiles regenerable, but original download/licence provenance documented.
- No mixed/private telemetry from planner in live packet/MQTT stores. Privacy-sensitive browser analytics default off/minimal; no precise clicked-home-location logging.
- Rollback: stop/revert **only planner** images and schema migrations in its owned DB; preserve sanitized snapshots/backup as policy permits. Source export views should remain or be removed with separately reviewed additive rollback, never destroy live node data. Confirm live UK Mesh remains healthy.

---

## 14. Final acceptance checklist — **do not mark complete without evidence**

### Product

- [ ] `ukmesh-planner` is a separate Git project with a reachable intended GitHub remote (or exact permission blocker recorded).
- [ ] Planner services, persisted planner state and deployment independently managed from live UK Mesh.
- [ ] HTTPS site is reachable on independent domain (or exact DNS/tunnel blocker recorded), showing actual permitted repeaters.
- [ ] Default Simple mode requires **only a map click to propose a node and see its predicted links**; no account or multi-step flow.
- [ ] Drag/height update and nearby links work, with meaningful blocked/no-data/no-compatible-repeater states.
- [ ] Simple ↔ Advanced toggle preserves plan and supports mobile.
- [ ] Advanced provides working LOS/Fresnel/profile, model controls, topology, local coverage and bounded site recommendations.
- [ ] Observed vs predicted links are never falsely conflated; radio settings and unknown values are transparent.
- [ ] Public snapshot includes all eligible positioned real repeaters (not silently truncated), with staleness visible and current privacy enforced.
- [ ] Local plans can be restored/exported; public shares require deliberate opt-in and are revocable if implemented.

### Integration / security

- [ ] Source DB reader can SELECT **only approved sanitized views**, not write or read raw private tables.
- [ ] Planner has **no production source DB write credentials** and doesn't use public live map APIs as the data source.
- [ ] Snapshot atomically published, privacy-fenced and invalidated on privacy-generation change.
- [ ] Private/opted-out nodes and their links/derived identifying coordinates do not leak through any planner route, map, cache, export, share or log.
- [ ] No changes to legacy UK Mesh `/coverage/planned` APIs or `/hopreach` internal exposure.
- [ ] Source DB/timeouts/worker frequency don't degrade live UK Mesh; source outage handled safely.
- [ ] Third-party software and geodata licences verified and attributed.

### Compute / QA / operations

- [ ] Browser WebGPU accelerates tested supported GPU; limits/device-loss conditions gracefully fall back to WASM.
- [ ] WASM-only Simple journey works without any GPU.
- [ ] GPU numerical results pass CPU/WASM fixtures within documented tolerance.
- [ ] No default nationwide full RF compute and **no 16-hour-style CPU workload** in normal planner operation.
- [ ] All named unit, source-permission, privacy, integration, end-to-end, mobile, performance and container tests run and results recorded.
- [ ] Rollback tested; observability, alerts, secret handling, backups and restore procedure documented.
- [ ] Production vs staging release version, commits, reproducible build and exact acceptance evidence recorded.
- [ ] **Zero MissionDeck tasks, zero subagents, zero delegated coding/review agents were used to implement this project.**

### Final report format from implementing AI

Include:

1. **What is running:** repo URL, commit SHA, release version, deployment host/project/containers, public HTTPS URL and live result screenshots.
2. **What was built:** Simple user path, Advanced features, true observed/predicted integration, WebGPU/WASM capabilities and exact source DB views.
3. **Proof:** CI results (test counts), manual browser runs, source read-only permission tests, privacy revocation tests, before/after live UK Mesh health, measured GPU/CPU performance and query bounds.
4. **Ops:** commands/runbooks, source/plan DB backups, monitored alerts and tested rollback route.
5. **Limitations:** accurate list of deferred features, browser/terrain gaps, incomplete licensing or external DNS/access blockers. Never describe unimplemented functionality as working.
6. **Execution attestation:** Explicitly say the project was done in the owning AI session **without MissionDeck, subagents or delegated AI agents**.

---

## 15. Immediate next actions for you, the implementing AI

1. Read this entire brief. Start with host and current `gadgethd/ukmesh` inspection. Do **not** start another agent or MissionDeck session.
2. Confirm/create the standalone repository and commit this plan as `docs/BUILD-PLAN.md` for local project traceability (preserve full content, no secrets).
3. Measure source schema/deployment and decide the tightest direct read-only integration path; write view-provisioning SQL and test it in an isolated PostgreSQL fixture before applying carefully to the live source.
4. Build the working default **Simple** map journey first, using a CPU/WASM worker so the feature is available to everyone; add WebGPU acceleration without compromising CPU fidelity.
5. Bring in Advanced tools incrementally; insist on numerical correctness and privacy at every boundary.
6. Deploy the independent site only after automated tests, staging and source health checks. Verify the actual live URL and keep an evidence-backed progress log.
7. Continue through production acceptance, fixes, docs and handover in your own session. **Do not delegate.**

**Final product north star:** A member of the UK MeshCore community visits `planner.ukmesh.com`, drops a proposed repeater onto the map, and reliably sees which existing repeaters it could connect to. The Advanced mode helps experienced operators decide where the next repeater should be deployed and why — without melting the UK Mesh VPS.

---

## 16. Recorded decisions — Ben's answers to the open questions (2026-10-13)

Binding inputs to the build, recorded before any execution. Execution has **not** started.

**1. Repository.** `gadgethd/ukmesh-planner` has been created (public; default branch `main`). hermes-gadget has write access (collaborator invitation accepted 2026-10-13). The planner is built only in this repository — never inside `gadgethd/ukmesh`.

**2. Live database provisioning.** Approved for the implementing AI to perform the privileged provisioning itself, after validating everything against fixtures. Requirements:
- Dedicated SELECT-only `ukmesh_planner_reader` role.
- Additive, privacy-filtered `planner_export` views.
- No modifications to existing live data.
- No access to private nodes, message contents or credentials.
- Verify query plans and take an appropriate backup before applying changes.
- Apply during a quiet period with short lock timeouts.
- Abort and roll back if there is unexpected database contention or performance degradation.

Ben does not need to run the SQL manually.

**3. DNS and Cloudflare.** Handled entirely by the implementing AI. `planner.ukmesh.com` is added using the existing Cloudflare Tunnel infrastructure. Do not disrupt existing hostnames, ingress rules or services; back up the configuration; make the smallest necessary change; test; retain a rollback procedure.

**4. MissionDeck and subagent restrictions — absolute.** No MissionDeck agents, spawned subagents, delegated coding agents or delegated reviews for this project. Implementation, investigation, testing, debugging and review happen in the owning AI session itself. Normal command-line tools, scripts, test frameworks and direct tool calls are allowed. This explicitly overrides the usual delegation rules.

**5. Execution mode.** Continuous autonomous execution through to production acceptance, across sessions as necessary. Internal stage gates, automated tests and commits throughout; no stopping for routine approvals between development phases. Escalate only for: genuinely blocked permissions; destructive operations outside this approval; significant production risks; or decisions that cannot safely be resolved from the specification.

**6. Resource budget.** Measure actual VPS headroom first. Live UK Mesh has absolute priority over the planner. Establish enforceable CPU, RAM, disk and I/O limits based on those measurements. No unbounded workloads, no full-UK server-side RF recalculations, no uncontrolled terrain downloads. Expensive interactive RF computation belongs in the visitor's browser via WebGPU/WASM wherever practical. If the planner threatens production performance, throttle or suspend planner work automatically.

**Overall instruction.** Build the complete product, not a proof of concept. Own the implementation end to end, follow the build specification, and verify every acceptance criterion before reporting completion.

**Pre-flight snapshot** (read-only checks, 2026-10-13 — full Stage 0 recon still owed at execution start):
- Repo: public, `main`, currently empty; hermes-gadget write access confirmed.
- VPS `vps-0e251c4d` at capture: 8 vCPU · 22 GiB RAM · 193 GB root disk 77% used · load average ≈ 12.6 (high) · 67 running containers, including the live source DB `meshcore-infra-timescaledb-1` (healthy), the `meshcore-analytics-*` application stack, `meshcore-infra-mosquitto-1`, and multiple `cloudflared-*` tunnels. The existing Docker network set must not be disturbed.
- Hermes VM toolchain: node v22.22.2 · npm 11.19 · Docker 29.7 (compose v5.4) · git 2.43 · no local `psql` (fixture databases will be containerized).

**Status:** decisions recorded; no execution performed; awaiting Ben's go.
