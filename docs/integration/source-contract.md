# Source contract — UK Mesh → ukmesh-planner

**Status:** Stage 0 draft — verified read-only against live systems 2026-10-12/13.
**Authority:** where the VPS working tree differs from GitHub, the VPS tree is
authoritative (Ben, 2026-10-13). VPS tree HEAD `1f94bd8e` + uncommitted changes;
read-only snapshot `~/ukmesh-vps-snapshot/` (Hermes VM). GitHub `gadgethd/ukmesh`
main `e0a27db` used for cross-check only.

> Rule for the planner: **never read this database through public UK Mesh APIs**.
> Integration is direct, read-only, through `planner_export` views only (§7).

## 1. Source system (live, verified)

| Thing | Value |
|---|---|
| Host | `vps-0e251c4d` (Projects VPS, `ben@57.129.131.35:32720`) |
| Resources | 8 vCPU / 22 GiB RAM / 193 GB SSD (77 % used at recon) / **no swap** / load ≈ 9–10 during recon |
| DB container | `meshcore-infra-timescaledb-1`, network `meshcore-analytics_default`, IP 172.30.0.130 |
| Engine | **PostgreSQL 16.11 + TimescaleDB 2.25.1** — *no PostGIS* |
| Database | `meshcore` ≈ 19 GB; other DBs: `meshcore_owner_auth`, `corescope_*`, `beacon_*` |
| Access | `docker exec meshcore-infra-timescaledb-1 psql -U meshcore -d meshcore` (Unix-socket trust in-container; `meshcore` is SUPERUSER) |
| Counts @ recon | identities 17,252 · links (matview) 165,015 (14,321 in 30 d) · sightings 32,037 · aliases 117 · private prefixes 126 · `public_visibility_state.generation` = 810 |

## 2. Canonical identity model (migrations 036/037, live-verified)

- `nodes` — raw rows keyed by 64-hex `node_id` (one physical device may appear
  under several keys: re-keys, corrupted advert keys, observer/status key vs
  advert key).
- `node_identity_aliases` — `source_node_id → canonical_node_id`
  (confidence high|medium, `source_kind` automatic|manual) + `node_identity_match_evidence`.
- `meshcore_canonical_node_id(text)` — resolves alias → canonical, else
  `UPPER(BTRIM(id))`.
- `node_identity_nodes` (view, live columns verified): one row per canonical
  identity; representative member chosen in order — `role=2` + positioned →
  `role=2` → advert_count>0 → else; aggregates `is_online` (bool_or),
  max last_seen/last_* timestamps, Σadvert_count, **`identity_source_ids`
  (member node_ids)** and `identity_member_count`.
- `node_identity_sightings` (MATERIALIZED view, refreshed every 15 min by host
  cron): canonical id × network × first/last seen, over `node_network_sightings`.
- `node_identity_links` (MATERIALIZED view, refreshed every 15 min): canonical
  unordered pairs with `observed_count, last_observed, itm_path_loss_db,
  itm_viable, itm_computed_at, count_a_to_b, count_b_to_a, force_viable,
  multibyte_observed_count`.
- Stable canonical ID is the join key for the planner; never invent physical
  repeaters by counting alias rows.

## 3. Membership & scope rules (mirror exactly)

- **Production scope** = `network IN ('ukmesh','northeast','teesside')`
  (historical labels retained; `networks.ts` — "UKMESH_NETWORKS"). `test`
  traffic always excluded (also `topic_prefix <> 'meshcore-test'` defence).
- **UK membership** for a node = `network` in scope OR a sighting in
  `node_identity_sightings` with network in scope and `last_seen_at` within
  30 days (source of the existing `NODE_WHERE` in `hopreachCompatibility.ts`).
- **Repeater** = `role = 2`. Positioned = `lat/lon NOT NULL`, in-range and not
  (0,0). Do not include role-null nodes as repeaters.

## 4. Privacy model (authoritative summary — all live-verified)

1. **Private marker** – a raw node row is private iff `name LIKE '%🚫%'`.
   This is the *minimum* rule; the planner must apply it to **every member**
   of a canonical identity (`identity_source_ids`), not only the representative.
2. **Prefix materialization** – `private_node_prefixes` holds 1/2/3-byte key
   prefixes per private node (trigger `sync_private_node_prefixes` on `nodes`).
   Path-hash privacy: `meshcore_path_matches_private(network, rx, src, hashes, size)`
   and validity `meshcore_path_is_valid(...)` (both definitions captured).
3. **Privacy generation fence** – `public_visibility_state` (singleton row,
   `generation BIGINT`) is bumped when any node's private status *changes*
   (trigger; alias/prefix tables have their own statement triggers). The row
   is a **privacy fence, not an inventory revision counter** (migration 041).
4. **Packet fence** – packet-level visibility = `visibility_ok AND is_private
   IS NOT TRUE` AND the packet-visibility materialization generation equals
   the current generation AND no pending/failed entry in
   `privacy_rematerialization_queue` matching the packet (node / prefix match).
5. **Consumer pattern** – public caches are keyed by visibility generation and
   re-checked before serving (`topology.ts` loader; `bump → clear cache`).
6. **Planner obligations** — fail closed: if the fence cannot be verified,
   serve no identifying geometry; treat generation change as cache-purge
   signal; never derive private geometry from secondary data; plan references
   use stable IDs resolved through the *current* filter.

## 5. Observed links — semantics

