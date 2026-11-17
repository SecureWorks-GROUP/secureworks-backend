-- In a single-case disposable database only, create the wrapper's table surface.
-- The delegation stand-in below replaces main's v3 ONLY in the rolled-back contract.
CREATE TABLE IF NOT EXISTS public.trade_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), accepted_untouched boolean, confirm_seconds integer
);
CREATE TABLE IF NOT EXISTS public.trade_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trade_invoice_id uuid,
  line_position integer, line_total_ex numeric, suggested jsonb,
  changed_from_suggestion boolean, sent_values jsonb, office_review_note text
);
CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON public.trade_invoice_lines(trade_invoice_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;
