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
