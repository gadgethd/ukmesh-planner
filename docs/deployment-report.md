# Deployment report — ukmesh-planner (Stage 7)

Date: 2026-10-13 (Europe/London). Author: implementing agent (Hermes), per
BUILD-PLAN Stage 7. Everything below is real execution evidence; where a step
is blocked or was skipped it is called out explicitly.

## Released version

| Item | Value |
|---|---|
| Deployed commit | `bb85db4` (Stage 6c + three-tier config; full history in `git log`) |
| Previous release (rollback target) | `66b1182` — images kept tagged `:66b1182` on the host |
| Images | `ukmesh-planner-web:bb85db4`, `ukmesh-planner-api:bb85db4`, `ukmesh-planner-ingest:bb85db4` (plus `:latest`) |
| Host | UK Mesh VPS (`57.129.131.35`, SSH :32720), compose project `ukmesh-planner` (own network, own volume, 127.0.0.1-bound web port 3400) |
| Staged public URL | `https://ukmesh-planner.justarobot.uk` (Cloudflare tunnel `cf-tunnel-ukmesh-planner` → `http://localhost:3400`) |
| Intended final URL | `https://planner.ukmesh.com` — **blocked on DNS access, see Blockers** |

## CI / tests

- GitHub Actions CI (`ci.yml`) green on every push of this build: latest runs
  `38350492669` (`bb85db4`), `38349845441`, `38349605430`, `38349100336`.
- Local suites at release: web 61 tests / api 24 / rf-core 20 — all passing;
  `tsc --noEmit` clean in every workspace.
- E2E (real browser, via CDP): site placement → assessment (75 likely /
  225 blocked / 300 links drawn at the Newcastle test point), coverage
  heatmap (auto-selected **wasm** backend on a no-GPU browser, 65,536 cells),
  Advanced mode (topology 8,800 nodes / 6,930 components / 12,776 observed
  edges; profiles; candidate search; plan save/load/export; share lifecycle).
  Evidence: `~/ukmesh-planner-work/evidence/stage{3,4,5,6,7}/`.

## HTTPS verification (staged URL)

- `curl -s -o /dev/null -w %{http_code} https://ukmesh-planner.justarobot.uk/`
  → `200` (first attempt; no 1033 window), page title present.
- `/healthz` → `ok`; `/api/v1/config` → `{"computeBackends":["webgpu","wasm","cpu"], …}`
  with live snapshot `snap-20261013T051103Z-g810-bd64` (8,799 repeaters,
  37,103 links).
- Browser E2E through the public URL: assess, coverage (wasm), advanced mode
  all verified (screenshots in `evidence/stage7/`).

## Existing UK Mesh — pre/post health baseline

Stage 0 baseline (recorded in `docs/progress-log.md`) vs post-deploy now:

| Check | Baseline (Stage 0) | Post-deploy |
|---|---|---|
| https://ukmesh.com/ | 200 | 200 (0.08 s) |
| https://app.ukmesh.com/ | 200 | 200 (0.11 s) |
| https://healthcheck.ukmesh.com/ | 302 | 302 (0.11 s) |
| https://flasher.ukmesh.com/ | 200 | 200 (0.07 s) |

Resource envelope: load ≈ 11.3 (baseline ≈ 9.8, host runs 60–70 containers;
within normal variance), memory 7.8/23 GiB used, disk 79% (baseline 77% —
planner adds ~2 GB of images + planner DB). No live regression observed.

## Rollback test (executed)

1. Built and deployed previous commit `66b1182` (web + api) from a clean
   worktree; tagged `:66b1182` and `:rollback-66b1182`.
2. Verified reverted behaviour: `/api/v1/config` → `["webgpu","cpu"]` (old
   two-tier list), web 200, public `/healthz` ok.
3. Rolled forward to `bb85db4`: config → `["webgpu","wasm","cpu"]`, web 200,
   public URL healthy.

Rollback mechanism: rebuild any commit + `docker compose up -d` (or pin the
tagged image), verified working. Rebuild from source was chosen over image
pinning for the test because it also exercises the build path.

## Secrets, backups

- Deploy secrets live in `/home/ben/ukmesh-planner/.env` (mode 0600) plus
  provisioning files `env/planner.pw`, `env/reader.pw` (0600). No secret value
  appears in the repo, this report, or any log.
- Backup test: `pg_dump -Fc` (15.3 MB) → restore into scratch database →
  row counts identical (snapshots 6, repeaters 52,794, links 222,601,
  shares 3) → scratch dropped. Dump retained at
  `/home/ben/backups/ukmesh-planner/planner-test.dump`.

## Incident (recorded for honesty)

During the rollback test an `rsync --delete` with an exclude list that did not
match the dotfile deleted the deploy `.env` on the host. The running stack was
unaffected (compose refused to interpolate, so nothing was recreated). The
file was reconstructed from the running containers' environment
(`PLANNER_DB_PASSWORD`, `PLANNER_DB_URL`, `SOURCE_DB_READONLY_URL`), written
0600, and validated with `docker compose config`. The deploy runbook now bans
`--delete` for this deployment and lists explicit excludes.

## Blockers

**`planner.ukmesh.com` cannot be published from here.** The Cloudflare API
token available on the host (`.cf-api-token`) is scoped to `justarobot.uk`
only; it cannot create DNS records in, or configure tunnels for, `ukmesh.com`
(the zone is on Cloudflare, NS `watson/jo.ns.cloudflare.com`). The existing
`ukmesh.com` tunnel is dashboard-managed (token-run, no local config), so
adding a public hostname to it also requires dashboard access.

To publish the final domain, either:

1. In the Cloudflare dashboard: add a public hostname `planner.ukmesh.com` to
   the tunnel that serves the ukmesh hostnames, pointing at
   `http://localhost:3400` (the planner web on this host), and create the
   proxied CNAME; **or**
2. Provide an API token with `ukmesh.com` DNS+Tunnel edit rights — the same
   bring-up script used for the staged URL
   (`~/ukmesh-planner-work/cf-bring-up-ukmesh-planner.sh`) can then be re-run
   with `SUBDOMAIN=planner` and the ukmesh.com zone ID.

Until then the staged URL `https://ukmesh-planner.justarobot.uk` serves the
identical deployment. The compose `PUBLIC_ORIGIN` already defaults to
`https://planner.ukmesh.com` for the flip.

## Failed / skipped tests

- No test failures at release. Skipped: verification of the exact
  `planner.ukmesh.com` hostname (blocked above); cross-browser matrix is
  Chromium-family only (WebKit/Gecko not available in this environment — the
  WASM tier and precision-safe shader were built specifically to make
  results browser-independent).
