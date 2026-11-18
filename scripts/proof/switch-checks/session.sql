-- Shared start of every switch check (Follow-up 56). Included by each check
-- file after it sets zz_check. It stops the check with one FAIL row unless:
--  1. the session is read only, read back after setting it (a pooled
--     connection can drop the SET);
--  2. the role sees every row: the stores read here have row security, and a
--     role without it reads zero rows with no error, which would pass every
--     "nothing waiting" or "register empty" check falsely;
--  3. job_number names exactly one ZZTEST job.
-- It sets zz_job_id and zz_org_id for the check. Nothing here writes.
\set ON_ERROR_STOP on
\pset footer off
SET default_transaction_read_only = on;
\if :{?job_number}
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result, '{"guard":"psql variable job_number not given"}' AS evidence
\quit
\endif
SELECT current_setting('transaction_read_only') = 'on' AS zz_read_only,
       coalesce((SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false) AS zz_sees_all,
       (SELECT count(*) FROM public.jobs j WHERE j.job_number = :'job_number' AND j.job_number LIKE 'ZZTEST%') = 1 AS zz_one_job
\gset
\if :zz_read_only
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result, '{"guard":"session is not read only"}' AS evidence
\quit
\endif
\if :zz_sees_all
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result,
       jsonb_build_object('guard', 'role cannot see rows behind row security', 'role', current_user)::text AS evidence
\quit
\endif
\if :zz_one_job
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result,
       jsonb_build_object('guard', 'job_number is not exactly one ZZTEST job', 'job_number', :'job_number')::text AS evidence
\quit
\endif
SELECT j.id AS zz_job_id, j.org_id AS zz_org_id
FROM public.jobs j WHERE j.job_number = :'job_number' AND j.job_number LIKE 'ZZTEST%'
\gset
