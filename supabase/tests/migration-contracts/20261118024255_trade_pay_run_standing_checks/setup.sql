-- Minimal pre-existing columns support an isolated disposable case. Existing
-- registered-stack tables/views are preserved; no live setup is supported.
CREATE TABLE IF NOT EXISTS public.feature_flags(flag_name text PRIMARY KEY, enabled boolean NOT NULL, description text);
CREATE TABLE IF NOT EXISTS public.users(id uuid PRIMARY KEY, org_id uuid, name text, role text);
CREATE TABLE IF NOT EXISTS public.trade_pay_settings(id smallint PRIMARY KEY, inclusive_super_from date);
CREATE TABLE IF NOT EXISTS public.job_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid,
 event_type text, detail_json jsonb, created_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS job_events_job_created_idx ON public.job_events(job_id,created_at);
CREATE TABLE IF NOT EXISTS public.jobs(id uuid PRIMARY KEY, org_id uuid, job_number text, status text, type text);
CREATE TABLE IF NOT EXISTS public.trade_invoices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, user_id uuid, invoice_number text,
 week_start date, status text, submitted_at timestamptz, created_at timestamptz DEFAULT now(),
 subtotal_ex numeric, gross_earned numeric, net_pay numeric, super_amount numeric,
 super_basis text, super_base_ex numeric, gst numeric, total_inc numeric, gst_on boolean,
 super_rate numeric, job_grand_total_ex numeric, final_deductions_total_ex numeric,
 to_be_paid_ex numeric, recurring_deduction_amount numeric, xero_bill_id text, xero_pushed_at timestamptz);
CREATE TABLE IF NOT EXISTS public.trade_invoice_lines(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trade_invoice_id uuid, job_id uuid,
 line_type text, line_total_ex numeric, override_amount numeric, job_work_order_id uuid, office_review_status text,
 group_share_id uuid, description text, job_number text);
CREATE TABLE IF NOT EXISTS public.work_orders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid, job_id uuid, kind text,
 status text, agreed_labour_ex numeric);
CREATE TABLE IF NOT EXISTS public.work_order_customer_variations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_order_id uuid, status text, trade_allocation_ex numeric);
CREATE TABLE IF NOT EXISTS public.group_work_orders(
 id uuid PRIMARY KEY, org_id uuid, job_id uuid, work_order_id uuid, pay_basis text, split_frozen_at timestamptz);
CREATE TABLE IF NOT EXISTS public.job_assignments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid, user_id uuid,
 scheduled_date date, status text, is_lead boolean DEFAULT false);
-- These mirror existing indexes, not new product indexes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_orders_job_current ON public.work_orders(job_id) WHERE kind='job';
CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON public.trade_invoice_lines(trade_invoice_id);
CREATE INDEX IF NOT EXISTS idx_inv_lines_job ON public.trade_invoice_lines(job_id);
CREATE INDEX IF NOT EXISTS idx_wo_job ON public.work_orders(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_order_customer_variations_wo ON public.work_order_customer_variations(work_order_id) WHERE work_order_id IS NOT NULL;
SELECT to_regprocedure('public.trade_send_totals(uuid)') IS NULL AS need_hold \gset
\if :need_hold
\ir ../../../migrations/20261117173901_trade_line_hold.sql
\endif
SELECT to_regprocedure('public.trade_is_off_job_crew(uuid,uuid,date)') IS NULL AS need_crew \gset
\if :need_crew
\ir ../../../migrations/20261117173401_job_assignment_self_added.sql
\endif
SELECT to_regprocedure('public.work_order_amount_change_total(uuid)') IS NULL AS need_changes \gset
\if :need_changes
\ir ../../../migrations/20261117171802_work_order_amount_changes.sql
\endif
-- A standalone run has no Job Profit stack. This fixture models its documented
-- trade_line and employer-super projection. GitHub uses the actual registered v_job_cost_events.
SELECT to_regclass('public.v_job_cost_events') IS NULL AS need_costs \gset
\if :need_costs
CREATE VIEW public.v_job_cost_events AS
 WITH trade AS MATERIALIZED (SELECT l.job_id,l.line_total_ex amount_ex,'trade_line'::text source,
 l.id::text source_id,i.id::text document_id,true is_actual
 FROM public.trade_invoices i JOIN public.trade_invoice_lines l ON l.trade_invoice_id=i.id
 WHERE l.job_id IS NOT NULL)
 SELECT * FROM trade
 UNION ALL
 SELECT t.job_id,round(t.amount_ex*(i.super_amount-(i.subtotal_ex-i.net_pay))/i.subtotal_ex,6),
 'trade_employer_super',t.source_id||':employer_super',t.document_id,t.is_actual
 FROM trade t JOIN public.trade_invoices i ON i.id::text=t.document_id
 WHERE i.subtotal_ex>0 AND i.super_amount-(i.subtotal_ex-i.net_pay)>0.005 AND t.amount_ex<>0
 AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_cost_employer_super_v1' AND enabled);
\endif

-- Standalone-only copy of main's immutable status catalogue. The registered
-- stack keeps the real function. No production function is replaced here.
SELECT to_regprocedure('public.job_work_order_billed_invoice_statuses()') IS NULL AS need_statuses \gset
\if :need_statuses
CREATE FUNCTION public.job_work_order_billed_invoice_statuses() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY['pending_acknowledgment','queried','acknowledged','pending_ops_review','approved','pushed_to_xero','paid']::text[]
$$;
\endif
