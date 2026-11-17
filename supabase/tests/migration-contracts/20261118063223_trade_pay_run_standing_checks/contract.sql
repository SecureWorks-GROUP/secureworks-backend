BEGIN;
\ir ../../../migrations/20261118063223_trade_pay_run_standing_checks.sql
CREATE FUNCTION pg_temp.zztest_assert(ok boolean, words text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %',words; END IF;
END $$;
CREATE FUNCTION pg_temp.zztest_check(answer jsonb,code text) RETURNS jsonb
LANGUAGE sql AS $$ SELECT x FROM jsonb_array_elements(answer->'checks') x WHERE x->>'code'=$2 $$;
-- Historical bad records must be readable even when today's write guard would
-- refuse them. Fixture-only constraints/triggers are restored by ROLLBACK.
DO $$ DECLARE t text; c record; BEGIN
 FOREACH t IN ARRAY ARRAY['jobs','users','work_orders','trade_invoices','trade_invoice_lines','job_assignments','work_order_customer_variations','job_events'] LOOP
  FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid=format('public.%I',t)::regclass AND NOT tgisinternal LOOP
   EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,c.tgname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass AND contype IN ('f','c','u','x') LOOP
   EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
  END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass AND attnum>0 AND NOT attisdropped AND attnotnull AND attname<>'id' LOOP
   EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
  END LOOP;
 END LOOP;
END $$;
-- Deliberate historical corruption fixture only, restored by ROLLBACK.
DROP INDEX IF EXISTS public.uq_work_orders_job_current;
-- Inject faults into the read of real cost rows, never into the check's sums.
-- The original view and every dependent object are restored by ROLLBACK.
ALTER VIEW public.v_job_cost_events RENAME TO zztest_standing_original_cost;
CREATE TABLE public.zztest_suppressed_cost(source_id text PRIMARY KEY);
CREATE TABLE public.zztest_extra_cost AS SELECT * FROM public.zztest_standing_original_cost WITH NO DATA;
CREATE VIEW public.v_job_cost_events AS
 SELECT c.* FROM public.zztest_standing_original_cost c
 WHERE NOT EXISTS(SELECT 1 FROM public.zztest_suppressed_cost s WHERE s.source_id=c.source_id)
 UNION ALL SELECT * FROM public.zztest_extra_cost;
-- All values, identifiers and words below are made up.
INSERT INTO public.trade_pay_settings(id,inclusive_super_from) VALUES(1,'2026-11-23')
 ON CONFLICT(id) DO UPDATE SET inclusive_super_from=excluded.inclusive_super_from;
INSERT INTO public.users(id,org_id,name,role) VALUES
 ('08030000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST crew','crew');
INSERT INTO public.jobs(id,org_id,job_number,type,status)
 SELECT ('08030000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','ZZTEST-P83-'||n,'fencing','accepted'
 FROM generate_series(101,103) n;
INSERT INTO public.work_orders(id,org_id,job_id,kind,status,agreed_labour_ex)
 SELECT ('08030000-0000-4000-8000-'||lpad((n+100)::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001',('08030000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'job','draft',1000 FROM generate_series(101,103) n;
INSERT INTO public.trade_invoices(id,org_id,user_id,invoice_number,week_start,status,
 submitted_at,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis)
 SELECT ('08030000-0000-4000-8000-'||lpad((n+300)::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','08030000-0000-4000-8000-000000000001',
 'ZZTEST-P83-'||n,'2026-11-16','pending_ops_review',('2026-11-16 01:00Z'::timestamptz+n*interval '1 minute'),
 n*112,n*112,0,n*112,false,.12,n*12,n*100,'inclusive_12_112_v1' FROM generate_series(1,3) n;
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,job_number,job_work_order_id,line_type,line_total_ex,sent_amount_ex,description)
 SELECT ('08030000-0000-4000-8000-'||lpad((n+400)::text,12,'0'))::uuid,
 ('08030000-0000-4000-8000-'||lpad((n+300)::text,12,'0'))::uuid,
 ('08030000-0000-4000-8000-'||lpad((n+100)::text,12,'0'))::uuid,'ZZTEST-P83-'||(n+100),
 ('08030000-0000-4000-8000-'||lpad((n+200)::text,12,'0'))::uuid,'labour',n*112,n*112,'ZZTEST labour'
 FROM generate_series(1,3) n;
DO $$
DECLARE
 org uuid := '00000000-0000-0000-0000-000000000001';
 i1 uuid := '08030000-0000-4000-8000-000000000301';
 i2 uuid := '08030000-0000-4000-8000-000000000302';
 i3 uuid := '08030000-0000-4000-8000-000000000303';
 ids uuid[] := ARRAY[i1,i2,i3]; r jsonb; c jsonb; stage text; terminal text; finish_at timestamptz; event_kind text; payload jsonb;
BEGIN
 FOREACH stage IN ARRAY ARRAY['before_xero','after_xero'] LOOP
  r := public.trade_pay_run_standing_checks(org,ids,stage);
  PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'checks')=6 AND r->'stopped_invoices'='[]' AND r->'run_blocked'='false','clean three at '||stage);
  PERFORM pg_temp.zztest_assert(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'checks') item WHERE item->'pass'<>'true'),'six clean checks at '||stage);
 END LOOP;
 c := pg_temp.zztest_check(r,'pay_equals_job_cost');
 PERFORM pg_temp.zztest_assert((c->>'expected')::numeric=672 AND (c->>'actual')::numeric=672,'clean cost does not read the three stored amounts');
 -- Old 6/6 and full employer-share invoices are still eligible for runs.
 INSERT INTO public.feature_flags(flag_name,enabled) VALUES('job_cost_employer_super_v1',true)
 ON CONFLICT(flag_name) DO UPDATE SET enabled=true;
 UPDATE public.trade_invoices SET super_basis=NULL,super_amount=13.44,net_pay=105.28 WHERE id=i1;
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 c := pg_temp.zztest_check(r,'pay_equals_job_cost');
 PERFORM pg_temp.zztest_assert(r->'stopped_invoices'='[]' AND r->'run_blocked'='false'
  AND (c->>'expected')::numeric=678.72 AND (c->>'actual')::numeric=678.72,'old 6/6 employer super must pass both invoice and clean run costs');
 UPDATE public.trade_invoices SET net_pay=112 WHERE id=i1;
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 c := pg_temp.zztest_check(r,'pay_equals_job_cost');
 PERFORM pg_temp.zztest_assert(r->'stopped_invoices'='[]' AND r->'run_blocked'='false'
  AND (c->>'expected')::numeric=685.44 AND (c->>'actual')::numeric=685.44,'old full employer share must pass');
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_cost_employer_super_v1';
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 PERFORM pg_temp.zztest_assert((pg_temp.zztest_check(r,'pay_equals_job_cost')->>'expected')::numeric=672
  AND r->'stopped_invoices'='[]' AND r->'run_blocked'='false','employer switch off must exclude company rows on both sides');
 UPDATE public.trade_invoices SET super_basis='inclusive_12_112_v1',super_amount=12,net_pay=100 WHERE id=i1;
 -- The cap consumes the same status catalogue and office amount as the sorter.
 UPDATE public.work_orders SET agreed_labour_ex=112 WHERE id='08030000-0000-4000-8000-000000000201';
 UPDATE public.trade_invoice_lines SET override_amount=112.01 WHERE trade_invoice_id=i1;
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(r#>>'{stopped_invoices,0,invoice_id}'=i1::text
  AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_nobody_above_work_order','office override above cap must count');
 UPDATE public.trade_invoice_lines SET override_amount=111 WHERE trade_invoice_id=i1;
 UPDATE public.work_orders SET agreed_labour_ex=111 WHERE id='08030000-0000-4000-8000-000000000201';
 PERFORM pg_temp.zztest_assert(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices'='[]','office override at cap must pass');
 UPDATE public.trade_invoice_lines SET override_amount=NULL WHERE trade_invoice_id=i1;
 UPDATE public.work_orders SET agreed_labour_ex=112 WHERE id='08030000-0000-4000-8000-000000000201';
 INSERT INTO public.trade_invoices(id,org_id,invoice_number,status,invoice_kind)
 VALUES('08030000-0000-4000-8000-000000000399',org,'ZZTEST-HISTORY','voided','standard');
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,office_review_status)
 VALUES('08030000-0000-4000-8000-000000000399','08030000-0000-4000-8000-000000000101','labour',.01,'rejected');
 PERFORM pg_temp.zztest_assert(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices'='[]','non-catalogue invoice must not count against cap');
 UPDATE public.trade_invoices SET status='queried',submitted_at='2026-11-15 01:00Z' WHERE id='08030000-0000-4000-8000-000000000399';
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(r#>>'{stopped_invoices,0,invoice_id}'=i1::text,'office-rejected historical standard line counts against cap');
 DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id='08030000-0000-4000-8000-000000000399';
 DELETE FROM public.trade_invoices WHERE id='08030000-0000-4000-8000-000000000399';
 -- Two live orders are unresolved, not two copies of the same billed history.
 INSERT INTO public.work_orders(id,org_id,job_id,kind,status,agreed_labour_ex)
 VALUES('08030000-0000-4000-8000-000000000299',org,'08030000-0000-4000-8000-000000000101','job','draft',1000);
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 c := pg_temp.zztest_check(r,'nobody_above_work_order');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1
  AND r#>>'{stopped_invoices,0,invoice_id}'=i1::text AND (c->>'actual')::numeric=672
  AND c->>'words' LIKE '%more than one live work order%' AND r->'run_blocked'='false','multiple work orders must isolate one invoice without multiplying sums');
 DELETE FROM public.work_orders WHERE id='08030000-0000-4000-8000-000000000299';
 PERFORM pg_temp.zztest_assert(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices'='[]','office correction must clear ambiguous work order on retry');
 UPDATE public.work_orders SET agreed_labour_ex=1000 WHERE id='08030000-0000-4000-8000-000000000201';
 -- A one-cent super fault holds only the affected invoice.
 UPDATE public.trade_invoices SET super_amount=24.01 WHERE id=i2;
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1 AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text
  AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_super_is_12_over_112' AND r->'run_blocked'='false','one-cent super fault was not isolated');
 UPDATE public.trade_invoices SET super_amount=24 WHERE id=i2;
 -- Director ruling: exactly one cent above the allowance stops the later one.
 UPDATE public.trade_invoice_lines SET job_id='08030000-0000-4000-8000-000000000101',job_work_order_id='08030000-0000-4000-8000-000000000201' WHERE trade_invoice_id=i2;
 UPDATE public.work_orders SET agreed_labour_ex=335.99 WHERE id='08030000-0000-4000-8000-000000000201';
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1 AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text
  AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_nobody_above_work_order','one-cent excess did not stop the later invoice');
 UPDATE public.work_orders SET agreed_labour_ex=336 WHERE id='08030000-0000-4000-8000-000000000201';
 PERFORM pg_temp.zztest_assert(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices'='[]','exact allowance was stopped');
 UPDATE public.trade_invoice_lines SET job_id='08030000-0000-4000-8000-000000000102',job_work_order_id='08030000-0000-4000-8000-000000000202' WHERE trade_invoice_id=i2;
 UPDATE public.work_orders SET agreed_labour_ex=1000 WHERE id='08030000-0000-4000-8000-000000000201';
 -- Follow-up 27 item 6: before the start skips; on/after it stops.
 UPDATE public.work_orders SET agreed_labour_ex=NULL WHERE id='08030000-0000-4000-8000-000000000202';
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(r#>>'{stopped_invoices,0,invoice_id}'=i2::text AND
  r#>>'{stopped_invoices,0,stops,0,code}'='standing_no_paid_line_without_work_order','missing work order amount was paid');
 FOREACH terminal IN ARRAY ARRAY['complete','completed','closed','archived','cancelled','lost'] LOOP
  UPDATE public.jobs SET status=terminal WHERE id='08030000-0000-4000-8000-000000000102';
  INSERT INTO public.job_events(job_id,event_type,detail_json,created_at)
   VALUES('08030000-0000-4000-8000-000000000102','status_changed',
    jsonb_build_object('new_status',terminal),'2026-11-22 15:59:59Z');
  r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
  c := pg_temp.zztest_check(r,'no_paid_line_without_work_order');
  PERFORM pg_temp.zztest_assert(r->'stopped_invoices'='[]' AND (c->>'skipped')::int=1
   AND c->>'skipped_why'='job closed before the rule','pre-rule terminal job not skipped: '||terminal);
  -- Midnight Perth on the start date, and a later day, are not before it.
  FOREACH finish_at IN ARRAY ARRAY['2026-11-22 16:00Z'::timestamptz,'2026-11-24 01:00Z'::timestamptz] LOOP
   UPDATE public.job_events SET created_at=finish_at,
    detail_json=jsonb_build_object('to',terminal) WHERE job_id='08030000-0000-4000-8000-000000000102';
   r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
   c := pg_temp.zztest_check(r,'no_paid_line_without_work_order');
   PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1
    AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text
    AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_no_paid_line_without_work_order'
    AND (c->>'skipped')::int=0 AND r->'run_blocked'='false','on/after-rule terminal job was paid: '||terminal);
  END LOOP;
  UPDATE public.job_events SET created_at=NULL WHERE job_id='08030000-0000-4000-8000-000000000102';
  r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
  PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1,'unknown finish time was skipped');
  DELETE FROM public.job_events WHERE job_id='08030000-0000-4000-8000-000000000102';
 END LOOP;
 -- Follow-up 34 item 12: the exact trade-report writer's status_change
 -- shape and every job_cost_close status-event form share the finish boundary.
 FOR event_kind,payload,terminal IN VALUES
  ('status_change','{"status":"complete","source":"trade_report"}'::jsonb,'complete'),
  ('restoration_stage_changed','{"job_status":"complete"}'::jsonb,'complete'),
  ('callback_resolved','{}'::jsonb,'complete')
 LOOP
  UPDATE public.jobs SET status=terminal WHERE id='08030000-0000-4000-8000-000000000102';
  INSERT INTO public.job_events(job_id,event_type,detail_json,created_at)
   VALUES('08030000-0000-4000-8000-000000000102',event_kind,payload,'2026-11-22 15:59:59Z');
  r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
  PERFORM pg_temp.zztest_assert(r->'stopped_invoices'='[]'
   AND (pg_temp.zztest_check(r,'no_paid_line_without_work_order')->>'skipped')::int=1,
   'pre-rule status event not read: '||event_kind);
  UPDATE public.job_events SET created_at='2026-11-22 16:00:00Z'
   WHERE job_id='08030000-0000-4000-8000-000000000102';
  r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
  PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1
   AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text AND r->'run_blocked'='false',
   'on-rule status event skipped: '||event_kind);
  DELETE FROM public.job_events WHERE job_id='08030000-0000-4000-8000-000000000102';
 END LOOP;
 -- A later working event of any implied form defeats an old closure.
 FOREACH event_kind IN ARRAY ARRAY['quote_accepted','quote_run_declined','callback_opened'] LOOP
  INSERT INTO public.job_events(job_id,event_type,detail_json,created_at) VALUES
   ('08030000-0000-4000-8000-000000000102','status_changed','{"new_status":"complete"}','2026-11-22 15:59:59Z'),
   ('08030000-0000-4000-8000-000000000102',event_kind,'{}','2026-11-24 01:00Z');
  PERFORM pg_temp.zztest_assert(jsonb_array_length(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices')=1,
   'later implied working status was ignored: '||event_kind);
  DELETE FROM public.job_events WHERE job_id='08030000-0000-4000-8000-000000000102';
 END LOOP;
 -- Cross-writer tied evidence cannot pick the convenient terminal row.
 INSERT INTO public.job_events(job_id,event_type,detail_json,created_at) VALUES
  ('08030000-0000-4000-8000-000000000102','status_changed','{"new_status":"complete"}','2026-11-22 15:59:59Z'),
  ('08030000-0000-4000-8000-000000000102','status_change','{"status":"in_progress"}','2026-11-22 15:59:59Z');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices')=1,
  'conflicting cross-writer tie was skipped');
 DELETE FROM public.job_events WHERE job_id='08030000-0000-4000-8000-000000000102';
 -- Make-safe cancel writes makesafe_cancelled, not a status event. Its
 -- changed_at annotation is not a new source of finish-time authority.
 UPDATE public.jobs SET status='cancelled' WHERE id='08030000-0000-4000-8000-000000000102';
 INSERT INTO public.job_events(job_id,event_type,detail_json,created_at) VALUES
  ('08030000-0000-4000-8000-000000000102','makesafe_cancelled',
   '{"previous_status":"accepted","changed_at":"2026-11-22T15:59:59Z"}','2026-11-22 15:59:59Z');
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 c := pg_temp.zztest_check(r,'no_paid_line_without_work_order');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1
  AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text
  AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_no_paid_line_without_work_order'
  AND (c->>'skipped')::int=0 AND r->'run_blocked'='false','make-safe cancel without status evidence was skipped');
 DELETE FROM public.job_events WHERE job_id='08030000-0000-4000-8000-000000000102';
 -- No event, a missing start, or a later contradictory status never skips.
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1,'missing finish event was skipped');
 INSERT INTO public.job_events(job_id,event_type,detail_json,created_at) VALUES
  ('08030000-0000-4000-8000-000000000102','status_changed','{"new_status":"lost"}','2026-11-22 15:59:59Z');
 UPDATE public.trade_pay_settings SET inclusive_super_from=NULL WHERE id=1;
 PERFORM pg_temp.zztest_assert(jsonb_array_length(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices')=1,'missing start was skipped');
 UPDATE public.trade_pay_settings SET inclusive_super_from='2026-11-16' WHERE id=1;
 PERFORM pg_temp.zztest_assert(jsonb_array_length(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices')=1,'start date was hard-coded');
 UPDATE public.trade_pay_settings SET inclusive_super_from='2026-11-23' WHERE id=1;
 INSERT INTO public.job_events(job_id,event_type,detail_json,created_at) VALUES
  ('08030000-0000-4000-8000-000000000102','status_changed','{"new_status":"accepted"}','2026-11-24 01:00Z');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices')=1,'old closure hid later reopening');
 -- Equal-time conflicting events cannot choose a convenient finish fact.
 UPDATE public.job_events SET created_at='2026-11-22 15:59:59Z'
  WHERE job_id='08030000-0000-4000-8000-000000000102';
 PERFORM pg_temp.zztest_assert(jsonb_array_length(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices')=1,'tied conflicting finish was skipped');
 -- A hand correction is read afresh, with no stored skip or refusal.
 UPDATE public.work_orders SET agreed_labour_ex=1000 WHERE id='08030000-0000-4000-8000-000000000202';
 PERFORM pg_temp.zztest_assert(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices'='[]','office correction failed on retry');
 DELETE FROM public.job_events WHERE job_id='08030000-0000-4000-8000-000000000102';
 UPDATE public.jobs SET status='accepted' WHERE id='08030000-0000-4000-8000-000000000102';
 UPDATE public.work_orders SET agreed_labour_ex=1000 WHERE id='08030000-0000-4000-8000-000000000202';
 UPDATE public.trade_invoice_lines SET job_id=NULL,not_job_work_type_id='08030000-0000-4000-8000-000000000999',office_review_status='approved' WHERE trade_invoice_id=i2;
 PERFORM pg_temp.zztest_assert(public.trade_pay_run_standing_checks(org,ids,'before_xero')->'stopped_invoices'='[]','approved not-job-work was held');

 -- Follow-up 34 item 10: Job Profit resolves the source by job-number text.
 -- With an approved not-job-work marker no other check stops this invoice,
 -- so losing this cost at invoice scope used to block everybody at run scope.
 PERFORM pg_temp.zztest_assert(EXISTS(SELECT 1 FROM public.v_job_cost_events
  WHERE document_id=i2::text AND source='trade_line'
   AND source_id='08030000-0000-4000-8000-000000000402'
   AND job_id='08030000-0000-4000-8000-000000000102'),'text-matched cost fixture missing');
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 c := pg_temp.zztest_check(r,'pay_equals_job_cost');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1
  AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text
  AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_pay_equals_job_cost'
  AND (c->>'expected')::numeric=448 AND (c->>'actual')::numeric=672
  AND r->'run_blocked'='false','text-matched cost must stop only its source invoice');
 UPDATE public.trade_invoice_lines SET not_job_work_type_id=NULL,office_review_status=NULL WHERE trade_invoice_id=i2;
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1
  AND jsonb_array_length(r#>'{stopped_invoices,0,stops}')=2
  AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text AND r->'run_blocked'='false',
  'missing job and work-order evidence must stay on the same invoice');
 UPDATE public.trade_invoice_lines SET job_id='08030000-0000-4000-8000-000000000102',not_job_work_type_id=NULL,office_review_status=NULL WHERE trade_invoice_id=i2;
 PERFORM pg_temp.zztest_assert(public.trade_pay_run_standing_checks(org,ids,'after_xero')->'stopped_invoices'='[]','office job correction clears text-match refusal on retry');
 INSERT INTO public.zztest_suppressed_cost VALUES('08030000-0000-4000-8000-000000000402');
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 PERFORM pg_temp.zztest_assert(jsonb_array_length(r->'stopped_invoices')=1 AND r#>>'{stopped_invoices,0,invoice_id}'=i2::text
  AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_pay_equals_job_cost' AND r->'run_blocked'='false','missing cost stopped the whole run or vanished');
 DELETE FROM public.zztest_suppressed_cost;
 INSERT INTO public.zztest_extra_cost SELECT * FROM public.zztest_standing_original_cost WHERE document_id=i1::text AND source='trade_line';
 UPDATE public.zztest_extra_cost SET source_id='ZZTEST-orphan',amount_ex=.01;
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 PERFORM pg_temp.zztest_assert(r->'stopped_invoices'='[]' AND r->'run_blocked'='true' AND r->>'run_blocked_words' LIKE '%0.01%','unexplained extra cost failed to stop the run');
 DELETE FROM public.zztest_extra_cost;
 -- Reimbursements affect neither the super base nor the pay/job-cost comparison.
 INSERT INTO public.trade_invoice_lines(trade_invoice_id,job_id,line_type,line_total_ex,description)
 VALUES(i1,'08030000-0000-4000-8000-000000000101','reimbursement',7,'ZZTEST reimbursement');
 UPDATE public.trade_invoices SET subtotal_ex=119,gross_earned=119,net_pay=107 WHERE id=i1;
 r := public.trade_pay_run_standing_checks(org,ids,'after_xero');
 PERFORM pg_temp.zztest_assert(r->'stopped_invoices'='[]' AND r->'run_blocked'='false','reimbursement changed the standing checks');
 DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id=i1 AND line_type='reimbursement';
 UPDATE public.trade_invoices SET subtotal_ex=112,gross_earned=112,net_pay=100 WHERE id=i1;
 UPDATE public.trade_invoices SET super_basis=NULL WHERE id=i1;
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 c := pg_temp.zztest_check(r,'super_is_12_over_112');
 PERFORM pg_temp.zztest_assert(c->'pass'='true' AND (c->>'skipped')::int=1 AND c->>'skipped_why'='priced before the start date','old basis failed instead of skipping');
 UPDATE public.trade_invoices SET super_basis='inclusive_12_112_v1',send_id='08030000-0000-4000-8000-000000000501' WHERE id=i1;
 UPDATE public.trade_invoice_lines SET sent_amount_ex=112.01 WHERE trade_invoice_id=i1;
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(r#>>'{stopped_invoices,0,stops,0,code}'='standing_nothing_lost' AND r->'run_blocked'='false','unbalanced send was paid');
 UPDATE public.trade_invoice_lines SET sent_amount_ex=112 WHERE trade_invoice_id=i1;
 INSERT INTO public.job_assignments(job_id,user_id,scheduled_date,status,is_lead,added_by,self_added_status)
 VALUES('08030000-0000-4000-8000-000000000102','08030000-0000-4000-8000-000000000001','2026-11-17','scheduled',false,'self','not_accepted');
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(r#>>'{stopped_invoices,0,invoice_id}'=i2::text AND r#>>'{stopped_invoices,0,stops,0,code}'='standing_crew_accepted','off-crew invoice was paid');
 UPDATE public.trade_invoice_lines SET office_review_status='approved' WHERE trade_invoice_id=i2;
 r := public.trade_pay_run_standing_checks(org,ids,'before_xero');
 PERFORM pg_temp.zztest_assert(r->'stopped_invoices'='[]','office line approval failed to answer crew stop');
 -- A corrected refusal is re-read, with no durable state to reset.
 PERFORM pg_temp.zztest_assert(r->'run_blocked'='false','corrected retry blocked');
 UPDATE public.trade_invoices SET invoice_kind='held' WHERE id=i3;
 BEGIN
  PERFORM public.trade_pay_run_standing_checks(org,ids,'before_xero');
  RAISE EXCEPTION 'ZZTEST held invoice accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'standing_holding_invoice_given' THEN RAISE; END IF; END;
 UPDATE public.trade_invoices SET invoice_kind='standard' WHERE id=i3;
 BEGIN
  PERFORM public.trade_pay_run_standing_checks('08030000-0000-4000-8000-000000000999',ids,'before_xero');
  RAISE EXCEPTION 'ZZTEST other organisation accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'standing_invoice_not_found' THEN RAISE; END IF; END;
 -- A failed finish/settings read raises; it never invents a pre-rule skip.
 BEGIN
  ALTER TABLE public.job_events RENAME TO zztest_standing_events_unreadable;
  PERFORM public.trade_pay_run_standing_checks(org,ids,'before_xero');
  RAISE EXCEPTION 'ZZTEST failed finish read returned clean';
 EXCEPTION WHEN undefined_table THEN NULL; END;
 BEGIN
  ALTER TABLE public.trade_pay_settings RENAME TO zztest_standing_settings_unreadable;
  PERFORM public.trade_pay_run_standing_checks(org,ids,'before_xero');
  RAISE EXCEPTION 'ZZTEST failed settings read returned clean';
 EXCEPTION WHEN undefined_table THEN NULL; END;
 -- An unreadable policy cannot silently erase the status-event vocabulary.
 BEGIN
  EXECUTE 'CREATE OR REPLACE FUNCTION public.job_cost_close_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $bad$ SELECT NULL::jsonb $bad$';
  PERFORM public.trade_pay_run_standing_checks(org,ids,'before_xero');
  RAISE EXCEPTION 'ZZTEST failed status policy returned clean';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'standing_status_events_unreadable' THEN RAISE; END IF;
 END;
 -- A failed dependency read raises; it never supplies a clean empty answer.
 BEGIN
  ALTER VIEW public.v_job_cost_events RENAME TO zztest_standing_unreadable;
  PERFORM public.trade_pay_run_standing_checks(org,ids,'after_xero');
  RAISE EXCEPTION 'ZZTEST failed cost read returned clean';
 EXCEPTION WHEN undefined_table THEN NULL; END;
 PERFORM pg_temp.zztest_assert(NOT has_function_privilege('anon','public.trade_pay_run_standing_checks(uuid,uuid[],text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.trade_pay_run_standing_checks(uuid,uuid[],text)','EXECUTE')
  AND has_function_privilege('service_role','public.trade_pay_run_standing_checks(uuid,uuid[],text)','EXECUTE'),'standing check grants');
END $$;
-- Prove the selected-invoice/document reads on a populated copy by their plans,
-- with the planner's normal scan choices and no index-name assertion.
INSERT INTO public.trade_invoices(id,org_id,invoice_number,status)
 SELECT ('08030001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','ZZTEST-OTHER-'||n,'draft'
 FROM generate_series(1,5000) n;
-- Exercise the exact latest-status query against a populated event table.
INSERT INTO public.job_events(job_id,event_type,detail_json,created_at)
 SELECT ('08030001-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'status_changed','{"new_status":"complete"}','2026-11-22 15:59:59Z'
 FROM generate_series(1,5000) n;
INSERT INTO public.job_events(job_id,event_type,detail_json,created_at)
 VALUES('08030000-0000-4000-8000-000000000102','status_changed','{"new_status":"complete"}','2026-11-22 15:59:59Z');
ANALYZE public.job_events;
DO $$ DECLARE p jsonb; n jsonb; seen boolean := false; BEGIN
 EXPLAIN (ANALYZE,FORMAT JSON)
 SELECT e.created_at,e.detail_json FROM public.job_events e
 WHERE e.job_id='08030000-0000-4000-8000-000000000102'
  AND (public.job_cost_close_policy()->'status_events') ? e.event_type
 ORDER BY e.created_at DESC NULLS FIRST FETCH FIRST 1 ROW WITH TIES INTO p;
 FOR n IN SELECT value FROM jsonb_path_query(p,'$.** ? (@."Relation Name" == "job_events")') value LOOP
  seen := true;
  PERFORM pg_temp.zztest_assert(n->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan')
   AND (n->>'Actual Rows')::int<=1,'finish read is not index bounded');
 END LOOP;
 PERFORM pg_temp.zztest_assert(seen,'finish query plan did not inspect job_events');
END $$;
ANALYZE public.trade_invoices;
DO $$ DECLARE p jsonb; n jsonb; q text; BEGIN
 FOREACH q IN ARRAY ARRAY[
  $q$SELECT id FROM public.trade_invoices WHERE id='08030000-0000-4000-8000-000000000301'$q$
 ] LOOP
  EXECUTE 'EXPLAIN (ANALYZE,FORMAT JSON) '||q INTO p;
  FOR n IN SELECT value FROM jsonb_path_query(p,'$.** ? (@."Relation Name" == "trade_invoices")') value LOOP
   PERFORM pg_temp.zztest_assert(n->>'Node Type' IN ('Index Scan','Index Only Scan','Bitmap Heap Scan','Bitmap Index Scan')
    AND (n->>'Actual Rows')::int<=1,'selected invoice read is not index bounded');
  END LOOP;
 END LOOP;
END $$;
-- This is the actual after_xero cost read, through the registered view on CI
-- (the explicitly declared stand-in only on a standalone database). Record
-- the plan, including materialised trade scans, rather than claim index use
-- from an isolated cast query. The full legacy scan is an accepted read cost
-- pending director production measurement; no ineffective index is created.
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
 WITH inv AS MATERIALIZED (
  SELECT id FROM public.trade_invoices
  WHERE id=ANY(ARRAY['08030000-0000-4000-8000-000000000301'::uuid])
   AND org_id='00000000-0000-0000-0000-000000000001')
 SELECT sum(c.amount_ex) FROM public.v_job_cost_events c JOIN inv i ON c.document_id=i.id::text
 WHERE c.is_actual AND c.source IN ('trade_line','trade_employer_super');
-- Rule 15 collision: another body at this signature is never replaced by a
-- re-apply, nor dropped by the rollback. Each run inside a savepoint; with
-- ON_ERROR_ROLLBACK each later statement still runs, so the captured last
-- error is the refusal itself (a live apply stops at it).
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
SAVEPOINT zztest_collide;
CREATE OR REPLACE FUNCTION public.trade_pay_run_standing_checks(p_org_id uuid,p_invoice_ids uuid[],p_stage text)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"rule":"zztest another owner"}'::jsonb $other$;
\ir ../../../migrations/20261118063223_trade_pay_run_standing_checks.sql
ROLLBACK TO SAVEPOINT zztest_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_apply_error \gset
SAVEPOINT zztest_collide;
CREATE OR REPLACE FUNCTION public.trade_pay_run_standing_checks(p_org_id uuid,p_invoice_ids uuid[],p_stage text)
RETURNS jsonb LANGUAGE sql AS $other$ SELECT '{"rule":"zztest another owner"}'::jsonb $other$;
\ir ../../../rollbacks/20261118063223_trade_pay_run_standing_checks_down.sql
SELECT to_regprocedure('public.trade_pay_run_standing_checks(uuid,uuid[],text)') IS NOT NULL AS collide_kept \gset
ROLLBACK TO SAVEPOINT zztest_collide;
SELECT :'LAST_ERROR_MESSAGE' AS collide_down_error \gset
\set ON_ERROR_ROLLBACK off
\set ON_ERROR_STOP on
SELECT pg_temp.zztest_assert(:'collide_apply_error' LIKE '%Rule 15, another body is installed%',
 'a re-apply must refuse another body: '||:'collide_apply_error');
SELECT pg_temp.zztest_assert(:'collide_down_error' LIKE '%another body is installed%refusing to drop it%'
 AND :'collide_kept'::boolean, 'the rollback must refuse to drop another body: '||:'collide_down_error');
SELECT pg_temp.zztest_assert((SELECT md5(prosrc) FROM pg_proc
 WHERE oid='public.trade_pay_run_standing_checks(uuid,uuid[],text)'::regprocedure)='b734f7d74eecc7dfee162613f38935a4',
 'own body restored after the collision proofs');
\ir ../../../rollbacks/20261118063223_trade_pay_run_standing_checks_down.sql
SELECT pg_temp.zztest_assert(to_regprocedure('public.trade_pay_run_standing_checks(uuid,uuid[],text)') IS NULL,'rollback left the function');

ROLLBACK;
DO $$ BEGIN
 IF to_regclass('public.uq_work_orders_job_current') IS NULL THEN
  RAISE EXCEPTION 'ZZTEST rollback did not restore the work order unique index';
 END IF;
END $$;
SELECT 'PASS: P1-08.3 six standing checks, invoice stops, whole-run stop and rollback' AS result;
