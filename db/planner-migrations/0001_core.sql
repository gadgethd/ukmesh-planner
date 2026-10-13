-- 0001_core.sql — planner-owned datastore, core source-snapshot schema (v0).
--
-- Applied by: db/apply-migrations.sh (deploy/migration time) or Postgres
-- docker-entrypoint-initdb.d on first initialisation. Idempotent — safe to
-- re-run. This schema holds ONLY sanitized, privacy-fence-checked snapshots
-- published by the ingester; it never receives raw UK Mesh data.
--
-- Publish model: the ingester builds a snapshot row (status='building'),
-- inserts repeaters + links in one transaction, re-checks the privacy fence,
-- then flips status to 'published'. A partial unique index guarantees at most
-- one published snapshot at a time — readers always see exactly one coherent
-- dataset.

create table if not exists source_snapshots (
  id                text primary key,
  source_generation bigint not null,           -- privacy generation observed
  fence_checked_at  timestamptz not null,      -- last successful fence re-check
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'building'
                    check (status in ('building', 'published', 'superseded', 'failed')),
  repeater_count    integer not null default 0,
  link_count        integer not null default 0,
  notes             text
);

-- At most one published snapshot (atomic publish = flip this status in a txn).
create unique index if not exists source_snapshots_single_published
  on source_snapshots ((status)) where status = 'published';

create table if not exists source_repeaters (
  snapshot_id           text not null references source_snapshots(id) on delete cascade,
  canonical_id          text not null check (canonical_id ~ '^[0-9A-F]{64}$'),
  name                  text,
  lat                   double precision not null check (lat between -90 and 90),
  lon                   double precision not null check (lon between -180 and 180),
  last_seen             timestamptz,
  is_online             boolean not null default false,
  hardware_model        text,
  firmware_version      text,
  iata                  text,
  advert_count          integer not null default 0,
  identity_member_count integer not null default 1,
  primary key (snapshot_id, canonical_id)
);

create index if not exists source_repeaters_bbox
  on source_repeaters (snapshot_id, lat, lon);

create table if not exists source_observed_links (
  snapshot_id              text not null references source_snapshots(id) on delete cascade,
  source_id                text not null check (source_id ~ '^[0-9A-F]{64}$'),
  target_id                text not null check (target_id ~ '^[0-9A-F]{64}$'),
  observed_count           integer not null check (observed_count > 0),
  strong_observation_count integer not null default 0,
  count_a_to_b             integer not null default 0,
  count_b_to_a             integer not null default 0,
  last_observed            timestamptz not null,
  path_loss_db             double precision,
  itm_viable               boolean,
  force_viable             boolean,
  primary key (snapshot_id, source_id, target_id),
  check (source_id <> target_id)
);

create index if not exists source_observed_links_by_snapshot
  on source_observed_links (snapshot_id);
