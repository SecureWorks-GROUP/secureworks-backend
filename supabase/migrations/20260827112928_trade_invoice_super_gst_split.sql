-- Trade invoice super/GST money truth.
--
-- New invoices must persist the contractor's gross earned amount, the
-- statutory SG rate and worked-out super amount, net pay after super, and the
-- per-invoice GST choice. Existing invoices stay NULL: backfilling them would
-- falsely claim a historical super withholding that may not have happened.
--
-- Statutory source checked 2026-08-27: ATO "Super guarantee percentage" table,
-- general rate 12.00% from 1 July 2025 (including 2026-27 and 2027 onwards):
-- https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/super-guarantee

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS gst_on boolean,
  ADD COLUMN IF NOT EXISTS super_rate numeric(7,6),
  ADD COLUMN IF NOT EXISTS super_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS gross_earned numeric(12,2),
  ADD COLUMN IF NOT EXISTS net_pay numeric(12,2);

COMMENT ON COLUMN public.trade_invoices.gst_on IS
  'Per-invoice GST choice. true = 10% GST on gross_earned; false = no GST. NULL only on legacy pre-split rows.';
COMMENT ON COLUMN public.trade_invoices.super_rate IS
  'Statutory Superannuation Guarantee rate snapshot used for this invoice (for example 0.120000). NULL only on legacy pre-split rows.';
COMMENT ON COLUMN public.trade_invoices.super_amount IS
  'Worked-out super allocation: round(gross_earned * super_rate, 2). This is part of gross earned, not an added cost.';
COMMENT ON COLUMN public.trade_invoices.gross_earned IS
  'Contractor earnings before super is split out and before optional GST. Equals subtotal_ex for split-aware invoices.';
COMMENT ON COLUMN public.trade_invoices.net_pay IS
  'Contractor earnings after super: gross_earned - super_amount, before GST.';

ALTER TABLE public.trade_invoices
  DROP CONSTRAINT IF EXISTS trade_invoices_super_gst_split_check;

ALTER TABLE public.trade_invoices
  ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
    (
      gst_on IS NULL
      AND super_rate IS NULL
      AND super_amount IS NULL
      AND gross_earned IS NULL
      AND net_pay IS NULL
    )
    OR
    (
      gst_on IS NOT NULL
      AND super_rate = 0.12
      AND super_amount >= 0
      AND gross_earned >= 0
      AND net_pay >= 0
      AND gross_earned = round(subtotal_ex, 2)
      AND super_amount = round(gross_earned * super_rate, 2)
      AND net_pay = round(gross_earned - super_amount, 2)
      AND gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END
      AND total_inc = round(gross_earned + gst, 2)
    )
  );

CREATE OR REPLACE FUNCTION public.enforce_trade_invoice_money_split_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.gst_on IS NULL
     OR NEW.super_rate IS NULL
     OR NEW.super_amount IS NULL
     OR NEW.gross_earned IS NULL
     OR NEW.net_pay IS NULL THEN
    RAISE EXCEPTION 'new trade invoices require gst_on, super_rate, super_amount, gross_earned and net_pay'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoices_require_money_split
  ON public.trade_invoices;
CREATE TRIGGER trg_trade_invoices_require_money_split
  BEFORE INSERT ON public.trade_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trade_invoice_money_split_v1();

-- Replacing a retryable draft must not delete the header while assignments
-- still point at it. This RPC owns the transfer + guarded delete in one
-- database transaction, so any failed guard or FK write rolls the whole
-- replacement boundary back and leaves the prior draft recoverable.
CREATE OR REPLACE FUNCTION public.replace_trade_invoice_draft_v1(
  p_prior_draft_id uuid,
  p_replacement_id uuid,
  p_user_id uuid,
  p_assignment_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prior_user_id uuid;
  v_prior_status text;
  v_prior_xero_bill_id text;
  v_prior_xero_pushed_at timestamptz;
  v_replacement_user_id uuid;
  v_replacement_xero_bill_id text;
  v_replacement_xero_pushed_at timestamptz;
  v_deleted_count integer;
BEGIN
  IF p_prior_draft_id IS NULL
     OR p_replacement_id IS NULL
     OR p_user_id IS NULL
     OR p_prior_draft_id = p_replacement_id THEN
    RAISE EXCEPTION 'invalid trade invoice draft replacement identity'
      USING ERRCODE = '22023';
  END IF;

  SELECT user_id, status, xero_bill_id, xero_pushed_at
    INTO v_prior_user_id, v_prior_status, v_prior_xero_bill_id,
      v_prior_xero_pushed_at
  FROM public.trade_invoices
  WHERE id = p_prior_draft_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_prior_user_id <> p_user_id
     OR v_prior_status <> 'draft'
     OR v_prior_xero_bill_id IS NOT NULL
     OR v_prior_xero_pushed_at IS NOT NULL THEN
    RAISE EXCEPTION 'prior trade invoice is not a replaceable draft'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT user_id, xero_bill_id, xero_pushed_at
    INTO v_replacement_user_id, v_replacement_xero_bill_id,
      v_replacement_xero_pushed_at
  FROM public.trade_invoices
  WHERE id = p_replacement_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_replacement_user_id <> p_user_id
     OR v_replacement_xero_bill_id IS NOT NULL
     OR v_replacement_xero_pushed_at IS NOT NULL THEN
    RAISE EXCEPTION 'replacement trade invoice is not locally owned'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.job_assignments
  SET invoiced_in = CASE
    WHEN id = ANY(COALESCE(p_assignment_ids, ARRAY[]::uuid[]))
      THEN p_replacement_id
    ELSE NULL
  END
  WHERE invoiced_in = p_prior_draft_id;

  DELETE FROM public.trade_invoices
  WHERE id = p_prior_draft_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  IF v_deleted_count <> 1 THEN
    RAISE EXCEPTION 'prior trade invoice changed before replacement'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN p_replacement_id;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_trade_invoice_draft_v1(uuid, uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_trade_invoice_draft_v1(uuid, uuid, uuid, uuid[])
  TO service_role;

COMMENT ON FUNCTION public.replace_trade_invoice_draft_v1(uuid, uuid, uuid, uuid[]) IS
  'Atomically transfers assignment locks present on a complete replacement, releases other stale prior-draft locks, and deletes only a same-user draft with no Xero identity.';
