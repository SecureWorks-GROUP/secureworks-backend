-- Contract: 20261014113000_job_dispatch_state. The Dispatch stage record sits in a table no browser
-- role can read or write, one row per job; it holds only the six rail stops (never not_started and
-- never a job status), a dated stage, and a next-step line of 1 to 40 characters; and it goes with
-- its job.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.ds_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'job dispatch state contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.ds_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
 RETURN true;
END $$;

-- 1. Locked away from the browser.
SELECT pg_temp.ds_assert(
 (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_dispatch_state'::regclass),
 'row level security must be on for job_dispatch_state');
SELECT pg_temp.ds_assert(
 NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_dispatch_state'),
 'job_dispatch_state must carry no policy: only ops-api reaches it');
SELECT pg_temp.ds_assert(
 NOT has_table_privilege('anon', 'public.job_dispatch_state', 'SELECT')
 AND NOT has_table_privilege('anon', 'public.job_dispatch_state', 'INSERT')
 AND NOT has_table_privilege('authenticated', 'public.job_dispatch_state', 'SELECT')
 AND NOT has_table_privilege('authenticated', 'public.job_dispatch_state', 'INSERT')
 AND NOT has_table_privilege('authenticated', 'public.job_dispatch_state', 'UPDATE')
 AND NOT has_table_privilege('authenticated', 'public.job_dispatch_state', 'DELETE')
 AND NOT has_table_privilege('authenticated', 'public.job_dispatch_state', 'TRUNCATE'),
 'browser roles must hold no privilege on job_dispatch_state');
SELECT pg_temp.ds_assert(
 has_table_privilege('service_role', 'public.job_dispatch_state', 'SELECT')
 AND has_table_privilege('service_role', 'public.job_dispatch_state', 'INSERT')
 AND has_table_privilege('service_role', 'public.job_dispatch_state', 'UPDATE'),
 'service_role (ops-api) must be able to read and write the Dispatch stage');

-- 2. The six stops, one row per job, a dated stage, a short next-step line.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9d000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'order_materials', 'fencing'),
       ('9d000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio');

INSERT INTO public.job_dispatch_state (job_id, org_id, stage, stage_set_at)
VALUES ('9d000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'materials_ordered', now());
UPDATE public.job_dispatch_state SET stage = 'accepted' WHERE job_id = '9d000000-0000-4000-8000-000000000001';
UPDATE public.job_dispatch_state SET stage = 'deposit_paid' WHERE job_id = '9d000000-0000-4000-8000-000000000001';
UPDATE public.job_dispatch_state SET stage = 'supplier_confirmed' WHERE job_id = '9d000000-0000-4000-8000-000000000001';
UPDATE public.job_dispatch_state SET stage = 'materials_on_site' WHERE job_id = '9d000000-0000-4000-8000-000000000001';
UPDATE public.job_dispatch_state SET stage = 'trade_scheduled' WHERE job_id = '9d000000-0000-4000-8000-000000000001';

SELECT pg_temp.ds_assert(pg_temp.ds_refused($q$
 UPDATE public.job_dispatch_state SET stage = 'not_started' WHERE job_id = '9d000000-0000-4000-8000-000000000001'
$q$), 'not_started must never be stored: it is the absence of a set stage');
SELECT pg_temp.ds_assert(pg_temp.ds_refused($q$
 UPDATE public.job_dispatch_state SET stage = 'scheduled' WHERE job_id = '9d000000-0000-4000-8000-000000000001'
$q$), 'a job status is not a Dispatch stage');
SELECT pg_temp.ds_assert(pg_temp.ds_refused($q$
 INSERT INTO public.job_dispatch_state (job_id, org_id, stage, stage_set_at)
 VALUES ('9d000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'accepted', now())
$q$), 'one row per job: a second row for the same job must be refused');
SELECT pg_temp.ds_assert(pg_temp.ds_refused($q$
 INSERT INTO public.job_dispatch_state (job_id, org_id, stage)
 VALUES ('9d000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted')
$q$), 'a stage with no set time must be refused');
SELECT pg_temp.ds_assert(pg_temp.ds_refused($q$
 INSERT INTO public.job_dispatch_state (job_id, org_id, next_step)
 VALUES ('9d000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', repeat('x', 41))
$q$), 'a next-step line over 40 characters must be refused');
SELECT pg_temp.ds_assert(pg_temp.ds_refused($q$
 INSERT INTO public.job_dispatch_state (job_id, org_id, next_step)
 VALUES ('9d000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', '')
$q$), 'a cleared next-step line is stored as null, never an empty string');
SELECT pg_temp.ds_assert(pg_temp.ds_refused($q$
 INSERT INTO public.job_dispatch_state (job_id, org_id, stage, stage_set_at)
 VALUES ('9d000000-0000-4000-8000-0000000000ff', '00000000-0000-0000-0000-000000000001', 'accepted', now())
$q$), 'a row for a job that does not exist must be refused');

-- A next-step line alone, no stage, is a valid row.
INSERT INTO public.job_dispatch_state (job_id, org_id, next_step, next_step_set_at)
VALUES ('9d000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', repeat('x', 40), now());
SELECT pg_temp.ds_assert(
 (SELECT count(*) FROM public.job_dispatch_state
  WHERE job_id IN ('9d000000-0000-4000-8000-000000000001', '9d000000-0000-4000-8000-000000000002')) = 2,
 'both rows must be stored');

-- 3. The row goes with its job.
DELETE FROM public.jobs WHERE id = '9d000000-0000-4000-8000-000000000002';
SELECT pg_temp.ds_assert(
 NOT EXISTS (SELECT 1 FROM public.job_dispatch_state WHERE job_id = '9d000000-0000-4000-8000-000000000002'),
 'deleting a job must delete its Dispatch stage row');

ROLLBACK;
