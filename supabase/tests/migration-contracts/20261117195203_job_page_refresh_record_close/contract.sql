-- Earlier contracts restore their own historical refresh body. Stand up this
-- successor before checking it, without replacing any story/ledger function.
\if :{?page_speed_record_close_test}
\else
\ir ../../../migrations/20261117195203_job_page_refresh_record_close.sql
\endif
BEGIN;
\set record_fixture_seed true
\ir setup.sql
-- Migration itself must not have installed a business-table trigger.
DO $c$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.context_ledger_items'::regclass AND tgname='context_ledger_record_close_withdraw') THEN
 RAISE EXCEPTION 'refresh record close: migration installed trigger'; END IF;
END $c$;
-- The existing mark trigger function is production code, installed only for
-- this local rolled-back test, on the one table whose closure we exercise.
CREATE TRIGGER record_close_fixture_mark AFTER UPDATE OF status ON public.context_ledger_items
 FOR EACH ROW EXECUTE FUNCTION public.job_mark_changed_trg('notes');
SELECT public.context_ledger_record_close_install();
SELECT public.job_mark_changed('00000000-0000-4000-8000-000000000401','notes');
DO $c$
DECLARE v jsonb;
BEGIN
 -- Off keeps the previous response shape and notes. It raises no queue item.
 v:=public.job_page_refresh('00000000-0000-4000-8000-000000000401');
 IF v->>'outcome'<>'built' OR v ? 'record_close' OR NOT EXISTS(
  SELECT 1 FROM public.context_ledger_items WHERE id='00000000-0000-4000-8000-000000000401' AND status='open') THEN
 RAISE EXCEPTION 'refresh record close: off parity'; END IF;
 UPDATE public.feature_flags SET enabled=true WHERE flag_name='context_record_close_v1';
 v:=public.job_page_refresh('00000000-0000-4000-8000-000000000401');
 IF v->>'outcome'<>'built' OR v#>>'{record_close,closed}'<>'1' OR (v->'record_close') ? 'ambiguous_items'
 OR NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE id='00000000-0000-4000-8000-000000000401' AND status='closed')
 OR EXISTS(SELECT 1 FROM public.job_pages p CROSS JOIN LATERAL jsonb_array_elements(p.page#>'{summary,loops}') l
 WHERE p.job_id='00000000-0000-4000-8000-000000000401' AND l->>'item_key'='request:fixture:ZZTEST-401') THEN
 RAISE EXCEPTION 'refresh record close: T1 page not settled: %',v; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.job_change_marks WHERE job_id='00000000-0000-4000-8000-000000000401' AND page_done_at=last_marked_at) THEN
 RAISE EXCEPTION 'refresh record close: closure mark left due'; END IF;
 v:=public.job_page_refresh('00000000-0000-4000-8000-000000000404');
 IF v#>>'{record_close,ambiguous}'<>'1' OR v#>>'{record_close,closed}'<>'0' THEN
 RAISE EXCEPTION 'refresh record close: T4 first ambiguity'; END IF;
 v:=public.job_page_refresh('00000000-0000-4000-8000-000000000404');
 IF v#>>'{record_close,ambiguous}'<>'1' OR v#>>'{record_close,closed}'<>'0' THEN
 RAISE EXCEPTION 'refresh record close: T4 repeat ambiguity'; END IF;
 -- When the adapter is not yet in the registered stack, inspect the stand-in's
 -- observable queue; otherwise the returned ambiguity contract above is kept.
 IF to_regclass('public.record_close_fixture_queue') IS NOT NULL THEN
  IF (SELECT count(*) FROM public.record_close_fixture_queue WHERE subject='00000000-0000-4000-8000-000000000404' AND open
    AND jsonb_array_length(suggestions)=2)<>1 THEN RAISE EXCEPTION 'refresh record close: repeated queue item'; END IF;
 END IF;
 UPDATE public.context_ledger_items SET status='closed',closed_at=now(),closed_by='[{"table":"person","id":"fixture"}]'
 WHERE id='00000000-0000-4000-8000-000000000404';
 IF to_regclass('public.record_close_fixture_queue') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.record_close_fixture_queue WHERE subject='00000000-0000-4000-8000-000000000404' AND open) THEN
   RAISE EXCEPTION 'refresh record close: queue not withdrawn'; END IF;
 END IF;
END $c$;
-- Fault injection is rolled back; the actual close path was exercised above.
CREATE OR REPLACE FUNCTION public.context_ledger_close_on_records(p_job_id uuid,p_dry_run boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $fault$
BEGIN RAISE EXCEPTION 'ZZTEST close fault'; END $fault$;
DO $c$
DECLARE v jsonb;
BEGIN
 v:=public.job_page_refresh('00000000-0000-4000-8000-000000000408');
 IF v->>'outcome'<>'built' OR v#>>'{record_close,error}'<>'ZZTEST close fault'
 OR NOT EXISTS(SELECT 1 FROM public.job_pages WHERE job_id='00000000-0000-4000-8000-000000000408' AND status='ready') THEN
 RAISE EXCEPTION 'refresh record close: close fault blocked page: %',v; END IF;
END $c$;
SELECT 'PASS: P4-02.3 off parity, close before page and marks, one ambiguity, withdrawal and isolated fault' AS result;
ROLLBACK;

-- Leave the installed successor in place for subsequent behavior cases.
SELECT to_regprocedure('public.job_page_yield(uuid)') IS NOT NULL AS page_retry_successor_live \gset
\if :page_retry_successor_live
\if :{?page_speed_record_close_test}
\else
\ir ../../../migrations/20261117215801_job_page_speed_and_retry.sql
\endif
\endif
