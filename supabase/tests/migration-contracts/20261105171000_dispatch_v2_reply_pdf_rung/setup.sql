-- Prerequisites for 20261105171000_dispatch_v2_reply_pdf_rung: a narrow stand-in for
-- dispatch_v2_supplier_emails (production: 20261023230000_dispatch_v2_replies_tables.sql), with the rung check as
-- it stands before this migration. No earlier registered case creates this table.
CREATE TABLE IF NOT EXISTS public.dispatch_v2_supplier_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  state text NOT NULL,
  rung text NULL,
  job_id uuid NULL,
  order_id uuid NULL,
  CONSTRAINT dispatch_v2_supplier_emails_rung_valid CHECK (
    rung IS NULL OR rung IN ('thread', 'job_number', 'supplier_ref', 'best_guess', 'manual')
  )
);
DO $$
BEGIN
  IF to_regclass('public.dispatch_v2_supplier_emails') IS NULL THEN
    RAISE EXCEPTION 'Tweak 2 PDF rung prerequisites missing: public.dispatch_v2_supplier_emails';
  END IF;
END $$;
