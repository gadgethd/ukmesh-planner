-- 01_source_fixture.sql — synthetic stand-in for the live UK Mesh source schema.
--
-- Purpose: exercise db/source-export-provision/*.sql against realistic
-- semantics BEFORE touching the live database (build plan §11 Stage 2).
-- This is a *semantic replica*, not the production definition: it reproduces
-- the column shapes and privacy semantics the export views depend on —
-- canonical identity aliasing, member-wide 🚫 filtering, sightings-based
-- scope membership, directional link counts. All IDs are synthetic.
--
-- Scenario matrix baked into the data (see test-export.sh for assertions):
--   N1 '1'×64  public repeater, ukmesh, positioned            -> INCLUDED
--   N2 '2'×64  public repeater, legacy network 'northeast'    -> INCLUDED
--   N3 '3'×64  repeater, network 'test' + ukmesh sighting 2d  -> INCLUDED
--   N4 '4'×64  repeater, no scope, no sighting                -> EXCLUDED
--   N5 '5'×64  repeater, name carries 🚫 (direct private)     -> EXCLUDED
--   N6 '6'×64  repeater public name, but ALIAS member
--              '9'×64 named 'Alias 🚫 Hidden'                  -> EXCLUDED (member-wide)
--   N7 '7'×64  role NULL, positioned                          -> EXCLUDED
--   N8 '8'×64  role 2, no position                            -> EXCLUDED
--   N9 'a'×64  repeater, network 'test', no sighting          -> EXCLUDED
--   N10 'b'×64 prefix-registry private only (name CLEAN, but in
--              private_node_prefixes)                          -> EXCLUDED (union source 2)
--   Links: N1–N2 (kept), N2–N3 (kept), N1–N5 / N1–N6 / N3–N4 /
--          N3–N7 (all dropped by endpoint filters)

create table nodes (
  node_id         text primary key,
  name            text,
  lat             double precision,
  lon             double precision,
  role            integer,
  network         text not null default 'ukmesh',
  last_seen       timestamptz,
  is_online       boolean not null default false,
  hardware_model  text,
  firmware_version text,
  iata            text,
  advert_count    integer not null default 0
);

create table node_identity_aliases (
  source_node_id    text primary key,
  canonical_node_id text not null,
  confidence        text not null default 'high',
  reason            text not null default 'fixture',
  source_kind       text not null default 'automatic',
  updated_at        timestamptz not null default now()
);

create table node_network_sightings (
  node_id       text not null,
  network       text not null,
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  primary key (node_id, network)
);

create table node_links (
  node_a_id                text not null,
  node_b_id                text not null,
  observed_count           integer not null default 1,
  count_a_to_b             integer not null default 0,
  count_b_to_a             integer not null default 0,
  multibyte_observed_count integer not null default 0,
  itm_path_loss_db         double precision,
  itm_viable               boolean,
  force_viable             boolean not null default false,
  last_observed            timestamptz not null default now(),
  primary key (node_a_id, node_b_id)
);

create table private_node_prefixes (
  node_id           text not null,
  network           text not null,
  prefix_size_bytes integer not null,
  prefix            text not null,
  updated_at        timestamptz not null default now(),
  primary key (node_id, network, prefix_size_bytes)
);

create table public_visibility_state (
  singleton  boolean primary key default true check (singleton),
  generation bigint not null default 1,
  updated_at timestamptz not null default now()
);
insert into public_visibility_state (singleton, generation) values (true, 810);

-- Canonical identity resolution (semantics from migration 036). Present for
-- schema fidelity; the fixture views below deliberately avoid calling it —
-- functions invoked from views execute as the view user.
create or replace function meshcore_canonical_node_id(input_node_id text)
returns text language sql stable parallel safe as $$
  select case
    when input_node_id is null or btrim(input_node_id) = '' then input_node_id
    else coalesce(
      (select alias.canonical_node_id
         from node_identity_aliases alias
        where alias.source_node_id = upper(btrim(input_node_id))),
      upper(btrim(input_node_id)))
  end
$$;

-- Canonical nodes view (simplified representative rules; the columns the
-- export surface consumes are identical to the production view). Set-based
-- alias joins only — no function calls — mirroring migration 037, because
-- functions invoked from views run with the view user's privileges.
create or replace view node_identity_nodes as
with mapped as (
  select n.*,
         coalesce(a.canonical_node_id, upper(btrim(n.node_id))) as canonical_node_id
  from nodes n
  left join node_identity_aliases a
    on a.source_node_id = upper(btrim(n.node_id))
),
ranked as (
  select m.*,
         row_number() over (
           partition by m.canonical_node_id
           order by
             case
               when m.role = 2 and m.lat between -90 and 90 and m.lon between -180 and 180
                    and not (abs(m.lat) < 1e-9 and abs(m.lon) < 1e-9) then 0
               when m.role = 2 then 1
               when coalesce(m.advert_count, 0) > 0 then 2
               else 3
             end,
             coalesce(m.advert_count, 0) desc,
             m.last_seen desc nulls last,
             m.node_id
         ) as representative_rank
  from mapped m
),
aggregated as (
  select canonical_node_id,
         bool_or(coalesce(is_online, false)) as is_online,
         max(last_seen) as last_seen,
         sum(coalesce(advert_count, 0))::integer as advert_count,
         array_agg(node_id order by node_id) as identity_source_ids,
         count(*)::integer as identity_member_count
  from mapped
  group by canonical_node_id
)
select r.canonical_node_id as node_id,
       r.name, r.lat, r.lon, r.last_seen,
       a.is_online, r.hardware_model, r.firmware_version, r.iata, r.role,
       a.advert_count, r.network,
       a.identity_source_ids, a.identity_member_count
from ranked r
join aggregated a on a.canonical_node_id = r.canonical_node_id
where r.representative_rank = 1;

create or replace view node_identity_sightings as
select coalesce(a.canonical_node_id, upper(btrim(s.node_id))) as node_id,
       s.network,
       min(s.first_seen_at) as first_seen_at,
       max(s.last_seen_at) as last_seen_at
from node_network_sightings s
left join node_identity_aliases a
  on a.source_node_id = upper(btrim(s.node_id))
group by 1, 2;

create or replace view node_identity_links as
with mapped as (
  select coalesce(la.canonical_node_id, upper(btrim(l.node_a_id))) as raw_a,
         coalesce(lb.canonical_node_id, upper(btrim(l.node_b_id))) as raw_b,
         l.observed_count, l.last_observed, l.itm_path_loss_db, l.itm_viable,
         l.force_viable, l.count_a_to_b, l.count_b_to_a, l.multibyte_observed_count
  from node_links l
  left join node_identity_aliases la on la.source_node_id = upper(btrim(l.node_a_id))
  left join node_identity_aliases lb on lb.source_node_id = upper(btrim(l.node_b_id))
),
oriented as (
  select least(raw_a, raw_b) as node_a_id,
         greatest(raw_a, raw_b) as node_b_id,
         observed_count, last_observed, itm_path_loss_db, itm_viable, force_viable,
         case when raw_a <= raw_b then count_a_to_b else count_b_to_a end as count_a_to_b,
         case when raw_a <= raw_b then count_b_to_a else count_a_to_b end as count_b_to_a,
         multibyte_observed_count
  from mapped
  where raw_a <> raw_b
)
select node_a_id, node_b_id,
       sum(observed_count)::integer as observed_count,
       max(last_observed) as last_observed,
       min(itm_path_loss_db) as itm_path_loss_db,
       bool_or(itm_viable) as itm_viable,
       bool_or(force_viable) as force_viable,
       sum(count_a_to_b)::integer as count_a_to_b,
       sum(count_b_to_a)::integer as count_b_to_a,
       sum(multibyte_observed_count)::integer as multibyte_observed_count
from oriented
group by node_a_id, node_b_id;

-- ---------------------------------------------------------------------------
-- Scenario data
-- ---------------------------------------------------------------------------

insert into nodes (node_id, name, lat, lon, role, network, last_seen, is_online, hardware_model, firmware_version, iata, advert_count) values
  (repeat('1', 64), 'Public One',        54.9700, -1.6100, 2,    'ukmesh',    now() - interval '5 minutes', true,  'Heltec V3', '1.10.0', 'NCL', 20),
  (repeat('2', 64), 'Legacy Two',        54.7800, -1.5700, 2,    'northeast', now() - interval '1 hour',    true,  'RAK4631',   '1.10.0', 'DUR', 14),
  (repeat('3', 64), 'Sighted Three',     55.0100, -1.4300, 2,    'test',      now() - interval '2 days',    false, 'Heltec V3', '1.9.3',  'NCL',  6),
  (repeat('4', 64), 'Lonely Four',       53.9000, -3.0000, 2,    'othernet',  now() - interval '3 days',    false, 'T-Beam',    '1.8.0',  null,   2),
  (repeat('5', 64), 'Secret 🚫 Five',     54.5000, -2.2000, 2,    'ukmesh',    now() - interval '1 day',     true,  'Heltec V3', '1.10.0', 'MAN', 30),
  (repeat('6', 64), 'Aliased Six',       55.2000, -2.5000, 2,    'ukmesh',    now() - interval '3 hours',   true,  'Station G2', '1.10.0', 'EDI', 5),
  (repeat('9', 64), 'Alias 🚫 Hidden',    55.2001, -2.5001, 2,    'ukmesh',    now() - interval '3 hours',   true,  'Station G2', '1.10.0', 'EDI', 1),
  (repeat('7', 64), 'Not A Repeater',    54.2000, -2.0000, null, 'ukmesh',    now() - interval '1 day',     false, null,        null,     null,   9),
  (repeat('8', 64), 'Unpositioned',      null,    null,    2,    'ukmesh',    now() - interval '2 hours',   true,  'T-Beam',    '1.9.0',  null,   3),
  (repeat('a', 64), 'Test Node',         54.1000, -1.6000, 2,    'test',      now() - interval '6 hours',   true,  'Heltec V3', '1.10.0', 'LDS',  1),
  (repeat('b', 64), 'Prefix Only Ten',   54.6000, -1.8000, 2,    'ukmesh',    now() - interval '4 hours',   true,  'Heltec V3', '1.10.0', 'NCL',  4);

-- N10: private via the prefix registry only (simulates registry/marker divergence).
insert into private_node_prefixes (node_id, network, prefix_size_bytes, prefix) values
  (repeat('b', 64), 'ukmesh', 1, 'BB'),
  (repeat('b', 64), 'ukmesh', 2, 'BBBB'),
  (repeat('b', 64), 'ukmesh', 3, 'BBBBBB');

-- The alias that merges '9'×64 into canonical '6'×64 (private member).
insert into node_identity_aliases (source_node_id, canonical_node_id)
values (repeat('9', 64), repeat('6', 64));

-- N3's ukmesh sighting (pulls it into scope via the sighting rule).
insert into node_network_sightings (node_id, network, first_seen_at, last_seen_at)
values (repeat('3', 64), 'ukmesh', now() - interval '40 days', now() - interval '2 days');

insert into node_links (node_a_id, node_b_id, observed_count, count_a_to_b, count_b_to_a, multibyte_observed_count, itm_path_loss_db, itm_viable, last_observed) values
  (repeat('1', 64), repeat('2', 64), 40, 30, 10, 12, 118.4, true,  now() - interval '10 minutes'),
  (repeat('2', 64), repeat('3', 64),  3,  2,  1,  0, 120.5, true,  now() - interval '1 day'),
  (repeat('1', 64), repeat('5', 64),  5,  3,  2,  0, null,  null,  now() - interval '2 hours'),
  (repeat('1', 64), repeat('6', 64),  7,  4,  3,  1, null,  null,  now() - interval '3 hours'),
  (repeat('3', 64), repeat('4', 64),  2,  1,  1,  0, null,  null,  now() - interval '2 days'),
  (repeat('3', 64), repeat('7', 64),  2,  1,  1,  0, null,  null,  now() - interval '2 days'),
  (repeat('1', 64), repeat('b', 64),  4,  3,  1,  0, null,  null,  now() - interval '4 hours');
