BEGIN;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'job_cost_lines_trade_%') THEN
   RAISE EXCEPTION 'trade sync: migration installed business triggers'; END IF;
END $$;
SELECT public.job_cost_lines_install_trade_triggers();
SELECT public.job_cost_lines_remove_trade_triggers();
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE 'job_cost_lines_trade_%') THEN
   RAISE EXCEPTION 'trade sync: remove left business triggers'; END IF;
END $$;
SELECT public.job_cost_lines_install_trade_triggers();
-- Lift unrelated historical fixture guards only in this rolled-back transaction.
-- Keep the four cost-line triggers being exercised enabled.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['trade_invoices','trade_invoice_lines','users'] LOOP
    FOR c IN SELECT tgname FROM pg_trigger WHERE tgrelid=format('public.%I',t)::regclass
      AND NOT tgisinternal AND tgname NOT LIKE 'job_cost_lines_trade_%' LOOP
      EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',t,c.tgname);
    END LOOP;
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid=format('public.%I',t)::regclass
      AND contype IN ('f','c','u','x') LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
    END LOOP;
    FOR c IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',t)::regclass
      AND attnum>0 AND NOT attisdropped AND attnotnull AND attname<>'id' LOOP
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL',t,c.attname);
    END LOOP;
  END LOOP;
END $$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name IN ('job_cost_lines_sync_v1','job_cost_employer_super_v1');
INSERT INTO public.jobs(id,org_id,job_number,type,status) VALUES
  ('30000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000001','ZZTEST-990101','fencing','accepted');
INSERT INTO public.users(id,org_id,name) VALUES
  ('30000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000001','Trade');
INSERT INTO public.trade_invoices(id,org_id,user_id,week_start,status,subtotal_ex,net_pay,super_amount,invoice_number) VALUES
  ('30000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000001',
   '30000000-0000-4000-8000-000000000002','2026-11-16','approved',800,800,80,'ZZTEST-TRADE');
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,job_id,line_type,description,line_total_ex,total_hours) VALUES
  ('30000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001','labour','Work',800,1);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_id='30000000-0000-4000-8000-000000000003') THEN
   RAISE EXCEPTION 'trade sync: off wrote a line'; END IF;
END $$;
-- An unreadable shadow switch must not reject the business write.
SAVEPOINT unreadable_switch;
ALTER TABLE public.feature_flags RENAME TO cost_line_contract_flags;
UPDATE public.trade_invoice_lines SET description='Work without shadow switch'
  WHERE id='30000000-0000-4000-8000-000000000004';
UPDATE public.trade_invoices SET super_amount=80
  WHERE id='30000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines
   WHERE id='30000000-0000-4000-8000-000000000004' AND description='Work without shadow switch') THEN
   RAISE EXCEPTION 'trade sync: shadow failure rejected business write'; END IF;
 IF EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_id='30000000-0000-4000-8000-000000000003') THEN
   RAISE EXCEPTION 'trade sync: failed shadow left partial lines'; END IF;
END $$;
ROLLBACK TO SAVEPOINT unreadable_switch;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_lines_sync_v1';
-- UPDATE statement trigger drives the real view and writer, not a mocked cost document.
UPDATE public.trade_invoice_lines SET description='Work updated' WHERE id='30000000-0000-4000-8000-000000000004';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines l JOIN public.job_cost_line_parts p ON p.line_id=l.id
   WHERE l.document_id='30000000-0000-4000-8000-000000000003' AND l.state='on_job' AND l.amount_ex=800
     AND p.job_id='30000000-0000-4000-8000-000000000001' AND p.amount_ex=800) THEN
   RAISE EXCEPTION 'trade sync: labour not allocated'; END IF;
END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_employer_super_v1';
UPDATE public.trade_invoices SET super_amount=80 WHERE id='30000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines l JOIN public.job_cost_line_parts p ON p.line_id=l.id
   WHERE l.document_id='30000000-0000-4000-8000-000000000003' AND l.kind='employer_super'
     AND l.follows_line_id IS NOT NULL AND l.amount_ex=80 AND p.amount_ex=80
     AND p.job_id='30000000-0000-4000-8000-000000000001') THEN
   RAISE EXCEPTION 'trade sync: super did not follow'; END IF;
END $$;
INSERT INTO public.trade_invoice_lines(id,trade_invoice_id,line_type,description,line_total_ex) VALUES
  ('30000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000003','other','Work on no job',100);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines WHERE line_key='30000000-0000-4000-8000-000000000005'
   AND state='needs_person' AND needs_reason='trade_line_no_job') THEN
   RAISE EXCEPTION 'trade sync: unresolved line did not ask'; END IF;
END $$;
UPDATE public.trade_invoices SET status='ops-reject' WHERE id='30000000-0000-4000-8000-000000000003';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.job_cost_lines WHERE document_id='30000000-0000-4000-8000-000000000003'
     AND (state IS NOT NULL OR not_counted_reason IS DISTINCT FROM 'document_not_live'))
 OR EXISTS (SELECT 1 FROM public.job_cost_line_parts p JOIN public.job_cost_lines l ON l.id=p.line_id
     WHERE l.document_id='30000000-0000-4000-8000-000000000003') THEN
   RAISE EXCEPTION 'trade sync: rejected invoice still counted'; END IF;
