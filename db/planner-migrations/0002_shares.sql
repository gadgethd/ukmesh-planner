-- 0002_shares.sql — planner-owned plan shares (stage 6).
--
-- Applied by: db/apply-migrations.sh (deploy/migration time). Idempotent —
-- safe to re-run.
--
-- Privacy model: plans are shared on an OPT-IN basis only — a row exists
-- only because a visitor explicitly asked to share one. `id` is an
-- unguessable UUID (unguessability is the access control; there is no
-- listing endpoint). The TTL in `expires_at` is enforced on read, so an
-- expired share is never served even if the row still exists. Revocation
-- is permanent: `revoked_at` is set once and never cleared. No other
-- personal data is stored — the row holds the serialized plan, the TTL and
-- the revoke token, nothing else.

create table if not exists shares (
  id           text primary key,                 -- unguessable UUID (crypto.randomUUID)
  plan         jsonb not null,                   -- the visitor's serialized plan
  revoke_token text not null,                    -- secret held only by the sharer
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,             -- TTL, enforced on read
  revoked_at   timestamptz                       -- set once; revocation is permanent
);

create index if not exists shares_expires_at on shares (expires_at);
