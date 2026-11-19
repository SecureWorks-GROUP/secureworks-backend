BEGIN;
-- 20261119090200 adds a pay run check to the reject body this case pins:
-- stand this case's body back up first (a no-op while that change is absent).
-- Its 5 s limits are put back so this case keeps the runner's own.
\ir ../../../rollbacks/20261119090200_trade_invoice_reject_pay_run_down.sql
RESET statement_timeout;
RESET lock_timeout;
-- Exercise the same query with a controlled history. Restore the original
-- tables, indexes, grants and functions together at the transaction boundary.
CREATE SCHEMA effort_original;
ALTER TABLE public.trade_invoices SET SCHEMA effort_original;
ALTER TABLE public.trade_invoice_lines SET SCHEMA effort_original;
ALTER TABLE public.job_assignments SET SCHEMA effort_original;
CREATE TABLE public.trade_invoices AS TABLE effort_original.trade_invoices WITH NO DATA;
CREATE TABLE public.trade_invoice_lines AS TABLE effort_original.trade_invoice_lines WITH NO DATA;
CREATE TABLE public.job_assignments AS TABLE effort_original.job_assignments WITH NO DATA;
ALTER TABLE public.trade_invoices ADD PRIMARY KEY(id);
CREATE INDEX ON public.trade_invoice_lines(trade_invoice_id);
CREATE INDEX ON public.job_assignments(job_id,user_id,scheduled_date);
DROP FUNCTION IF EXISTS public.pay_effort_stats(uuid,integer);
\ir ../../../migrations/20261118153104_pay_effort_stats.sql

DO $proof$ DECLARE
  org uuid := gen_random_uuid(); trade uuid := gen_random_uuid(); job uuid := gen_random_uuid();
  target uuid; monday date := date_trunc('week', now() AT TIME ZONE 'Australia/Perth')::date;
  weeks jsonb; w jsonb; q text; plan jsonb;
BEGIN
  IF has_function_privilege('authenticated','public.pay_effort_stats(uuid,integer)','EXECUTE')
    OR has_function_privilege('anon','public.pay_effort_stats(uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'effort_browser_grant';
  END IF;
  INSERT INTO public.trade_invoices(id,user_id,org_id,week_start,status,invoice_kind,submitted_at,confirm_seconds)
    SELECT gen_random_uuid(),trade,org,monday,'approved','standard',now()-interval '2 hours',
      CASE n WHEN 1 THEN 5 WHEN 2 THEN 15 END FROM generate_series(1,40) n;
  SELECT id INTO target FROM public.trade_invoices WHERE confirm_seconds=5;
  UPDATE public.trade_invoices SET xero_adjustments_ex=1,accepted_untouched=true WHERE id=target;
  UPDATE public.trade_invoices SET office_sent_back_at=now(),auto_sent=true WHERE confirm_seconds=15;
  INSERT INTO public.job_assignments(job_id,user_id,scheduled_date,added_by,self_added_status,self_added_reviewed_at)
    VALUES(job,trade,monday,'self','not_accepted',now()-interval '1 hour');
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_total_ex,changed_from_suggestion,
    held_at,decided_at,hold_reason,office_review_status)
    VALUES(target,job,3,true,(monday-2)::timestamp AT TIME ZONE 'Australia/Perth',
      ((monday-2)::timestamp AT TIME ZONE 'Australia/Perth')+interval '2 hours','no_amount','queried');
  weeks := public.pay_effort_stats(org,2); w := weeks->0;
  IF jsonb_array_length(weeks) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'effort_weeks_missing'; END IF;
  IF NOT (w @> '{"sent":40,"sent_back_or_corrected":2,"share":0.05,"on_target":false,"auto_sent":1,
    "accepted_untouched":1,"median_confirm_seconds":10,"changed_lines":1,"no_work_order_trend":"down",
    "told_no_after_sent":{"invoices":1,"trades":1,"amount_ex":3}}') THEN RAISE EXCEPTION 'effort_two_of_forty'; END IF;
  IF NOT (weeks->1 @> '{"sent":0,"share":null,"on_target":null,"median_confirm_seconds":null,
    "no_work_order_trend":"up","held":[{"reason":"no_amount","lines":1,"waiting_now":0,
    "amount_ex":3,"oldest_wait_hours":2,"median_wait_hours":2}]}') THEN RAISE EXCEPTION 'effort_hold_week'; END IF;
  UPDATE public.trade_invoices SET office_sent_back_at=null WHERE confirm_seconds=15;
  UPDATE public.job_assignments SET self_added_reviewed_at=now()-interval '3 hours';
  IF NOT (public.pay_effort_stats(org,1)->0 @> '{"sent_back_or_corrected":1,"share":0.025,
    "on_target":true,"told_no_after_sent":{"invoices":0,"trades":0,"amount_ex":0}}') THEN
    RAISE EXCEPTION 'effort_one_of_forty'; END IF;

  INSERT INTO public.feature_flags(flag_name,enabled) VALUES ('trade_reimbursement_line_v1',true)
    ON CONFLICT (flag_name) DO UPDATE SET enabled=true;
  IF public.reject_trade_invoice_v1(target,'ZZTEST','office') IS DISTINCT FROM target
    OR EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=target AND xero_bill_id IS NOT NULL) THEN
    RAISE EXCEPTION 'effort_reject_failed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id=target AND status='ops-reject'
    AND office_sent_back_at IS NOT NULL) THEN RAISE EXCEPTION 'effort_reject_stamp_missing'; END IF;

  INSERT INTO public.trade_invoices(id,org_id,status,week_start)
    SELECT gen_random_uuid(),org,'approved',monday-364 FROM generate_series(1,3000);
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,held_at,hold_reason)
    SELECT gen_random_uuid(),now()-interval '1 year','no_amount' FROM generate_series(1,3000);
  INSERT INTO public.job_assignments(job_id,user_id,scheduled_date)
    SELECT gen_random_uuid(),trade,monday FROM generate_series(1,3000);
  ANALYZE public.trade_invoices; ANALYZE public.trade_invoice_lines; ANALYZE public.job_assignments;
  FOREACH q IN ARRAY ARRAY[
    format('SELECT * FROM public.trade_invoices WHERE org_id=%L AND status<>%L AND week_start BETWEEN %L AND %L',org,'draft',monday-7,monday),
    'SELECT * FROM public.trade_invoice_lines WHERE hold_reason IS NOT NULL AND held_at >= now()-interval ''14 days''',
    format('SELECT * FROM public.trade_invoice_lines WHERE trade_invoice_id=%L',target),
    format('SELECT * FROM public.job_assignments WHERE job_id=%L AND user_id=%L AND scheduled_date BETWEEN %L AND %L',job,trade,monday,monday+6)
  ] LOOP
    EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) '||q INTO plan;
    IF plan::text LIKE '%Seq Scan%' OR plan::text NOT LIKE '%Index%Scan%' THEN RAISE EXCEPTION 'effort_index_plan'; END IF;
  END LOOP;
END $proof$;
\ir ../../../rollbacks/20261118153104_pay_effort_stats_down.sql
DO $$ BEGIN
  IF to_regprocedure('public.pay_effort_stats(uuid,integer)') IS NOT NULL OR
    (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure)
      IS DISTINCT FROM '73c277c035c43cea9156f46bce919813' THEN RAISE EXCEPTION 'effort_rollback'; END IF;
END $$;
ROLLBACK;
