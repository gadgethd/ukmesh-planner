# Host inventory & capacity notes (Stage 0 recon)

Read-only measurements, 2026-10-12/13. No secrets in this document.

## Projects VPS (deployment target for the planner)

| Item | Value |
|---|---|
| Hostname | `vps-0e251c4d` (Projects VPS) — `ben@57.129.131.35:32720` |
| CPU | 8 vCPU (Intel Haswell, 1 thread/core) |
| RAM | 22 GiB total; 7–8 GiB used, ~15 GiB available; buff/cache ~11–12 GiB |
| Swap | **none configured** |
| Disk | `/dev/sda1` 193 GB, 148 GB used (77 %), 46 GB free |
| Kernel | 7.0.0-14-generic; up 68 days |
| Docker | 29.7.1; ~67 running containers; 15 networks |
| Load at recon | ≈ 9.8 (hopreach ≈ 4 cores steady + Postgres workers) |

### Key workloads (baseline consumers; planner must not disturb)

- `meshcore-analytics-hopreach-1` — ~400 % CPU steady (native RF calculator).
- `meshcore-infra-timescaledb-1` — ~100 %+ busy periods; 19 GB db; `max_connections=300`.
- `meshcore-analytics-*` — backend, workers (path-learning, link, health,
  tagger, privacy-remat), prometheus/grafana/loki/alloy, exporters.
- `meshcore-beacon-*`, `meshcore-discord-bot`, `corescope*`, `mqttbench*`,
  `wikijs`, personal sites (`cf-tunnel-*`), `uptime-kuma`, `status-feeder`.
- Compose projects: `meshcore-analytics` (24 containers, overlay `docker-compose.live.yml`),
  `meshcore-infra` (5), `cloudflared` (4), plus others — see evidence `recon.out.txt`.

### Networking

- Shared bridge `meshcore-analytics_default` = **172.30.0.0/24**, external for
  the analytics compose; static IPs in use: `.10/.11/.12` (proxies),
  `.20/.21/.22` (anubis), `.30` (cloudflared), `.129–.159` (dynamic pool in use).
  **Planner must not pick a static IP; attach dynamically or use its own network
  + one attach-only ingester.**
- Edge: multiple `cloudflared` containers; all token-based (`TUNNEL_TOKEN`),
  **HTTP2 forced** (provider blocks QUIC/UDP). `cloudflared-http2` (analytics
  compose) serves the ukmesh hostnames.
- Host sleeps: none — treat as always-on.

### Ports in use (host-loopback)

- `127.0.0.1:3000` backend · `:3003` app-ukmesh · `:3004` website-ukmesh ·
  `:9092` analytics prometheus · plus personal stacks. Planner will use its own
  ports (allocated at deploy time, 127.0.0.1-bound).

### Terrain data

- `/home/ben/ukmesh/meshcore-analytics/terrain-tiles` — 2.7 GB, z0–12,
  Terrarium PNGs (AWS Open Data `elevation-tiles-prod`), read-only mounted into
  nginx containers. Licence/attribution check tracked in decisions (D-004).

## Hermes VM (development environment)

- Ubuntu 24.04, node v22.22.2, npm 11.19, Docker 29.7 + compose v5.4, git 2.43.
- No local `psql` — fixture databases will run containerised Postgres/PostGIS.
- Work root: `~/ukmesh-planner-work/` (evidence, STATE.md). Repo: `~/ukmesh-planner`.

## Capacity / budget implications (draft — finalised in Stage 7)

- Live UK Mesh has absolute priority (§16.6). Planner targets: interactive
  RF compute in the visitor's browser only; server side = small API + snapshot
  store + static assets.
- Draft caps (to be enforced via compose `cpus`/`mem_limit`): planner-db ≤ 512 MiB,
  api ≤ 256 MiB, web ≤ 128 MiB, ingest ≤ 256 MiB (bounded ≤2 DB connections,
  statement timeouts). Total planner footprint target < ~1.2 GiB RAM, near-zero
  steady CPU. Re-measured and applied at deploy.
- No planner-side national RF compute, no GPU, no unbounded terrain downloads
  (§16.6). Planner auto-throttle/suspend hook if it threatens production.
