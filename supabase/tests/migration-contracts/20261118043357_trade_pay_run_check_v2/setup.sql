-- Minimal read schema, compatible with the registered stack. No function stand-ins.
\ir ../20261116011500_trade_pay_run_check/setup.sql
\ir ../../../migrations/20261116011500_trade_pay_run_check.sql
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS super_basis text,
  ADD COLUMN IF NOT EXISTS super_base_ex numeric,
  ADD COLUMN IF NOT EXISTS gross_earned numeric,
  ADD COLUMN IF NOT EXISTS super_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS recurring_deduction_id uuid,
  ADD COLUMN IF NOT EXISTS invoice_kind text DEFAULT 'standard';
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS expense_receipt_id uuid,
  ADD COLUMN IF NOT EXISTS not_job_work_type_id uuid,
  ADD COLUMN IF NOT EXISTS office_review_status text;
ALTER TABLE public.work_orders ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS kind text;
CREATE TABLE IF NOT EXISTS public.jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS status text;
CREATE TABLE IF NOT EXISTS public.feature_flags(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flag_name text UNIQUE, enabled boolean);
ALTER TABLE public.feature_flags ADD COLUMN IF NOT EXISTS description text;
CREATE TABLE IF NOT EXISTS public.trade_pay_settings(id integer PRIMARY KEY);
ALTER TABLE public.trade_pay_settings ADD COLUMN IF NOT EXISTS inclusive_super_from date,
 ADD COLUMN IF NOT EXISTS reimbursement_account_code text, ADD COLUMN IF NOT EXISTS not_job_work_account_code text;
CREATE TABLE IF NOT EXISTS public.expense_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.expense_receipts ADD COLUMN IF NOT EXISTS receipt_storage_path text, ADD COLUMN IF NOT EXISTS receipt_photo_url text;
CREATE TABLE IF NOT EXISTS public.job_commissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.job_commissions ADD COLUMN IF NOT EXISTS job_id uuid, ADD COLUMN IF NOT EXISTS state text;
CREATE TABLE IF NOT EXISTS public.trade_recurring_deductions(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.trade_recurring_deductions ADD COLUMN IF NOT EXISTS kind text, ADD COLUMN IF NOT EXISTS xero_account_code text;
CREATE TABLE IF NOT EXISTS public.work_order_customer_variations(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.work_order_customer_variations ADD COLUMN IF NOT EXISTS work_order_id uuid,
 ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS trade_allocation_ex numeric;
CREATE TABLE IF NOT EXISTS public.group_work_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.group_work_orders ADD COLUMN IF NOT EXISTS work_order_id uuid, ADD COLUMN IF NOT EXISTS job_id uuid,
 ADD COLUMN IF NOT EXISTS pay_basis text, ADD COLUMN IF NOT EXISTS created_at timestamptz,
 ADD COLUMN IF NOT EXISTS split_frozen_at timestamptz;
CREATE TABLE IF NOT EXISTS public.group_work_order_shares(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE public.group_work_order_shares ADD COLUMN IF NOT EXISTS group_id uuid, ADD COLUMN IF NOT EXISTS pot_ex numeric;
-- Existing production index shapes, for the narrow plan proof on the copy.
CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON public.trade_invoice_lines(trade_invoice_id);
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_job_work_order ON public.trade_invoice_lines(job_work_order_id) WHERE job_work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_group_share ON public.trade_invoice_lines(group_share_id) WHERE group_share_id IS NOT NULL;
