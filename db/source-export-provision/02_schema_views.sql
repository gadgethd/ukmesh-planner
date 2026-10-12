-- 02_schema_views.sql — planner_export schema + the sanctioned read views (v1).
--
-- Additive only. Requires the reader role from 01_reader_role.sql. Idempotent
-- (CREATE OR REPLACE). Apply with:
--   psql "$SOURCE_ADMIN_URL" -v ON_ERROR_STOP=1 -f 02_schema_views.sql
--
-- Privacy rules implemented here (docs/integration/source-contract.md §4/§7):
--   * scope:     representative network in (ukmesh, northeast, teesside),
--                or a ukmesh-scope sighting within the last 30 days
--   * repeater:  role = 2, positioned, valid non-zero coordinates
--   * privacy:   NO member of a canonical identity may carry the 🚫 marker
--                (member-wide check — stricter than the site's minimum)
--   * links:     BOTH endpoints must resolve to published repeaters
--
-- Views execute with their owner's privileges (Postgres default), so the
-- reader needs only USAGE on the schema + SELECT on these views.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema if not exists planner_export;

-- Canonical identities with any private member (🚫 in any member's name).
-- Small table in practice (~tens of rows) — cheap to materialize per query.
create or replace view planner_export.public_repeaters_v1 as
with private_canonicals as materialized (
  -- Canonical ids of every identity with a private member. Uses the alias
  -- LEFT JOIN directly rather than meshcore_canonical_node_id(): functions
  -- called from a view execute as the VIEW USER, and the reader must never
  -- need raw-table access. (Same set-based pattern as migration 037.)
  select distinct coalesce(a.canonical_node_id, upper(btrim(n.node_id))) as canonical_id
  from nodes n
  left join node_identity_aliases a
    on a.source_node_id = upper(btrim(n.node_id))
  where n.name like '%🚫%'
)
select c.node_id          as canonical_id,
       c.name,
       c.lat,
       c.lon,
       c.last_seen,
       c.is_online,
       c.hardware_model,
       c.firmware_version,
       c.iata,
       c.advert_count,
       c.identity_member_count
from node_identity_nodes c
where c.role = 2
  and c.lat between -90 and 90
  and c.lon between -180 and 180
  and not (abs(c.lat) < 1e-9 and abs(c.lon) < 1e-9)
  and (
    c.network in ('ukmesh', 'northeast', 'teesside')
    or exists (
      select 1
      from node_identity_sightings s
      where s.node_id = c.node_id
        and s.network in ('ukmesh', 'northeast', 'teesside')
        and s.last_seen_at > now() - interval '30 days'
    )
  )
  and not exists (
    select 1 from private_canonicals p where p.canonical_id = c.node_id
  );

create or replace view planner_export.public_observed_links_v1 as
with published as materialized (
  select canonical_id from planner_export.public_repeaters_v1
)
select l.node_a_id                as source_id,
       l.node_b_id                as target_id,
       l.observed_count,
       l.multibyte_observed_count as strong_observation_count,
       l.count_a_to_b,
       l.count_b_to_a,
       l.last_observed,
       l.itm_path_loss_db         as path_loss_db,
       l.itm_viable
from node_identity_links l
join published pa on pa.canonical_id = l.node_a_id
join published pb on pb.canonical_id = l.node_b_id
where l.observed_count > 0;

create or replace view planner_export.visibility_fence_v1 as
select generation,
       updated_at,
       now() as queried_at
from public_visibility_state
where singleton = true;

-- Privacy hardening: no predicate pushdown secrets for these views.
alter view planner_export.public_repeaters_v1 set (security_barrier = true);
alter view planner_export.public_observed_links_v1 set (security_barrier = true);

-- Access: exactly USAGE + SELECT-on-these-three for the reader; nothing public.
revoke all on schema planner_export from public;
revoke all on all tables in schema planner_export from public;

grant usage on schema planner_export to ukmesh_planner_reader;
grant select on planner_export.public_repeaters_v1 to ukmesh_planner_reader;
grant select on planner_export.public_observed_links_v1 to ukmesh_planner_reader;
grant select on planner_export.visibility_fence_v1 to ukmesh_planner_reader;

commit;
