-- 01_reader_role.sql — dedicated SELECT-only database role for the planner.
--
-- Run via apply.sh (which supplies the psql variable `reader_password` from
-- the environment — the password NEVER lives in Git). Idempotent: creates the
-- role or refreshes its password.
--
-- Hardening set here:
--   * read-only transactions (default_transaction_read_only)
--   * short statement / idle / lock timeouts (protects the live DB)
--   * connection limit 2 (matches the ingester's bounded pool)
--   * no superuser / createdb / createrole / bypassrls

select format('create role ukmesh_planner_reader login password %L', :'reader_password')
where not exists (select 1 from pg_roles where rolname = 'ukmesh_planner_reader')
\gexec

select format('alter role ukmesh_planner_reader password %L', :'reader_password')
where exists (select 1 from pg_roles where rolname = 'ukmesh_planner_reader')
\gexec

alter role ukmesh_planner_reader set default_transaction_read_only = on;
alter role ukmesh_planner_reader set statement_timeout = '10s';
alter role ukmesh_planner_reader set idle_in_transaction_session_timeout = '15s';
alter role ukmesh_planner_reader set lock_timeout = '3s';
alter role ukmesh_planner_reader connection limit 2;
alter role ukmesh_planner_reader nosuperuser nocreatedb nocreaterole nobypassrls;
