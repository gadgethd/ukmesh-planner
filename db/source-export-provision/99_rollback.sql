-- 99_rollback.sql — reverse the planner export provisioning (additive rollback).
--
-- Drops ONLY: the three planner_export views, the planner_export schema, and
-- the ukmesh_planner_reader role. Touches NO source data. This is the
-- reviewed rollback for the provisioning step (source-contract §7).
--
-- Usage: psql "$SOURCE_ADMIN_URL" -v ON_ERROR_STOP=1 -f 99_rollback.sql

begin;
set local lock_timeout = '5s';

drop view if exists planner_export.public_observed_links_v1;
drop view if exists planner_export.public_repeaters_v1;
drop view if exists planner_export.visibility_fence_v1;
drop schema if exists planner_export;
drop role if exists ukmesh_planner_reader;

commit;