- `node_links` (base) → `node_identity_links` (matview) as §2. Directional
  counts `count_a_to_b` / `count_b_to_a` rotate with canonical ordering —
  preserve per-canonical direction when exporting.
- `itm_*` fields are offline model output (ITM propagation), evidence class =
  modelled; observed evidence = the count fields + `last_observed`.
- Public adapter semantics (reference only, not reused code): `bottleneck =
  LEAST(count_a_to_b, count_b_to_a)` when both > 0 else 0; `bidir = both > 0`;
  default public window 30 days; 250k row cap.
- A link row is evidence of packet reception, **not** proof of reciprocal RF
  viability; expose directionality explicitly.

## 6. Public APIs — reference only, never the planner's data source

`/api/nodes/map` (paginated, freshness-limited, byte-budgeted),
`/api/topology` (bounded ≤500), HopReach `/hopreach` adapter (internal-only,
network-restricted), `/coverage/planned` (retired, 410). The planner reads the
database directly via its own export views.

## 7. Export surface — `planner_export` v1 (to be built in Stage 2)

```text
planner_export.public_repeaters_v1
  – SELECT from node_identity_nodes
  – WHERE role = 2 AND positioned AND scope-membership (§3)
  – AND canonical privacy pass: NOT EXISTS member in identity_source_ids with
    name LIKE '%🚫%'  (plus future source visibility policy)
  – columns: canonical id, name (sanitised for display), lat, lon, last_seen,
    is_online, hardware_model, firmware_version, iata, advert_count,
    identity_member_count, scope_sources

planner_export.public_observed_links_v1
  – node_identity_links JOIN public_repeaters_v1 on BOTH endpoints (both must pass)
  – columns: a, b, observed_count, count_a_to_b, count_b_to_a,
    multibyte_observed_count, last_observed, itm_path_loss_db, itm_viable

planner_export.visibility_fence_v1
  – generation, updated_at, queried_at (volatile)
```

Permissions (approved plan §16): dedicated `ukmesh_planner_reader` — LOGIN,
`default_transaction_read_only=on`, `statement_timeout`, idle-transaction
timeout, `CONNECTION LIMIT ≤ 2`; `USAGE` on schema, `SELECT` on the three
views only; `security_barrier` on views; PUBLIC revoked. Provisioning is
**additive only**, fixture-tested first, applied in a quiet window with
`lock_timeout`, with a tested rollback.

## 8. Source files inspected (VPS snapshot paths)

`backend/src/db/migrations/036_node_identity_merge.sql`, `037_…_view_perf.sql`,
`015/016/026/041/042/049/051/056…`; `backend/src/api/utils/privateNode.ts`,
`networkFilters.ts`; `backend/src/analysis/publicationFence.ts`;
`backend/src/api/routes/{nodes,topology}.ts`; `backend/src/api/hopreachCompatibility.ts`;
`backend/src/networks.ts`; `backend/src/repositories/networkAnalysis.ts`;
`frontend/src/components/Map/mapConfig.ts`; `rf-coverage/config.ukmesh.yaml`;
`scripts/fetch-terrain-tiles.sh`; `TERRAIN-V6-REPORT.md`; plus live-DB
introspection (`evidence/db-deepdive.out.txt`).

## 9. Open verification items (Stage 2 — before provisioning)

1. Exact scope of the alias/prefix statement triggers (migration 039) for the
   planner fence signal set.
2. Trace the link pipeline (`packet_paths` → `node_links`) to confirm path
   privacy inheritance for link rows.
3. `EXPLAIN` the two export views against live data (read-only, bounded).
4. Confirm matview refresh ownership stays solely with the existing cron.
5. Byte-budget / freshness details of `/api/nodes/map` cross-check only.

## Reader & query contract — as applied 2026-10-13

- Role `ukmesh_planner_reader`: LOGIN (password lives only in the host env
  file, mode 0600), `default_transaction_read_only=on`, `statement_timeout=10s`,
  `idle_in_transaction_session_timeout=15s`, `lock_timeout=3s`, connection
  limit 2, no superuser/createdb/createrole/bypassrls, and
  `enable_nestloop=off` as a session default.
- Views: `planner_export.public_repeaters_v1`,
  `planner_export.public_observed_links_v1`,
  `planner_export.visibility_fence_v1`. Maintenance: CREATE OR REPLACE only;
  grants = USAGE on schema + SELECT on those three views.
- Why `enable_nestloop=off`: row estimates on `node_identity_nodes` collapse to
  ~1 row, so a nested-loop plan over the links view explodes (~389,000ms vs
  513ms measured). The role default makes every reader session safe; the
  ingester additionally issues `SET LOCAL enable_nestloop = off` per
  transaction as belt-and-braces.
- Measured cost (2026-10-13, under steady hopreach load): repeaters ~296ms,
  links ~513ms, fence ~6ms. Counts at apply: 8,797 repeaters / 37,075 links.
- Ingest transport: host `meshcore-infra-timescaledb-1` (alias `timescaledb`)
  on docker network `meshcore-analytics_default` (172.30.0.0/24), port 5432,
  scram. The port is published only on the host's 127.0.0.1 — never public.
- Privacy sources enforced: the 🚫 name marker AND the
  `private_node_prefixes` registry, applied member-wide across canonical
  identities (stricter than the site's per-row minimum).
- Rollback: `db/source-export-provision/99_rollback.sql` — additive removal
  only, no source data touched.
