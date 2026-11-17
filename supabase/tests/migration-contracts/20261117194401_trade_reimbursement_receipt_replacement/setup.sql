-- In the registered stack use its real functions; in the approved single-case
-- mirror bootstrap the exact source bodies retained in baseline_functions.sql.
SELECT to_regprocedure('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)') IS NULL AS bootstrap \gset
\if :bootstrap
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE TABLE public.jobs(id uuid PRIMARY KEY, org_id uuid, job_number text, type text);
CREATE TABLE public.trade_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now(),
 status text, subtotal_ex numeric, gross_earned numeric, gst_on boolean, gst numeric,
 total_inc numeric, super_rate numeric, super_amount numeric, net_pay numeric,
 job_grand_total_ex numeric, final_deductions_total_ex numeric, to_be_paid_ex numeric
);
\ir baseline_schema.sql
ALTER TABLE public.trade_invoice_lines
 ADD COLUMN source_work_order_id uuid, ADD COLUMN source_trade_invoice_line_id uuid,
 ADD COLUMN deduction_user_id uuid, ADD COLUMN deduction_assignment_id uuid,
 ADD COLUMN deduction_trade_rate_id uuid, ADD COLUMN site_address text,
 ADD COLUMN line_position integer, ADD COLUMN expense_receipt_id uuid,
 ADD COLUMN office_review_status text, ADD COLUMN office_review_note text;
CREATE TABLE public.expense_receipts(id uuid PRIMARY KEY);
CREATE TABLE public.feature_flags(flag_name text PRIMARY KEY, enabled boolean);
INSERT INTO public.feature_flags VALUES ('trade_reimbursement_line_v1', false);
CREATE INDEX idx_inv_lines_invoice ON public.trade_invoice_lines(trade_invoice_id);
CREATE UNIQUE INDEX trade_invoice_lines_one_receipt ON public.trade_invoice_lines(expense_receipt_id) WHERE expense_receipt_id IS NOT NULL;
\ir baseline_functions.sql
\ir ../../../migrations/20261117171202_trade_reimbursement_persist.sql
-- Install/remove functions are fixture setup only, never the new migration.
CREATE FUNCTION public.install_trade_invoice_reimbursement_guard() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 CREATE TRIGGER trade_invoice_lines_reimbursement_once BEFORE INSERT OR UPDATE OF expense_receipt_id
 ON public.trade_invoice_lines FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_reimbursement_once();
END $$;
\endif
