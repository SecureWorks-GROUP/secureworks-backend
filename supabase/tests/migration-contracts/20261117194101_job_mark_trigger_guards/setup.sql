-- Standalone narrow case: CI already has these definitions from the historical case.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
SELECT to_regprocedure('public.job_change_mark_triggers_install()') IS NULL AS need_prior \gset
\if :need_prior
\ir ../../../migrations/20261117171303_job_change_mark_triggers.sql
\endif
