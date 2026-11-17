BEGIN;
SET LOCAL statement_timeout = '120s';
\ir ../../../migrations/20261118024515_group_claims_escalate.sql
CREATE FUNCTION pg_temp.zztest_group_fixture() RETURNS uuid LANGUAGE plpgsql AS $fixture$
DECLARE job uuid:=gen_random_uuid(); wo uuid:=gen_random_uuid(); grp uuid:=gen_random_uuid();
 org uuid:='00000000-0000-0000-0000-000000000001';
BEGIN
 INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','draft','ZZTEST-P4');
 INSERT INTO public.work_orders(id,org_id,job_id,wo_number,kind,status,agreed_labour_ex,scope_items)
  VALUES(wo,org,job,'ZZTEST-escalation-WO','job','draft',2240,'[]');
 INSERT INTO public.group_work_orders(id,org_id,job_id,work_order_id,share_token)
  VALUES(grp,org,job,wo,'ZZTEST-P4-share-token');
 RETURN grp;
END $fixture$;
CREATE TEMP TABLE zztest_claim_items(kind text, subject_table text, subject_id text,
 job_ids uuid[], suggestion jsonb, evidence jsonb, raised_by text);
-- Transaction-scoped office writer stand-in records the exact envelope.
CREATE OR REPLACE FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)
RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO pg_temp.zztest_claim_items VALUES($1,$2,$3,$4,$5,$6,$7);
 RETURN gen_random_uuid();
END $$;
DO $$ DECLARE grp uuid; n int; invoices bigint; BEGIN
 grp := pg_temp.zztest_group_fixture();
 SELECT count(*) INTO invoices FROM public.trade_invoices;
 UPDATE public.group_work_orders SET claim_state='waiting_hours',
  claim_deadline_at=now()-interval '1 hour' WHERE id=grp;
 UPDATE public.feature_flags SET enabled=false WHERE flag_name='group_claim_flow_v1';
 IF public.group_claims_escalate_due() <> 0 OR EXISTS(SELECT 1 FROM pg_temp.zztest_claim_items) THEN
  RAISE EXCEPTION 'ZZTEST switch off changed a claim'; END IF;
 DELETE FROM public.feature_flags WHERE flag_name='group_claim_flow_v1';
 IF public.group_claims_escalate_due()<>0 THEN RAISE EXCEPTION 'ZZTEST missing flag moved a claim'; END IF;
 INSERT INTO public.feature_flags(flag_name,enabled) VALUES('group_claim_flow_v1',true);
 n := public.group_claims_escalate_due();
 IF n<>1 OR (SELECT claim_state FROM public.group_work_orders WHERE id=grp)<>'with_office'
  OR (SELECT count(*) FROM public.group_work_order_events WHERE group_id=grp AND action='escalate'
       AND detail->>'previous_state'='waiting_hours')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_temp.zztest_claim_items WHERE kind='group_claim_no_agreement'
    AND subject_table='group_work_orders' AND subject_id=grp::text
    AND evidence->>'reason'='group_no_answer_48h' AND (evidence->>'amount_ex')::numeric=2240
    AND evidence->'summary'->>'job_number'='ZZTEST-P4' AND raised_by='phase1:group_claim')
  OR (SELECT count(*) FROM public.trade_invoices)<>invoices THEN
  RAISE EXCEPTION 'ZZTEST past deadline did not escalate once without invoicing'; END IF;
 IF public.group_claims_escalate_due()<>0 OR (SELECT count(*) FROM pg_temp.zztest_claim_items)<>1 THEN
  RAISE EXCEPTION 'ZZTEST retry duplicated escalation'; END IF;
 UPDATE public.group_work_orders SET claim_state='waiting_approval',
  claim_deadline_at=now()+interval '1 hour' WHERE id=grp;
 IF public.group_claims_escalate_due()<>0 THEN RAISE EXCEPTION 'ZZTEST future deadline moved'; END IF;
 -- The office's manual decision takes precedence over an old deadline.
 UPDATE public.group_work_orders SET claim_state='invoiced',claim_deadline_at=now()-interval '1 hour' WHERE id=grp;
 IF public.group_claims_escalate_due()<>0 THEN RAISE EXCEPTION 'ZZTEST manual settled claim moved'; END IF;
 UPDATE public.group_work_orders SET claim_state='disputed' WHERE id=grp;
 n := public.group_claims_escalate_due();
 IF n<>1 OR NOT EXISTS(SELECT 1 FROM pg_temp.zztest_claim_items
    WHERE evidence->>'reason'='group_split_disputed') THEN
  RAISE EXCEPTION 'ZZTEST dispute reason missing'; END IF;
END $$;
UPDATE public.work_orders SET agreed_labour_ex=NULL WHERE wo_number='ZZTEST-escalation-WO';
UPDATE public.group_work_orders SET claim_state='waiting_hours',claim_deadline_at=now()-interval '1 hour'
 WHERE share_token='ZZTEST-P4-share-token';
