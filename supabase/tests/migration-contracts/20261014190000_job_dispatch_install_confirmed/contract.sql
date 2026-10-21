-- Contract: 20261014190000_job_dispatch_install_confirmed. The Dispatch record gains four nullable
-- install confirmation columns; old rows come through unchanged and unconfirmed; every mark names a
-- person and a time; a cleared mark is cleared whole; the table gains no trigger and no publication.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.ic_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'install confirmed contract: %', p_msg; END IF; END $$;

CREATE FUNCTION pg_temp.ic_refused(p_sql text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN false;
EXCEPTION WHEN check_violation OR foreign_key_violation THEN
 RETURN true;
END $$;

-- 1. The four columns, nullable.
SELECT pg_temp.ic_assert(
 (SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_dispatch_state' AND is_nullable = 'YES'
    AND (column_name, data_type) IN (('install_confirmed_at', 'timestamp with time zone'),
                                     ('install_confirmed_by', 'uuid'),
                                     ('install_confirmed_by_email', 'text'),
                                     ('install_confirmed_for_day', 'date'))) = 4,
 'job_dispatch_state must carry the four nullable install confirmation columns');

-- 2. Old rows unchanged, and not confirmed.
SELECT pg_temp.ic_assert(
 (SELECT count(*) FROM public.ds7_old_rows o JOIN public.job_dispatch_state s USING (job_id)
  WHERE o.digest = md5(row(s.job_id, s.org_id, s.stage, s.stage_set_at, s.stage_set_by, s.stage_set_by_email,
                           s.next_step, s.next_step_set_at, s.next_step_set_by, s.next_step_set_by_email,
                           s.created_at, s.updated_at)::text)
    AND s.install_confirmed_at IS NULL AND s.install_confirmed_by IS NULL
    AND s.install_confirmed_by_email IS NULL AND s.install_confirmed_for_day IS NULL) = 2,
 'existing rows must come through unchanged and unconfirmed');

-- 3. No trigger, no publication.
SELECT pg_temp.ic_assert(
 NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.job_dispatch_state'::regclass AND NOT tgisinternal),
 'job_dispatch_state must carry no trigger');
SELECT pg_temp.ic_assert(
 NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE schemaname = 'public' AND tablename = 'job_dispatch_state'),
 'job_dispatch_state must be in no publication');

-- 4. A mark names a person and a time; a cleared mark is cleared whole.
UPDATE public.job_dispatch_state
SET install_confirmed_at = now(), install_confirmed_by_email = 'ops@example.test', install_confirmed_for_day = '2026-10-20'
WHERE job_id = '9d700000-0000-4000-8000-000000000001';
UPDATE public.job_dispatch_state
SET install_confirmed_at = now(), install_confirmed_by_email = 'ops@example.test', install_confirmed_for_day = NULL
WHERE job_id = '9d700000-0000-4000-8000-000000000002';
SELECT pg_temp.ic_assert(pg_temp.ic_refused($q$
 UPDATE public.job_dispatch_state SET install_confirmed_by_email = NULL
 WHERE job_id = '9d700000-0000-4000-8000-000000000001'
$q$), 'a mark with a time and no email must be refused');
SELECT pg_temp.ic_assert(pg_temp.ic_refused($q$
 UPDATE public.job_dispatch_state SET install_confirmed_at = NULL
 WHERE job_id = '9d700000-0000-4000-8000-000000000001'
$q$), 'an email with no time must be refused');
SELECT pg_temp.ic_assert(pg_temp.ic_refused($q$
 UPDATE public.job_dispatch_state SET install_confirmed_at = NULL, install_confirmed_by_email = NULL
 WHERE job_id = '9d700000-0000-4000-8000-000000000001'
$q$), 'clearing the time and email but keeping the day must be refused');
UPDATE public.job_dispatch_state
SET install_confirmed_at = NULL, install_confirmed_by = NULL, install_confirmed_by_email = NULL, install_confirmed_for_day = NULL
WHERE job_id = '9d700000-0000-4000-8000-000000000001';

-- 5. A mark alone, no stage and no next step, is a valid row.
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9d700000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'scheduled', 'repair');
INSERT INTO public.job_dispatch_state (job_id, org_id, install_confirmed_at, install_confirmed_by_email)
VALUES ('9d700000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', now(), 'ops@example.test');
SELECT pg_temp.ic_assert(pg_temp.ic_refused($q$
 UPDATE public.job_dispatch_state SET install_confirmed_by = '9d7fffff-0000-4000-8000-000000000000'
 WHERE job_id = '9d700000-0000-4000-8000-000000000003'
$q$), 'install_confirmed_by must reference a real user');

ROLLBACK;
