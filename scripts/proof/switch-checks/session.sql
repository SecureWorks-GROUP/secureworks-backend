-- Shared start of every switch check (Follow-up 56). Included by each check
-- file after it sets zz_check; the check then runs its body only inside
-- \if :zz_ok (a \quit here would end this include, not the check). It sets
-- zz_ok true only when all three hold, else prints one FAIL row:
--  1. the session is read only, read back after setting it (a pooled
--     connection can drop the SET), so any write errors instead of running;
--  2. the role sees every row (superuser or BYPASSRLS): the stores read here
--     have row security, and a role without it reads zero rows with no
--     error, which would pass "nothing waiting" or "register empty" falsely;
--  3. job_number names exactly one job, and it starts ZZTEST.
-- It also sets zz_job_id and zz_org_id. Nothing here writes.
\set ON_ERROR_STOP on
\pset footer off
\set zz_ok false
SET default_transaction_read_only = on;
\if :{?job_number}
SELECT current_setting('transaction_read_only') = 'on' AS zz_read_only,
       coalesce((SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false) AS zz_sees_all,
       (SELECT count(*) FROM public.jobs j WHERE j.job_number = :'job_number' AND j.job_number LIKE 'ZZTEST%') = 1 AS zz_one_job
\gset
\if :zz_read_only
\if :zz_sees_all
\if :zz_one_job
SELECT j.id AS zz_job_id, j.org_id AS zz_org_id
FROM public.jobs j WHERE j.job_number = :'job_number' AND j.job_number LIKE 'ZZTEST%'
\gset
\set zz_ok true
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result,
       jsonb_build_object('guard', 'job_number is not exactly one ZZTEST job', 'job_number', :'job_number')::text AS evidence;
\endif
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result,
       jsonb_build_object('guard', 'role cannot see rows behind row security', 'role', current_user)::text AS evidence;
\endif
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result, '{"guard":"session is not read only"}' AS evidence;
\endif
\else
SELECT :'zz_check' AS "check", 'FAIL' AS result, '{"guard":"psql variable job_number not given"}' AS evidence;
\endif
