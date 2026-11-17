-- FU23: one contract, three requested behavior cases. All changes roll back.
BEGIN;
-- Re-apply each owning definition before checking it. Earlier contracts may
-- replace readers inside their own proofs; no such replacement may leak here.
\ir ../../../migrations/20261117210201_context_record_close_obligation_guards.sql
\ir ../../../migrations/20261117205501_job_truth_weekly_skip_failed.sql
\ir ../../../migrations/20261117233201_followup23_record_proof_weekly_pages.sql
\set record_fixture_seed true
\ir ../20261117195201_context_ledger_record_candidates/setup.sql

-- Case 1: SUBMITTED is not issued, even for the exact invoice. A refusal can
-- be retried after the office authorises it, with one transition only.
UPDATE public.context_ledger_items SET closes_on='invoice_issued',from_role='us',to_role='customer'
 WHERE id='00000000-0000-4000-8000-000000000402';
DO $c$
DECLARE s text; v jsonb;
BEGIN
 FOREACH s IN ARRAY ARRAY['SUBMITTED','DRAFT','VOIDED','DELETED'] LOOP
  UPDATE public.xero_invoices SET status=s WHERE id='00000000-0000-4000-8000-000000000402';
  v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000402',false);
  IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU23: unissued invoice closed note: %',s; END IF;
 END LOOP;
 UPDATE public.xero_invoices SET status='AUTHORISED' WHERE id='00000000-0000-4000-8000-000000000402';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000402',false);
 IF v->>'closed'<>'1' THEN RAISE EXCEPTION 'FU23: authorised control'; END IF;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000402',false);
 IF v->>'closed'<>'0' OR (SELECT count(*) FROM public.context_ledger_transitions
  WHERE job_id='00000000-0000-4000-8000-000000000402' AND by='rule:record_close_v1')<>1
 THEN RAISE EXCEPTION 'FU23: issued retry duplicated transition'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.context_ledger_record_candidates(
  '00000000-0000-4000-8000-000000000410','invoice_issued','invoice:inv-9002','2026-11-03T09:00:00+08','us','customer'))
 THEN RAISE EXCEPTION 'FU23: paid issued control'; END IF;
END $c$;
SELECT 'PASS FU23 case 1: exact SUBMITTED refusal, three edited statuses, authorised/paid and retry controls' AS result;

-- Case 2: supplier role alone is never identity. Keep an unpaid named bill
-- open when a different bill on the same job is paid. No supplier names needed.
INSERT INTO public.xero_invoices(id,job_id,org_id,xero_invoice_id,invoice_type,status,invoice_number,invoice_date)
VALUES('00000000-0000-4000-8000-000000023299','00000000-0000-4000-8000-000000000403',
 '00000000-0000-0000-0000-000000000001','ZZTEST-23299','ACCPAY','AUTHORISED','BILL-23299','2026-11-04');
UPDATE public.context_ledger_items SET closes_on='payment',from_role='us',to_role='supplier',what='Pay the supplier bill.'
 WHERE id='00000000-0000-4000-8000-000000000403';
DO $c$
DECLARE k text; v jsonb;
BEGIN
 FOREACH k IN ARRAY ARRAY['payment:supplier','other:supplier','bill:00000000-0000-4000-8000-000000023299',NULL] LOOP
  UPDATE public.context_ledger_items SET about_key=k WHERE id='00000000-0000-4000-8000-000000000403';
  v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
  IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU23: unrelated paid bill closed supplier item'; END IF;
 END LOOP;
 -- Hand-edited record: exact identity alone is insufficient without paid proof.
 UPDATE public.context_ledger_items SET about_key='bill:00000000-0000-4000-8000-000000000403'
 WHERE id='00000000-0000-4000-8000-000000000403';
 UPDATE public.xero_invoices SET status='VOIDED' WHERE id='00000000-0000-4000-8000-000000000403';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'FU23: voided bill closed item'; END IF;
 UPDATE public.xero_invoices SET status='PAID' WHERE id='00000000-0000-4000-8000-000000000403';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
 IF v->>'closed'<>'1' THEN RAISE EXCEPTION 'FU23: exact paid bill control'; END IF;
 IF public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false)->>'closed'<>'0'
 THEN RAISE EXCEPTION 'FU23: paid bill retry'; END IF;
END $c$;
SELECT 'PASS FU23 case 2: generic, missing, unrelated and voided bill refusals; exact paid bill and retry' AS result;

-- Case 3: score kept pages when the stored-read switch is on and the page
-- covers the current version AND mark instant. Only stale pages are rebuilt.
CREATE TEMP TABLE fu23_jobs AS SELECT
 ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid AS id,n FROM generate_series(23201,23205) n;
INSERT INTO public.jobs(id,org_id,job_number,type,status)
 SELECT id,'00000000-0000-0000-0000-000000000001','SWTEST-'||n,'fencing','accepted' FROM fu23_jobs;
