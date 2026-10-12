-- sample_snapshot.sql — development/test fixture for the planner datastore.
-- Synthetic data only (no real UK Mesh nodes). Three repeaters in the
-- north-east of England, two observed links. Safe to apply repeatedly.
--
-- Usage: psql "$PLANNER_DB_URL" -f db/fixtures/sample_snapshot.sql

begin;

insert into source_snapshots
  (id, source_generation, fence_checked_at, finished_at, status, repeater_count, link_count, notes)
values
  ('fixture-0001', 810, now(), now(), 'published', 3, 2, 'development fixture')
on conflict (id) do nothing;

-- Deterministic synthetic canonical IDs (repeat('A',64) etc. — not real keys).
insert into source_repeaters
  (snapshot_id, canonical_id, name, lat, lon, last_seen, is_online,
   hardware_model, firmware_version, iata, advert_count, identity_member_count)
values
  ('fixture-0001', repeat('A', 64), 'Fixture RPT North',  54.9700, -1.6100, now() - interval '5 minutes',  true,  'Heltec V3',  '1.10.0', 'NCL', 12, 1),
  ('fixture-0001', repeat('B', 64), 'Fixture RPT Central', 54.7800, -1.5700, now() - interval '2 hours',   true,  'RAK4631',    '1.10.0', 'DUR',  5, 2),
  ('fixture-0001', repeat('C', 64), 'Fixture RPT Coast',   54.9000, -1.3800, now() - interval '8 days',    false, 'Heltec V3',  '1.9.3',  'SUN',  2, 1)
on conflict (snapshot_id, canonical_id) do nothing;

insert into source_observed_links
  (snapshot_id, source_id, target_id, observed_count, strong_observation_count,
   count_a_to_b, count_b_to_a, last_observed, path_loss_db, itm_viable)
values
  ('fixture-0001', repeat('A', 64), repeat('B', 64), 42, 30, 25, 17, now() - interval '10 minutes', 118.4, true),
  ('fixture-0001', repeat('B', 64), repeat('C', 64), 11,  4,  7,  4, now() - interval '3 days',     132.9, null)
on conflict (snapshot_id, source_id, target_id) do nothing;

commit;
