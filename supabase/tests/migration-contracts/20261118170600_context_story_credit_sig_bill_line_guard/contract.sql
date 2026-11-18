-- Follow-up 58 guard: context_job_story_credit_sig_fast falls back to the company-wide
-- signature when job_cost_bill_line_job_id is not the body its gate's SW prefilter assumes.
-- Self-run on a disposable local database; every fixture and change rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL jit=off;
SET LOCAL TimeZone='UTC';
SET LOCAL statement_timeout='120s';
-- Rule 17: stand 20261118170400's objects back up if an earlier contract dropped them, then
-- this case's own migration.
SELECT to_regprocedure('public.context_job_story_credit_sig_fast(uuid)') IS NULL
    OR to_regprocedure('public.context_job_story_credit_sig_main(uuid)') IS NULL AS bg_restore_fu58 \gset
\if :bg_restore_fu58
\ir ../../../migrations/20261118170400_context_story_credit_sig_job.sql
\endif
\ir ../../../migrations/20261118170600_context_story_credit_sig_bill_line_guard.sql
CREATE FUNCTION pg_temp.bg_assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FU58 guard: %',msg; END IF; END $f$;
CREATE FUNCTION pg_temp.bg_job(num text) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM public.jobs WHERE job_number=num $f$;
CREATE FUNCTION pg_temp.bg_md5(sig text) RETURNS text LANGUAGE sql AS $f$ SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(sig) $f$;

