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
DROP TABLE public.feature_flags;
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
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
