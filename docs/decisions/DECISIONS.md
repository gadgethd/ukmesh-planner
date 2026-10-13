# Decision log — ukmesh-planner

Format: `D-nnn — title — decision — rationale — date`.

**D-001 — Zero delegation.** Built entirely in the owning Hermes session; no
MissionDeck, no subagents, no delegated coding/review agents (plan §16.4,
explicitly overriding the usual delegation ladder). Ordinary CLI tools,
scripts, test frameworks and direct tool calls only. — 2026-10-13.

**D-002 — VPS working tree is authoritative over GitHub.** The VPS
`~/ukmesh/meshcore-analytics` tree carries unpushed work (incl. migrations
055/057–060 that define the live schema) and is ahead of GitHub where they
disagree (Ben, 2026-10-13). A read-only snapshot lives at
`~/ukmesh-vps-snapshot/` on the Hermes VM; per-file divergence is recorded in
`~/ukmesh-planner-work/evidence/diff-github-vs-vps.txt`. GitHub `e0a27db` is
cross-check only. — 2026-10-13.

**D-003 — Clean-room RF implementation; no HopReach code reuse.** HopReach
(in-tree at `third_party/hopreach`) is AGPL-3.0 + Commons Clause
(non-commercial, no sale; network-service source obligations). The planner
implements its own CPU/JS/WASM/WebGPU maths against documented equations, using
HopReach only as a *behavioural* reference (interfaces, limits, reported
numbers) — no code, no shaders, no fixtures copied. Licence of this repository
deliberately left undecided until the dependency/licence review completes
(plan §1.6/§12). — 2026-10-13.

**D-004 — Terrain tiles reused from the existing set, read-only.** Planner
serves `/terrain-tiles/{z}/{x}/{y}.png` from a read-only bind of the existing
`~/ukmesh/meshcore-analytics/terrain-tiles` directory (no 2.7 GB duplicate; no
unbounded proxying of the live site). Attribution/licence text to be surfaced
in the planner UI (open item). — 2026-10-13.

**D-005 — Network topology.** Planner runs its own compose project
(`ukmesh-planner`) with its own bridge network. **Only the ingester** gets an
additional attach to the external `meshcore-analytics_default` network (for
`meshcore-infra-timescaledb-1` access), attached **dynamically** — no static
172.30.0.0/24 address. Frontend/API/DB are not on that network. — 2026-10-13.

**D-006 — Source DB access path.** Provisioning: `docker exec … psql` as
`meshcore` (superuser) via reviewed, fixture-tested, additive SQL. Runtime:
dedicated `ukmesh_planner_reader` (SELECT on three `planner_export` views only,
read-only transactions, timeouts, connlimit ≤ 2), used solely by the ingester.
— 2026-10-13.

**D-007 — Staged delivery with internal gates.** Trunk `main` always green;
feature branches per stage; CI (tests + build) gates every merge; no direct
deployment of unvalidated builds; separate planner stack so rollback can never
touch live UK Mesh. — 2026-10-13.

**D-008 — Dataset scope = full published snapshot.** The planner serves and
displays the complete published repeater set (currently 8,798) with no implicit
spatial filter; the dataset legitimately contains continental repeaters
(NL/BE/FR/DE) and a handful of stray/junk coordinates, matching the live map's
data. `bbox` remains an explicit query parameter for bounded reads. — 2026-10-13.

**D-009 — Terrain sampling semantics.** Terrarium z12, bilinear; sea/river
bathymetry values used as-is; NODATA ⇒ `unknown-terrain` (fail closed); local
tile coordinates clamped to [0,255] (≤ 1 px error) so tile-edge samples are
never misreported as missing; transient tile failures retried once, never
cached as missing. Full text: docs/rf/model-assumptions.md. — 2026-10-13.

**D-010 — Overlay install is event-order independent.** Sources/layers install
idempotently on `styledata`, `load` and `idle` rather than `load` alone, so a
style event reordering can never leave a rendered-but-empty map. — 2026-10-13.