END $$;
UPDATE public.trade_invoices SET status='approved' WHERE id='30000000-0000-4000-8000-000000000003';
DELETE FROM public.trade_invoice_lines WHERE id='30000000-0000-4000-8000-000000000005';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.job_cost_lines WHERE line_key='30000000-0000-4000-8000-000000000005'
   AND state IS NULL AND not_counted_reason='line_removed') THEN RAISE EXCEPTION 'trade sync: deletion still counted'; END IF;
 IF has_function_privilege('authenticated','public.job_cost_lines_sync_trade_invoice(uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'trade sync: browser execution allowed'; END IF;
END $$;
-- Identical invoice sync and trigger update must retain every allocation row.
CREATE TEMP TABLE cost_parts_before AS SELECT p.* FROM public.job_cost_line_parts p
 JOIN public.job_cost_lines l ON l.id=p.line_id WHERE l.document_id='30000000-0000-4000-8000-000000000003';
UPDATE public.trade_invoice_lines SET description=description WHERE id='30000000-0000-4000-8000-000000000004';
DO $$ BEGIN
 IF EXISTS((SELECT * FROM cost_parts_before EXCEPT SELECT p.* FROM public.job_cost_line_parts p)
   UNION ALL (SELECT p.* FROM public.job_cost_line_parts p JOIN public.job_cost_lines l ON l.id=p.line_id
     WHERE l.document_id='30000000-0000-4000-8000-000000000003' EXCEPT SELECT * FROM cost_parts_before)) THEN
   RAISE EXCEPTION 'followup8: no-op rewrote allocation rows'; END IF;
END $$;
CREATE TEMP TABLE trade_sync_definition AS SELECT pg_get_functiondef('public.job_cost_lines_sync_trade_invoice(uuid)'::regprocedure) AS body;
-- This defect is deferred, not a throw inside the stub. The trade write must
-- survive it and the malformed shadow row must roll back before commit.
CREATE OR REPLACE FUNCTION public.job_cost_lines_sync_trade_invoice(p_trade_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO public.job_cost_lines(org_id,kind,document_kind,document_id,line_key,lane,amount_ex,state,source_hash)
 VALUES('00000000-0000-0000-0000-000000000001','trade_line','trade_invoice','ZZTEST-malformed','bad','labour',1,'on_job','bad');
 RETURN '{}';
END $$;
UPDATE public.trade_invoice_lines SET description='Work after shadow failure' WHERE id='30000000-0000-4000-8000-000000000004';
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
DO $$ DECLARE result jsonb; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.trade_invoice_lines
   WHERE id='30000000-0000-4000-8000-000000000004' AND description='Work after shadow failure')
   OR EXISTS(SELECT 1 FROM public.job_cost_lines WHERE document_id='ZZTEST-malformed')
   OR NOT EXISTS(SELECT 1 FROM public.job_cost_lines_shadow_retries
     WHERE trade_invoice_id='30000000-0000-4000-8000-000000000003' AND last_sqlstate='23514') THEN
   RAISE EXCEPTION 'followup8: deferred failure escaped or was not queued'; END IF;
 result := public.job_cost_lines_retry_one();
 IF result->>'success' <> 'false' OR NOT EXISTS(SELECT 1 FROM public.job_cost_lines_shadow_retries WHERE attempts=1) THEN
   RAISE EXCEPTION 'followup8: failed retry did not back off'; END IF;
END $$;
DO $$ BEGIN EXECUTE (SELECT body FROM trade_sync_definition); END $$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='job_cost_lines_sync_v1';
DO $$ BEGIN
 IF public.job_cost_lines_retry_one()->>'reason' <> 'flag_off' OR NOT EXISTS(SELECT 1 FROM public.job_cost_lines_shadow_retries) THEN
   RAISE EXCEPTION 'followup8: off drain lost retry'; END IF;
END $$;
UPDATE public.feature_flags SET enabled=true WHERE flag_name='job_cost_lines_sync_v1';
UPDATE public.job_cost_lines_shadow_retries SET next_attempt_at=clock_timestamp()-interval '1 second';
-- Duplicate failed requests fold on a bounded drain, never a whole-table sum.
INSERT INTO public.job_cost_lines_shadow_retries(trade_invoice_id,last_sqlstate)
 VALUES('30000000-0000-4000-8000-000000000003','55P03');
DO $$ DECLARE result jsonb; BEGIN
 result := public.job_cost_lines_retry_one();
 IF result->>'success' <> 'true' OR EXISTS(SELECT 1 FROM public.job_cost_lines_shadow_retries)
 OR NOT EXISTS(SELECT 1 FROM public.job_cost_lines WHERE line_key='30000000-0000-4000-8000-000000000004'
   AND description='Work after shadow failure') THEN RAISE EXCEPTION 'followup8: retry did not converge and trim'; END IF;
 IF has_table_privilege('authenticated','public.job_cost_lines_shadow_retries','SELECT')
  OR has_table_privilege('anon','public.job_cost_lines_shadow_retries','INSERT')
  OR has_function_privilege('authenticated','public.job_cost_lines_retry_one()','EXECUTE') THEN
  RAISE EXCEPTION 'followup8: retry browser access'; END IF;
END $$;
-- Fake cron proves explicit install/remove only. All changes roll back.
SAVEPOINT schedule_proof;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text);
CREATE OR REPLACE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
 INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3)
 ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid
$$;
CREATE OR REPLACE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $$
 DELETE FROM cron.job WHERE jobid=$1 RETURNING true
$$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='job-cost-lines-shadow-retry') THEN
   RAISE EXCEPTION 'followup8: migration scheduled retry'; END IF;
END $$;
SELECT public.job_cost_lines_install_trade_triggers();
DO $$ BEGIN
 IF (SELECT count(*) FROM cron.job WHERE jobname='job-cost-lines-shadow-retry'
  AND command='SELECT public.job_cost_lines_retry_one()')<>1 THEN RAISE EXCEPTION 'followup8: install missed retry'; END IF;
END $$;
SELECT public.job_cost_lines_remove_trade_triggers();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='job-cost-lines-shadow-retry') THEN RAISE EXCEPTION 'followup8: remove left retry'; END IF;
END $$;
ROLLBACK TO SAVEPOINT schedule_proof;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
