-- Follow-up 58: the job-scoped supplier-credit signature equals the company-wide one.
-- Self-run on a disposable local database; every fixture and switch rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL jit=off;
SET LOCAL TimeZone='UTC';
SET LOCAL statement_timeout='120s';
CREATE TEMP TABLE cs_pre AS SELECT p.proname, md5(p.prosrc) AS m FROM pg_proc p
 WHERE p.oid IN ('public.context_job_story_credit_sig(uuid)'::regprocedure,'public.context_job_story_money_sig(uuid)'::regprocedure);
-- Rule 17: recreate this case's own objects after predecessor rollback proofs.
\ir ../../../migrations/20261118170400_context_story_credit_sig_job.sql
CREATE FUNCTION pg_temp.cs_assert(ok boolean,msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FU58: %',msg; END IF; END $f$;
CREATE FUNCTION pg_temp.cs_job(num text) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM public.jobs WHERE job_number=num $f$;

-- Merge leaves the live name on its 20261031010000 body; the copy is byte for byte that body.
SELECT pg_temp.cs_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_credit_sig(uuid)'::regprocedure)='a5d0f9f74c14ab88cc502f2d2ad98f27','merge changed the live credit signature');
SELECT pg_temp.cs_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_credit_sig_main(uuid)'::regprocedure)='a5d0f9f74c14ab88cc502f2d2ad98f27','main copy is not the live body');
SELECT pg_temp.cs_assert(NOT EXISTS (SELECT 1 FROM cs_pre c JOIN pg_proc p ON p.proname=c.proname AND p.pronamespace='public'::regnamespace
 WHERE md5(p.prosrc) IS DISTINCT FROM c.m) AND (SELECT count(*) FROM cs_pre)=2,'merge changed credit_sig or money_sig');
SELECT pg_temp.cs_assert(NOT has_function_privilege('anon','public.context_job_story_credit_sig_job(uuid)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.install_context_story_credit_sig_job()','EXECUTE')
 AND has_function_privilege('service_role','public.context_job_story_credit_sig_fast(uuid)','EXECUTE'),'grants');
-- The source bodies the gate was read from are the ones on this database.
SELECT pg_temp.cs_assert(md5(pg_get_viewdef('public.v_job_cost_events'::regclass,true))='c2e9632718dfa057703f1ee36b97322e'
 AND md5(pg_get_viewdef('public.v_job_cost_events_legacy'::regclass,true))='b48997c55913ce3c90e3a3c947533fd3'
 AND md5(pg_get_viewdef('public.v_supplier_credit_placement'::regclass,true))='e9754f7c63e856eb80f4f6c240039323'
 AND md5(pg_get_viewdef('public.v_supplier_credit_allocations'::regclass,true))='9684232cbb1c45e7564ce168971d800e'
 AND md5(pg_get_viewdef('public.v_bookkeeping_line_parts_current'::regclass,true))='8d1e063dbf8e08524c6c3b2d6023b9c3','source views moved');

\ir fixtures.sql

-- 1. Equality on every case, with the expected placed / NULL shape.
DO $equal$
DECLARE j uuid; num text; a text; b text; f text; placed int := 0; nulls int := 0;
/* check block */ BEGIN
 FOR num IN SELECT unnest(ARRAY['CS-0','CS-1','CS-2A','CS-2B','CS-3','CS-4','CS-5','SWF-958006','CS-7A','CS-7B','CS-8']) LOOP
  j := pg_temp.cs_job(num);
  a := public.context_job_story_credit_sig_main(j);
  b := public.context_job_story_credit_sig_job(j);
  f := public.context_job_story_credit_sig_fast(j);
  PERFORM pg_temp.cs_assert(a IS NOT DISTINCT FROM b, 'job signature differs for '||num);
  PERFORM pg_temp.cs_assert(a IS NOT DISTINCT FROM f, 'fast signature differs for '||num);
  IF a IS NULL THEN nulls := nulls+1; ELSE placed := placed+1; END IF;
 END LOOP;
 PERFORM pg_temp.cs_assert(placed=7 AND nulls=4, format('expected 7 placed and 4 NULL, got %s and %s',placed,nulls));
 FOR num IN SELECT unnest(ARRAY['CS-0','CS-3','CS-4','CS-8']) LOOP
  PERFORM pg_temp.cs_assert(public.context_job_story_credit_sig_job(pg_temp.cs_job(num)) IS NULL, 'expected NULL for '||num);
 END LOOP;
 -- The split credit really is on both jobs, and the two shares differ.
 PERFORM pg_temp.cs_assert((SELECT count(DISTINCT job_id) FROM public.v_supplier_credit_placement WHERE xero_credit_note_id='cs-cn-2' AND state='placed')=2,'split note not on two jobs');
 PERFORM pg_temp.cs_assert(public.context_job_story_credit_sig_job(pg_temp.cs_job('CS-2A')) <> public.context_job_story_credit_sig_job(pg_temp.cs_job('CS-2B')),'split shares read alike');
 PERFORM pg_temp.cs_assert((SELECT count(*) FROM public.v_supplier_credit_placement WHERE xero_credit_note_id IN ('cs-cn-0','cs-cn-3','cs-cn-4','cs-cn-8') AND job_id IS NULL)=4,'unplaced notes not reported unplaced');
 -- Every job on this database, fixtures of earlier cases included.
 FOR j IN SELECT id FROM public.jobs LOOP
  PERFORM pg_temp.cs_assert(public.context_job_story_credit_sig_main(j) IS NOT DISTINCT FROM public.context_job_story_credit_sig_job(j),'job signature differs for a stored job');
 END LOOP;
 PERFORM pg_temp.cs_assert(public.context_job_story_credit_sig_job(gen_random_uuid()) IS NULL,'unknown job not NULL');
 RAISE NOTICE 'FU58 equality: % placed, % NULL, % jobs compared', placed, nulls, (SELECT count(*) FROM public.jobs);
END $equal$;

-- 2. A change after the first read moves both signatures alike (and the gate tracks it).
SAVEPOINT moves;
UPDATE public.xero_supplier_credit_notes SET raw_json='{"Payments":[{"PaymentID":"cs-pay","Amount":5}]}' WHERE xero_credit_note_id='cs-cn-1';
SELECT pg_temp.cs_assert(public.context_job_story_credit_sig_main(pg_temp.cs_job('CS-1'))=public.context_job_story_credit_sig_job(pg_temp.cs_job('CS-1')),'refund change differs');
UPDATE public.xero_invoices SET job_id=pg_temp.cs_job('CS-0') WHERE xero_invoice_id='cs-bill-3';
SELECT pg_temp.cs_assert(public.context_job_story_credit_sig_job(pg_temp.cs_job('CS-0')) IS NOT NULL
 AND public.context_job_story_credit_sig_main(pg_temp.cs_job('CS-0'))=public.context_job_story_credit_sig_job(pg_temp.cs_job('CS-0')),'bill moved onto a job differs');
DELETE FROM public.bookkeeping_line_evidence WHERE xero_invoice_id='cs-bill-5';
DO $d$ BEGIN IF (SELECT relkind FROM pg_class WHERE oid='public.v_bookkeeping_line_evidence_current'::regclass)='r' THEN
 DELETE FROM public.v_bookkeeping_line_evidence_current WHERE xero_invoice_id='cs-bill-5'; END IF; END $d$;
SELECT pg_temp.cs_assert(public.context_job_story_credit_sig_job(pg_temp.cs_job('CS-5')) IS NULL
 AND public.context_job_story_credit_sig_main(pg_temp.cs_job('CS-5')) IS NULL,'evidence removed still placed');
ROLLBACK TO SAVEPOINT moves;

-- 3. Install swaps the live name; money_sig reads the same; install and remove repeat safely.
SAVEPOINT install;
CREATE TEMP TABLE cs_before AS SELECT id, public.context_job_story_money_sig(id) AS sig FROM public.jobs;
SELECT public.install_context_story_credit_sig_job();
SELECT public.install_context_story_credit_sig_job();
SELECT pg_temp.cs_assert((SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_credit_sig(uuid)'::regprocedure)=
 (SELECT prosrc FROM pg_proc WHERE oid='public.context_job_story_credit_sig_fast(uuid)'::regprocedure),'install did not swap');
SELECT pg_temp.cs_assert(NOT EXISTS(SELECT 1 FROM cs_before b WHERE public.context_job_story_money_sig(b.id) IS DISTINCT FROM b.sig),'money_sig moved on install');
SELECT pg_temp.cs_assert(has_function_privilege('service_role','public.context_job_story_credit_sig(uuid)','EXECUTE')
 AND NOT has_function_privilege('anon','public.context_job_story_credit_sig(uuid)','EXECUTE'),'install changed grants');
-- Re-applying this migration while installed is allowed (rule 17).
\ir ../../../migrations/20261118170400_context_story_credit_sig_job.sql
SELECT public.remove_context_story_credit_sig_job();
SELECT public.remove_context_story_credit_sig_job();
SELECT pg_temp.cs_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_credit_sig(uuid)'::regprocedure)='a5d0f9f74c14ab88cc502f2d2ad98f27','remove did not restore');
SELECT pg_temp.cs_assert(NOT EXISTS(SELECT 1 FROM cs_before b WHERE public.context_job_story_money_sig(b.id) IS DISTINCT FROM b.sig),'money_sig moved on remove');
ROLLBACK TO SAVEPOINT install;

-- 4. Install refuses a live body it was not written against; nothing changes.
SAVEPOINT refuse;
CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig(p_job_id uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'other'::text $f$;
DO $r$ BEGIN
 PERFORM public.install_context_story_credit_sig_job();
 RAISE EXCEPTION 'FU58: install accepted a changed body';
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM <> 'credit_sig_job_install_preimage_changed' THEN RAISE; END IF;
END $r$;
DO $r$ BEGIN
 PERFORM public.remove_context_story_credit_sig_job();
 RAISE EXCEPTION 'FU58: remove accepted a changed body';
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM <> 'credit_sig_job_remove_preimage_changed' THEN RAISE; END IF;
END $r$;
ROLLBACK TO SAVEPOINT refuse;

-- 5. With the sources as written and no cutover, _fast takes the scoped path (not _main).
SAVEPOINT scoped;
CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_job(p_job_id uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'scoped'::text $f$;
SELECT pg_temp.cs_assert(public.context_job_story_credit_sig_fast(pg_temp.cs_job('CS-1'))='scoped','fast did not take the scoped path');
ROLLBACK TO SAVEPOINT scoped;
-- Any failure in the scoped path gets the company-wide answer.
SAVEPOINT fallback;
CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_job(p_job_id uuid) RETURNS text LANGUAGE plpgsql STABLE AS $f$
/* test */ BEGIN RAISE EXCEPTION 'credit_sig_job_gate_missed_route'; END $f$;
SELECT pg_temp.cs_assert(public.context_job_story_credit_sig_fast(pg_temp.cs_job('CS-1'))=public.context_job_story_credit_sig_main(pg_temp.cs_job('CS-1')),'fallback on error');
ROLLBACK TO SAVEPOINT fallback;
-- A ready cost-lines cutover takes the company-wide path too.
SAVEPOINT cutover;
INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_cost_events_from_cost_lines_v1',true) ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
ALTER TABLE public.job_cost_events_cutover DROP CONSTRAINT job_cost_events_cutover_check;  -- rolled back below
UPDATE public.job_cost_events_cutover SET completed_at=now() WHERE singleton;
CREATE OR REPLACE FUNCTION public.context_job_story_credit_sig_job(p_job_id uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'scoped'::text $f$;
SELECT pg_temp.cs_assert(EXISTS (SELECT 1 FROM public.job_cost_events_cutover WHERE singleton AND completed_at IS NOT NULL),'cutover not ready in test');
-- (the cost-lines branch holds no rows here, so both read NULL)
SELECT pg_temp.cs_assert(public.context_job_story_credit_sig_fast(pg_temp.cs_job('CS-1')) IS DISTINCT FROM 'scoped'
 AND public.context_job_story_credit_sig_fast(pg_temp.cs_job('CS-1')) IS NOT DISTINCT FROM public.context_job_story_credit_sig_main(pg_temp.cs_job('CS-1')),'cutover did not fall back');
ROLLBACK TO SAVEPOINT cutover;

SELECT 'FU58 credit signature by job: equality, moves, install/remove, refusals and fallbacks passed' AS result;
ROLLBACK;
