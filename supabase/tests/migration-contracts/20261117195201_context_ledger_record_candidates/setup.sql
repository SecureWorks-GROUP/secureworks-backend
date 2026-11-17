-- Minimal standalone prerequisites; IF NOT EXISTS preserves the registered stack.
DO $roles$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;
CREATE TABLE IF NOT EXISTS public.organisations(id uuid PRIMARY KEY,name text);
INSERT INTO public.organisations(id,name) VALUES('00000000-0000-0000-0000-000000000001','ZZTEST') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.jobs(id uuid PRIMARY KEY,org_id uuid,type text,status text,job_number text,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.context_extraction_runs(id uuid PRIMARY KEY);
SELECT to_regclass('public.context_ledger_items') IS NULL AS record_needs_model \gset
\if :record_needs_model
\ir ../../../migrations/20261006010000_context_ledger_model.sql
\endif
ALTER TABLE public.context_ledger_items ADD COLUMN IF NOT EXISTS job_not_certain boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS public.job_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,type text,quote_number text,
 sent_at timestamptz,created_at timestamptz DEFAULT now(),viewed_at timestamptz,accepted_at timestamptz,declined_at timestamptz);
CREATE TABLE IF NOT EXISTS public.email_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,email_type text,status text,sent_at timestamptz,metadata jsonb,recipient text,sender text);
CREATE TABLE IF NOT EXISTS public.xero_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,org_id uuid,xero_invoice_id text,
 invoice_type text,status text,invoice_number text,invoice_date date,fully_paid_on date,created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.job_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,user_id uuid,status text,
 is_ghost boolean DEFAULT false,role text,scheduled_date date,created_at timestamptz DEFAULT now(),completed_at timestamptz,started_at timestamptz);
CREATE TABLE IF NOT EXISTS public.job_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,event_type text,created_at timestamptz,detail_json jsonb);
CREATE TABLE IF NOT EXISTS public.feature_flags(flag_name text PRIMARY KEY,enabled boolean,description text);
-- Use the actual store allow-list and paid-time helper, not hand-written stand-ins.
SELECT to_regprocedure('public.context_ledger_job_event_closes(text,text)') IS NULL AS record_needs_events \gset
\if :record_needs_events
CREATE OR REPLACE FUNCTION public.context_ledger_job_event_closes(p_event_type text, p_closes_on text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(CASE p_closes_on
  WHEN 'quote_sent' THEN p_event_type OPERATOR(pg_catalog.=) 'quote_sent'
  WHEN 'invoice_issued' THEN p_event_type OPERATOR(pg_catalog.=) ANY (ARRAY['invoice.emailed', 'acceptance_invoice_sent', 'payment_link_sent'])
  WHEN 'payment' THEN p_event_type OPERATOR(pg_catalog.=) ANY (ARRAY['payment_received', 'payment_recorded'])
  WHEN 'visit' THEN p_event_type OPERATOR(pg_catalog.=) ANY (ARRAY['clock.clock_on', 'clock.clock_off', 'makesafe_report_submitted',
   'roof_report_submitted'])
  WHEN 'work_done' THEN p_event_type OPERATOR(pg_catalog.=) ANY (ARRAY['clock.clock_off', 'makesafe_report_submitted'])
  END, false)
$$;
\endif
SELECT to_regprocedure('public.context_ledger_paid_close_at(timestamptz)') IS NULL AS record_needs_paid \gset
\if :record_needs_paid
CREATE OR REPLACE FUNCTION public.context_ledger_paid_close_at(p_paid_at timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT CASE WHEN p_paid_at IS NOT NULL
  THEN least((((p_paid_at AT TIME ZONE 'Australia/Perth')::date + 1)::timestamp AT TIME ZONE 'Australia/Perth') - interval '1 second', now()) END
$$;
\endif

\if :{?record_fixture_seed}
SET LOCAL session_replication_role=replica;
INSERT INTO public.jobs(id,org_id,type,status,job_number,created_at)
SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','fencing','accepted','ZZTEST-'||n,'2026-10-01T00:00:00+08'
FROM generate_series(401,412) n;
INSERT INTO public.context_ledger_generations(id,job_id,kind,status,reader,promoted_at)
SELECT id,id,'rebuild','live','fixture',now() FROM public.jobs WHERE job_number BETWEEN 'ZZTEST-401' AND 'ZZTEST-412';
INSERT INTO public.context_ledger_items(id,generation_id,job_id,item_key,item_type,status,from_role,what,about_key,opened_at,opened_by,closes_on,written_by)
SELECT id,id,id,'request:fixture:'||job_number,'request','open',CASE WHEN job_number='ZZTEST-403' THEN 'us' ELSE 'customer' END,
 'A record is due.',CASE WHEN job_number IN ('ZZTEST-402','ZZTEST-410') THEN 'invoice:inv-9002'
 WHEN job_number='ZZTEST-401' THEN 'quote:q-9001' ELSE 'other:fixture' END,
 '2026-11-03T09:00:00+08','[{"table":"job_events","id":"00000000-0000-4000-8000-000000000499"}]',
 CASE WHEN job_number IN ('ZZTEST-402','ZZTEST-403','ZZTEST-404','ZZTEST-410') THEN 'payment'
 WHEN job_number='ZZTEST-407' THEN 'booking_made' ELSE 'quote_sent' END,'model:fixture'
FROM public.jobs WHERE job_number BETWEEN 'ZZTEST-401' AND 'ZZTEST-412';
INSERT INTO public.job_documents(id,job_id,type,quote_number,sent_at)
SELECT id,id,'quote','Q-9001',CASE WHEN job_number='ZZTEST-405' THEN '2026-11-01T10:00:00+08'::timestamptz
 ELSE '2026-11-04T10:00:00+08'::timestamptz END
FROM public.jobs WHERE job_number IN ('ZZTEST-401','ZZTEST-405','ZZTEST-406','ZZTEST-408','ZZTEST-409','ZZTEST-411','ZZTEST-412');
INSERT INTO public.xero_invoices(id,job_id,org_id,xero_invoice_id,invoice_type,status,invoice_number,invoice_date,fully_paid_on)
SELECT id,id,org_id,'ZZTEST-'||job_number,CASE WHEN job_number='ZZTEST-403' THEN 'ACCPAY' ELSE 'ACCREC' END,
 'PAID','INV-9002','2026-11-04','2026-11-05' FROM public.jobs
WHERE job_number IN ('ZZTEST-402','ZZTEST-403','ZZTEST-404','ZZTEST-410');
INSERT INTO public.xero_invoices(job_id,org_id,xero_invoice_id,invoice_type,status,invoice_number,invoice_date,fully_paid_on)
VALUES('00000000-0000-4000-8000-000000000404','00000000-0000-0000-0000-000000000001','ZZTEST-second','ACCREC','PAID','INV-9003','2026-11-04','2026-11-06');
INSERT INTO public.job_assignments(id,job_id,user_id,status,scheduled_date,created_at)
VALUES('00000000-0000-4000-8000-000000000407','00000000-0000-4000-8000-000000000407','00000000-0000-4000-8000-000000000499','cancelled','2026-11-06','2026-11-04T10:00:00+08');
INSERT INTO public.feature_flags(flag_name,enabled,description) VALUES('context_record_close_v1',false,'ZZTEST')
ON CONFLICT(flag_name) DO UPDATE SET enabled=false;
SET LOCAL session_replication_role=origin;
\endif