INSERT INTO public.job_change_mark_events(job_id,marked_at,source) SELECT id,now(),'FU23' FROM fu23_jobs;
INSERT INTO public.job_pages(job_id,page,built_at,build_ms,status,page_version,covers_mark_version,covers_marked_at)
 SELECT f.id,'{"story_text":{"text":{"sections":{"headline":"Stored page."}}}}',now(),0,'ready',
 public.job_page_version(),m.mark_version,m.last_marked_at
 FROM fu23_jobs f JOIN public.job_change_marks m ON m.job_id=f.id;
CREATE OR REPLACE FUNCTION public.job_pages_keep_ready_set() RETURNS SETOF uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT id FROM pg_temp.fu23_jobs $$;
CREATE TEMP TABLE fu23_attempts(job_id uuid);
CREATE TEMP TABLE fu23_mode(mode text);
INSERT INTO fu23_mode VALUES('healthy');
CREATE OR REPLACE FUNCTION public.job_page_refresh(p_job_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE mode text; BEGIN
 SELECT m.mode INTO mode FROM pg_temp.fu23_mode m;
 INSERT INTO pg_temp.fu23_attempts VALUES(p_job_id);
 IF mode='failed' THEN RETURN '{"outcome":"failed"}'; END IF;
 IF mode='throw' THEN RAISE EXCEPTION 'ZZTEST read fault'; END IF;
 UPDATE public.job_pages p SET page='{"story_text":{"text":{"sections":{"headline":"Office changed the record."}}}}',
  covers_mark_version=m.mark_version,covers_marked_at=m.last_marked_at,page_version=public.job_page_version()
 FROM public.job_change_marks m WHERE p.job_id=p_job_id AND m.job_id=p_job_id;
 RETURN '{"outcome":"built"}';
END $$;
INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('job_page_stored_read_v1',true,'ZZTEST')
 ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
DO $c$
DECLARE v jsonb; BEGIN
 v:=public.job_truth_weekly_draw('2029-01-01',5);
 IF v->>'jobs'<>'5' OR EXISTS(SELECT 1 FROM fu23_attempts)
  OR EXISTS(SELECT 1 FROM public.job_truth_weekly_samples WHERE week='2029-01-01'
   AND (story->0->>'text'<>'Stored page.' OR notes<>'[]'))
 THEN RAISE EXCEPTION 'FU23: fresh stored pages were rebuilt or not scored'; END IF;
 -- A mark landing with an older timestamp still changes the version.
 INSERT INTO public.job_change_mark_events(job_id,marked_at,source)
 VALUES('00000000-0000-4000-8000-000000023201',now()-interval '1 day','FU23 late commit');
 -- Matching version cannot hide an uncovered timestamp or an old page schema.
 UPDATE public.job_pages SET covers_marked_at=now()-interval '1 day' WHERE job_id='00000000-0000-4000-8000-000000023202';
 UPDATE public.job_pages SET page_version=0 WHERE job_id='00000000-0000-4000-8000-000000023203';
 v:=public.job_truth_weekly_draw('2029-01-08',5);
 IF v->>'jobs'<>'5' OR (SELECT count(*) FROM fu23_attempts)<>3
  OR (SELECT count(*) FROM public.job_truth_weekly_samples WHERE week='2029-01-08'
   AND story->0->>'text'='Office changed the record.')<>3
 THEN RAISE EXCEPTION 'FU23: only stale pages must rebuild'; END IF;
 IF public.job_truth_weekly_draw('2029-01-08',5)->>'outcome'<>'already_drawn'
  OR (SELECT count(*) FROM fu23_attempts)<>3 THEN RAISE EXCEPTION 'FU23: draw retry rebuilt pages'; END IF;
 -- Missing coverage is stale; failure skips only that job, never scores old words.
 UPDATE public.job_pages SET covers_mark_version=NULL WHERE job_id='00000000-0000-4000-8000-000000023201';
 UPDATE fu23_mode SET mode='failed';
 v:=public.job_truth_weekly_draw('2029-01-15',5);
 IF v->>'jobs'<>'4' OR v->>'skipped'<>'1' OR EXISTS(SELECT 1 FROM public.job_truth_weekly_samples
  WHERE week='2029-01-15' AND job_id='00000000-0000-4000-8000-000000023201')
 THEN RAISE EXCEPTION 'FU23: failed stale build scored old page'; END IF;
 UPDATE fu23_mode SET mode='throw';
 v:=public.job_truth_weekly_draw('2029-01-22',5);
 IF v->>'jobs'<>'4' OR v->>'skipped'<>'1' THEN RAISE EXCEPTION 'FU23: failed read erased other pages'; END IF;
 UPDATE fu23_mode SET mode='healthy';
 v:=public.job_truth_weekly_draw('2029-01-29',5);
 IF v->>'jobs'<>'5' THEN RAISE EXCEPTION 'FU23: repaired stale page not sampled'; END IF;
 -- Switch off and missing flag both retain main's refresh-every-page behavior.
 TRUNCATE fu23_attempts;
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_page_stored_read_v1';
 v:=public.job_truth_weekly_draw('2029-02-05',5);
 IF v->>'jobs'<>'5' OR (SELECT count(*) FROM fu23_attempts)<>5 THEN RAISE EXCEPTION 'FU23: switch-off parity'; END IF;
 DELETE FROM public.feature_flags WHERE flag_name='job_page_stored_read_v1';
 v:=public.job_truth_weekly_draw('2029-02-12',5);
 IF v->>'jobs'<>'5' OR (SELECT count(*) FROM fu23_attempts)<>10 THEN RAISE EXCEPTION 'FU23: absent-switch parity'; END IF;
 -- A flag read fault must also retain main's bounded refresh path.
 ALTER TABLE public.feature_flags RENAME COLUMN flag_name TO fu23_flag_name;
 v:=public.job_truth_weekly_draw('2029-02-19',5);
 ALTER TABLE public.feature_flags RENAME COLUMN fu23_flag_name TO flag_name;
 IF v->>'jobs'<>'5' OR (SELECT count(*) FROM fu23_attempts)<>15 THEN RAISE EXCEPTION 'FU23: unreadable-switch parity'; END IF;
END $c$;
SELECT 'PASS FU23 case 3: fresh reuse, three stale causes, missing coverage, failures, office edit, retry and switch-off' AS result;

-- The one added page/mark query must use bounded indexes under the normal
-- planner, not merely have a correctly named index. No planner switch is set.
CREATE TEMP TABLE fu23_plan_jobs AS SELECT
 ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid AS id FROM generate_series(24000,25999) n;
INSERT INTO public.jobs(id,org_id,job_number,type,status)
 SELECT id,'00000000-0000-0000-0000-000000000001','ZZTEST-PLAN-'||id,'fencing','accepted' FROM fu23_plan_jobs;
INSERT INTO public.job_change_marks_base(job_id) SELECT id FROM fu23_plan_jobs;
INSERT INTO public.job_change_mark_events(job_id,marked_at,source) SELECT id,now(),'FU23 plan' FROM fu23_plan_jobs;
INSERT INTO public.job_pages(job_id,page,built_at,build_ms,status) SELECT id,'{}',now(),0,'ready' FROM fu23_plan_jobs;
ANALYZE public.jobs;
ANALYZE public.job_pages;
ANALYZE public.job_change_marks_base;
ANALYZE public.job_change_mark_events;
DO $plan$
DECLARE p jsonb; t text; nodes jsonb;
BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE,FORMAT JSON)
 SELECT p.page FROM public.job_pages p JOIN public.job_change_marks m ON m.job_id=p.job_id
 WHERE p.job_id='00000000-0000-4000-8000-000000023201' AND p.status='ready'
 AND p.page_version=public.job_page_version() AND p.covers_mark_version=m.mark_version
 AND p.covers_marked_at>=m.last_marked_at$q$ INTO p;
 WITH RECURSIVE walk(node) AS (
  SELECT p#>'{0,Plan}' UNION ALL
  SELECT child FROM walk CROSS JOIN LATERAL jsonb_array_elements(coalesce(node->'Plans','[]')) child
 ) SELECT jsonb_agg(node) INTO nodes FROM walk;
 FOREACH t IN ARRAY ARRAY['jobs','job_pages','job_change_marks_base','job_change_mark_events'] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'Relation Name'=t AND n->>'Node Type'='Seq Scan')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'Relation Name'=t
    AND n->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Index Scan','Bitmap Heap Scan'))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'Relation Name'=t AND (n->>'Actual Rows')::integer>2)
  THEN RAISE EXCEPTION 'FU23: unbounded page coverage query on %: %',t,p; END IF;
 END LOOP;
 RAISE NOTICE 'PASS FU23 query plan: four tables index-scanned, no Seq Scan, at most two rows per scan with 2000 unrelated jobs';
END $plan$;

-- Re-apply and down proofs stay inside this transaction and leave every body,
-- fixture, flag and table exactly as this contract found it.
\ir ../../../migrations/20261117233201_followup23_record_proof_weekly_pages.sql
\ir ../../../rollbacks/20261117233201_followup23_record_proof_weekly_pages_down.sql
DO $c$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ledger_record_candidates(uuid,text,text,timestamptz,text,text)'::regprocedure)<>'d1aa2f0d9e64903a2f28aa9c90f5dabf'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.job_truth_weekly_draw(date,integer)'::regprocedure)<>'0d7898a6f17e0f3ec5736e0a37d713a0'
 THEN RAISE EXCEPTION 'FU23: rollback did not restore main bodies'; END IF;
END $c$;
\ir ../../../migrations/20261117233201_followup23_record_proof_weekly_pages.sql
SELECT 'PASS FU23 reapply and rollback: prior bodies restored and successor re-applied inside rolled-back transaction' AS result;
ROLLBACK;
