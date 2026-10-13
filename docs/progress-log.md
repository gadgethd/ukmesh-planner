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
