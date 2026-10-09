-- Prerequisites for 20261009130000_job_profit_engine.
-- Only the tables and columns the engine reads. Earlier registered cases
-- create most of these (v_trade_charge_resolved is the real view from
-- 20260831021701; job_quote_values is the real function from 20260923233000),
-- so every statement here is additive and idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS job_number text,
  ADD COLUMN IF NOT EXISTS client_name text,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS metadata jsonb,
  ADD COLUMN IF NOT EXISTS pricing_json jsonb,
  ADD COLUMN IF NOT EXISTS expected_costs jsonb,
  ADD COLUMN IF NOT EXISTS legacy boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS name text;

CREATE TABLE IF NOT EXISTS public.trade_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS org_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS week_start date,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS subtotal_ex numeric,
  ADD COLUMN IF NOT EXISTS xero_bill_id text,
  ADD COLUMN IF NOT EXISTS xero_bill_status text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS paid_at date;

CREATE TABLE IF NOT EXISTS public.trade_invoice_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS trade_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS line_total_ex numeric;

DO $$
BEGIN
  IF to_regclass('public.v_invoice_line_completeness') IS NULL THEN
    -- Production shape (live pg_get_viewdef, 2026-10-09).
    EXECUTE $v$
      CREATE VIEW public.v_invoice_line_completeness AS
      SELECT ti.id AS trade_invoice_id,
             ti.user_id,
             ti.week_start,
             ti.subtotal_ex,
             COALESCE(sum(til.line_total_ex), 0::numeric) AS lines_total_ex,
             count(til.id) AS line_count,
             count(til.id) = 0 AS zero_line,
             abs(COALESCE(ti.subtotal_ex, 0::numeric) - COALESCE(sum(til.line_total_ex), 0::numeric)) > 0.01 AS mismatch
      FROM public.trade_invoices ti
      LEFT JOIN public.trade_invoice_lines til ON til.trade_invoice_id = ti.id
      GROUP BY ti.id, ti.user_id, ti.week_start, ti.subtotal_ex
    $v$;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.xero_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS xero_invoice_id text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS invoice_type text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS sub_total numeric,
  ADD COLUMN IF NOT EXISTS total numeric,
  ADD COLUMN IF NOT EXISTS amount_paid numeric,
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS fully_paid_on date,
  ADD COLUMN IF NOT EXISTS line_items jsonb,
  ADD COLUMN IF NOT EXISTS raw_json jsonb,
  ADD COLUMN IF NOT EXISTS job_id uuid;

CREATE TABLE IF NOT EXISTS public.xero_projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.xero_projects
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS total_expenses numeric,
  ADD COLUMN IF NOT EXISTS total_invoiced numeric;

CREATE TABLE IF NOT EXISTS public.job_materials_facts (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_materials_facts
  ADD COLUMN IF NOT EXISTS xero_invoice_id text,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS lane text,
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS amount_ex_gst numeric,
  ADD COLUMN IF NOT EXISTS confidence text,
  ADD COLUMN IF NOT EXISTS automation_source text,
  ADD COLUMN IF NOT EXISTS match_reason text,
  ADD COLUMN IF NOT EXISTS fact_date date,
  ADD COLUMN IF NOT EXISTS matched_po_id uuid;

CREATE TABLE IF NOT EXISTS public.purchase_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS po_number text,
  ADD COLUMN IF NOT EXISTS supplier_name text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS subtotal numeric,
  ADD COLUMN IF NOT EXISTS total numeric,
  ADD COLUMN IF NOT EXISTS delivery_date date,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS xero_bill_id text,
  ADD COLUMN IF NOT EXISTS invoice_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.job_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_documents
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS type text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.quote_revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.quote_revisions
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS job_document_id uuid,
  ADD COLUMN IF NOT EXISTS version integer,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS totals_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS internal_cost_snapshot_json jsonb;

CREATE TABLE IF NOT EXISTS public.job_variations (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_variations
  ADD COLUMN IF NOT EXISTS job_id uuid,
  ADD COLUMN IF NOT EXISTS variation_number integer,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS amount numeric,
  ADD COLUMN IF NOT EXISTS gst_included boolean,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.makesafe_job_details (job_id uuid PRIMARY KEY);
ALTER TABLE public.makesafe_job_details ADD COLUMN IF NOT EXISTS report_type text;
