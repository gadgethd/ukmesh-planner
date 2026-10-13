# Deploy runbook — ukmesh-planner (host: UK Mesh VPS)

Target: compose project `ukmesh-planner` on `57.129.131.35` (SSH :32720, user
`ben`), repo checkout at `/home/ben/ukmesh-planner` (synced from the dev VM;
the host tree is NOT a git checkout).

## Hard rules

- **Never** use `rsync --delete` for deploys. An exclude list that misses a
  dotfile will delete host-only files (this happened once to `.env`).
  Plain `-a` sync + explicit excludes is enough.
- Never touch any other compose project on this host; planner services only.
- Web binds `127.0.0.1:3400`; the public edge is a dedicated cloudflared
  tunnel (`cf-tunnel-ukmesh-planner`), not a shared one.

## Deploy a new version

```bash
# 1. from the dev VM — sync the tree (no --delete!)
rsync -az \
  --exclude .git --exclude node_modules --exclude dist \
  --exclude 'apps/*/coverage' --exclude 'packages/*/coverage' \
  --exclude .tokensave --exclude .env --exclude .github \
  -e "ssh -i ~/.ssh/id_ed25519 -p 32720" \
  ~/ukmesh-planner/ ben@57.129.131.35:/home/ben/ukmesh-planner/

# 2. on the host — build, tag with the commit SHA, deploy
cd /home/ben/ukmesh-planner
docker compose build web api ingest
for s in web api ingest; do docker tag ukmesh-planner-$s:latest ukmesh-planner-$s:<sha>; done
docker compose up -d

# 3. verify (internal + public)
curl -s http://127.0.0.1:3400/healthz                 # ok
curl -s http://127.0.0.1:3400/api/v1/config | head -c 200
curl -s https://ukmesh-planner.justarobot.uk/healthz  # ok
```

The api container takes ~15 s to pass its healthcheck after a restart — an
nginx 502 in that window is expected; re-check rather than debugging.

## Migrations

New `db/planner-migrations/*.sql` files apply manually (idempotent):

```bash
docker exec -i ukmesh-planner-db-1 psql -U planner -d planner \
  < /home/ben/ukmesh-planner/db/planner-migrations/000N_*.sql
```

## Rollback

Images are tagged per release (`:<sha>`). To roll back:

```bash
# rebuild the older commit's tree (sync it first), or pin its tag:
cd /home/ben/ukmesh-planner
docker compose up -d --force-recreate web api   # after syncing the old tree + build
```

Verified 2026-10-13: deploying `66b1182` reverted `/api/v1/config` to the old
two-tier list and rolled forward cleanly to `bb85db4`.

## Backup / restore (planner DB only)

```bash
mkdir -p /home/ben/backups/ukmesh-planner
docker exec ukmesh-planner-db-1 pg_dump -U planner -d planner -Fc \
  > /home/ben/backups/ukmesh-planner/planner-$(date +%Y%m%d).dump
# restore test into scratch:
docker exec ukmesh-planner-db-1 psql -U planner -d postgres -c 'create database planner_restore_test'
docker exec -i ukmesh-planner-db-1 pg_restore -U planner -d planner_restore_test < <dump>
# compare source_repeaters / source_observed_links / shares counts, then drop.
```

## Edge (cloudflared)

- Staged hostname: `ukmesh-planner.justarobot.uk` → `http://localhost:3400`.
- Tunnel: `cf-tunnel-ukmesh-planner` (http2 forced — this host's network
  blocks QUIC). Config + DNS are managed via the CF API
  (`~/ukmesh-planner-work/cf-bring-up-ukmesh-planner.sh`, idempotent).
- `planner.ukmesh.com` publish is blocked on ukmesh.com zone access — see
  `docs/deployment-report.md` → Blockers.