DO $$ DECLARE n int; BEGIN
 n:=public.group_claims_escalate_due();
 IF n<>1 OR NOT EXISTS(SELECT 1 FROM pg_temp.zztest_claim_items WHERE evidence->'amount_ex'='null'::jsonb) THEN
  RAISE EXCEPTION 'ZZTEST missing amount was lost or invented'; END IF;
END $$;
-- A failed or absent office writer must not lose the state/event or fail the sweep.
CREATE OR REPLACE FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)
RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ZZTEST office read/write failed'; END $$;
UPDATE public.group_work_orders SET claim_state='waiting_hours',claim_deadline_at=now()-interval '1 hour'
 WHERE share_token='ZZTEST-P4-share-token';
DO $$ BEGIN
 IF public.group_claims_escalate_due()<>1 THEN
  RAISE EXCEPTION 'ZZTEST failed office writer broke sweep'; END IF;
 IF public.group_claims_escalate_due()<>0 THEN
  RAISE EXCEPTION 'ZZTEST failed office writer broke retry'; END IF;
END $$;
DROP FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text);
UPDATE public.group_work_orders SET claim_state='waiting_hours',claim_deadline_at=now()-interval '1 hour'
 WHERE share_token='ZZTEST-P4-share-token';
DO $$ BEGIN
 IF public.group_claims_escalate_due()<>1 THEN RAISE EXCEPTION 'ZZTEST absent office writer broke sweep'; END IF;
END $$;
-- Enough future rows make the due predicate selective without disabling sequential scans.
INSERT INTO public.group_work_orders(org_id,job_id,work_order_id,share_token,claim_state,claim_deadline_at)
 SELECT g.org_id,g.job_id,gen_random_uuid(),'ZZTEST-escalate-'||i,'waiting_hours',
  CASE WHEN i<=51 THEN now()-interval '2 hours' ELSE now()+interval '1 year' END
 FROM public.group_work_orders g CROSS JOIN generate_series(1,10000) i
 WHERE g.share_token='ZZTEST-P4-share-token';
ANALYZE public.group_work_orders;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
 SELECT id FROM public.group_work_orders
 WHERE claim_state IN ('waiting_hours','waiting_approval','disputed') AND claim_deadline_at<=now()
 ORDER BY claim_deadline_at LIMIT 50 FOR UPDATE SKIP LOCKED;
DO $$ DECLARE plan jsonb; BEGIN
 EXECUTE $q$EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM public.group_work_orders
  WHERE claim_state IN ('waiting_hours','waiting_approval','disputed') AND claim_deadline_at<=now()
  ORDER BY claim_deadline_at LIMIT 50 FOR UPDATE SKIP LOCKED$q$ INTO plan;
 IF plan::text LIKE '%Seq Scan%' OR plan::text NOT LIKE '%Index Scan%'
    OR (plan->0->'Plan'->>'Actual Rows')::int<>50 THEN
  RAISE EXCEPTION 'ZZTEST due select is not index-bound at 50 rows: %',plan; END IF;
 IF public.group_claims_escalate_due()<>50 THEN RAISE EXCEPTION 'ZZTEST sweep exceeded 50'; END IF;
 IF public.group_claims_escalate_due()<>1 THEN RAISE EXCEPTION 'ZZTEST sweep lost remainder'; END IF;
 IF public.group_claims_escalate_due()<>0 THEN RAISE EXCEPTION 'ZZTEST sweep retry repeated'; END IF;
 IF has_function_privilege('anon','public.group_claims_escalate_due()','EXECUTE')
  OR has_function_privilege('authenticated','public.group_claims_escalate_due()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.group_claims_escalate_due()','EXECUTE') THEN
  RAISE EXCEPTION 'ZZTEST sweep authority changed'; END IF;
END $$;
-- Scheduler adapter only; PostgreSQL service in CI has no pg_cron extension.
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $cron$
 INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3)
 ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid;
$cron$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $cron$
 WITH removed AS(DELETE FROM cron.job WHERE jobid=$1 RETURNING 1) SELECT EXISTS(SELECT 1 FROM removed);
$cron$;
\ir ../../../migrations/20261118024515_group_claims_escalate.sql
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cron.job) THEN RAISE EXCEPTION 'ZZTEST merge installed a schedule'; END IF;
END $$;
SELECT public.install_group_claims_escalate();
SELECT public.install_group_claims_escalate();
DO $$ BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='group-claims-escalate'
   AND schedule='*/15 * * * *' AND command='SELECT public.group_claims_escalate_due();')<>1 THEN
  RAISE EXCEPTION 'ZZTEST repeated install differs from one timer'; END IF;
END $$;
\ir ../../../rollbacks/20261118024515_group_claims_escalate_down.sql
\ir rollback-contract.sql
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='group-claims-escalate') THEN
  RAISE EXCEPTION 'ZZTEST rollback kept the timer'; END IF;
END $$;
SELECT 'PASS: P1-13.9 due state, retry, office failures, 50-row bound and indexed plan' AS result;
ROLLBACK;
