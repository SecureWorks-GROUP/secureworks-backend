-- CI uses the registered prerequisites (P2-01.7, P2-02.1, P2-03.1, P2-10.1 and
-- the stored Job Profit case). The isolated local proof below builds the same
-- objects from their own migrations, with two stand-ins named here:
-- a minimal dispatch_supplier_order_emails (the columns v_job_orders and the
-- trigger read) and job_profit_mark with main's exact body over job_profit_dirty.
SELECT to_regclass('public.v_job_orders') IS NULL AS isolated_orders_setup \gset
\if :isolated_orders_setup
\ir ../20261118060051_reconcile_tables/setup.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS xero_contact_id text;
CREATE TABLE public.suppliers(id uuid PRIMARY KEY,name text,xero_contact_id text);
CREATE TABLE public.dispatch_supplier_order_emails(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,job_id uuid NOT NULL,
 supplier_id uuid NOT NULL,supplier_name text NOT NULL,status text NOT NULL DEFAULT 'draft',
 subject text NOT NULL,sent_at timestamptz,order_cost jsonb,created_at timestamptz NOT NULL DEFAULT now());
\ir ../../../migrations/20261117173501_v_job_orders.sql
\ir ../../../migrations/20261117160500_match_tables.sql
CREATE TABLE public.job_profit_dirty(job_id uuid PRIMARY KEY,reason text NOT NULL,
 marked_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.job_profit_mark(p_job_id uuid,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 IF p_job_id IS NULL THEN RETURN; END IF;
 INSERT INTO public.job_profit_dirty(job_id,reason,marked_at) VALUES(p_job_id,p_reason,clock_timestamp())
 ON CONFLICT(job_id) DO UPDATE SET reason=EXCLUDED.reason,marked_at=clock_timestamp();
END $fn$;
\endif
DO $setup$ BEGIN
 IF to_regclass('public.v_job_orders') IS NULL OR to_regclass('public.v_job_cost_events_lines') IS NULL
 OR to_regclass('public.reconcile_items') IS NULL OR to_regclass('public.match_queue') IS NULL
 OR to_regclass('public.job_profit_dirty') IS NULL
 OR to_regprocedure('public.job_profit_mark(uuid,text)') IS NULL THEN
  RAISE EXCEPTION 'P2-10.2 prerequisites missing';
 END IF;
END $setup$;