-- 1. Merge: the live name keeps its 20261031010000 body; _fast is the guarded body; the pinned
--    bill-line body is the one on this database; grants unchanged.
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig(uuid)')='a5d0f9f74c14ab88cc502f2d2ad98f27','merge changed the live credit signature');
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig_fast(uuid)')='9177840caa26158636d32d399bebb809','fast is not the guarded body');
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.job_cost_bill_line_job_id(text)')='a543e41bc709d4a96d1f2b3f7719b572','bill-line body is not the pinned one');
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig_main(uuid)')='a5d0f9f74c14ab88cc502f2d2ad98f27','main copy moved');
SELECT pg_temp.bg_assert(strpos((SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_credit_sig_fast(uuid)'::regprocedure),
 'job_cost_bill_line_job_id(text)')>0,'fast does not check the bill-line body');
SELECT pg_temp.bg_assert(has_function_privilege('service_role','public.context_job_story_credit_sig_fast(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.context_job_story_credit_sig_fast(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.context_job_story_credit_sig_fast(uuid)','EXECUTE'),'grants');
SELECT pg_temp.bg_assert(obj_description('public.install_context_story_credit_sig_job()'::regprocedure,'pg_proc') LIKE '%about 0.9 s%','installer comment lacks the 0.9 s note');

\ir ../20261118170400_context_story_credit_sig_job/fixtures.sql

-- 2. With every source as written, _fast still equals the company-wide answer on every case,
--    the bill-line route (SWF-958006) included, and on every stored job.
DO $equal$
DECLARE j uuid; num text; placed int := 0;
/* check block */ BEGIN
 FOR num IN SELECT unnest(ARRAY['CS-0','CS-1','CS-2A','CS-2B','CS-3','CS-4','CS-5','SWF-958006','CS-7A','CS-7B','CS-8']) LOOP
  j := pg_temp.bg_job(num);
  PERFORM pg_temp.bg_assert(public.context_job_story_credit_sig_fast(j) IS NOT DISTINCT FROM public.context_job_story_credit_sig_main(j),'fast differs for '||num);
  IF public.context_job_story_credit_sig_fast(j) IS NOT NULL THEN placed := placed+1; END IF;
 END LOOP;
 PERFORM pg_temp.bg_assert(placed=7, format('expected 7 placed, got %s',placed));
 PERFORM pg_temp.bg_assert(public.context_job_story_credit_sig_fast(pg_temp.bg_job('SWF-958006')) IS NOT NULL,'bill-line route not placed');
 FOR j IN SELECT id FROM public.jobs LOOP
  PERFORM pg_temp.bg_assert(public.context_job_story_credit_sig_fast(j) IS NOT DISTINCT FROM public.context_job_story_credit_sig_main(j),'fast differs for a stored job');
 END LOOP;
END $equal$;

-- 3. Sources as written: _fast takes the scoped path.
SAVEPOINT scoped;
CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_job(p_job_id uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'scoped'::text $f$;
SELECT pg_temp.bg_assert(public.context_job_story_credit_sig_fast(pg_temp.bg_job('SWF-958006'))='scoped','fast did not take the scoped path');
ROLLBACK TO SAVEPOINT scoped;

-- 4. A changed bill-line body (same answers, other words) sends _fast to the company-wide path.
SAVEPOINT bill_line;
CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_job(p_job_id uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'scoped'::text $f$;
DO $b$
DECLARE d text;
/* block */ BEGIN
 d := pg_get_functiondef('public.job_cost_bill_line_job_id(text)'::regprocedure);
 EXECUTE replace(d, 'SELECT CASE WHEN', 'SELECT /* changed */ CASE WHEN');
END $b$;
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.job_cost_bill_line_job_id(text)') IS DISTINCT FROM 'a543e41bc709d4a96d1f2b3f7719b572','test did not change the bill-line body');
SELECT pg_temp.bg_assert(public.context_job_story_credit_sig_fast(pg_temp.bg_job(n)) IS NOT DISTINCT FROM public.context_job_story_credit_sig_main(pg_temp.bg_job(n))
 AND public.context_job_story_credit_sig_fast(pg_temp.bg_job(n)) IS DISTINCT FROM 'scoped','changed bill-line body did not fall back for '||n)
  FROM unnest(ARRAY['CS-1','SWF-958006','CS-0']) AS n;
ROLLBACK TO SAVEPOINT bill_line;

-- 5. Installed before this migration: the live name follows the new _fast; remove and install
--    still work and repeat safely; re-applying is a no-op.
SAVEPOINT installed;
\ir ../../../migrations/20261118170400_context_story_credit_sig_job.sql
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig_fast(uuid)')='26bd02ef6d2b66bd87f58e40a4e3382d','test did not restore the old fast body');
SELECT public.install_context_story_credit_sig_job();
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig(uuid)')='26bd02ef6d2b66bd87f58e40a4e3382d','old install did not take');
CREATE TEMP TABLE bg_before AS SELECT id, public.context_job_story_money_sig(id) AS sig FROM public.jobs;
\ir ../../../migrations/20261118170600_context_story_credit_sig_bill_line_guard.sql
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig(uuid)')='9177840caa26158636d32d399bebb809','installed live name did not take the guard');
SELECT pg_temp.bg_assert(has_function_privilege('service_role','public.context_job_story_credit_sig(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.context_job_story_credit_sig(uuid)','EXECUTE'),'re-install changed grants');
SELECT pg_temp.bg_assert(NOT EXISTS(SELECT 1 FROM bg_before b WHERE public.context_job_story_money_sig(b.id) IS DISTINCT FROM b.sig),'money_sig moved');
\ir ../../../migrations/20261118170600_context_story_credit_sig_bill_line_guard.sql
SELECT public.remove_context_story_credit_sig_job();
SELECT public.remove_context_story_credit_sig_job();
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig(uuid)')='a5d0f9f74c14ab88cc502f2d2ad98f27','remove did not restore');
SELECT public.install_context_story_credit_sig_job();
SELECT public.install_context_story_credit_sig_job();
SELECT pg_temp.bg_assert(pg_temp.bg_md5('public.context_job_story_credit_sig(uuid)')='9177840caa26158636d32d399bebb809','install did not put the guarded body');
SELECT pg_temp.bg_assert(NOT EXISTS(SELECT 1 FROM bg_before b WHERE public.context_job_story_money_sig(b.id) IS DISTINCT FROM b.sig),'money_sig moved on install');
SELECT public.remove_context_story_credit_sig_job();
ROLLBACK TO SAVEPOINT installed;

SELECT 'FU58 guard: bill-line body pinned, equality, scoped path, fallback and installed re-derive passed' AS result;
ROLLBACK;
