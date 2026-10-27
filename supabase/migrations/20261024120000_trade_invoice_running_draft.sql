-- Running weekly invoice draft (Hugo, 2026-10-24).
--
-- One open hourly draft per person per week can hold the Weekly Invoice
-- screen (job cards, extras, notes) without sending it. Saving does not
-- submit, authorise, pay, or create a Xero bill.
--
-- The header the caller passes must already satisfy
-- trade_invoices_super_gst_split_check and the weekly persist line-sum
-- identity. That is the same GST and super split as every other trade
-- invoice. This function does not invent a second formula and does not
-- change persist_weekly_trade_invoice_v1, v2, or v3. The weekly deduction
-- is still taken only on submit. draft_pay_unconfirmed records that.
--
-- The screen switch is NOT a new column. Set it per person:
--   UPDATE public.users
--   SET trade_details = COALESCE(trade_details, '{}'::jsonb)
--     || '{"runningInvoiceDraft":true}'::jsonb
--   WHERE lower(email) = 'the-person@example.com';
--
-- Safe to apply twice.

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS draft_builder jsonb,
  ADD COLUMN IF NOT EXISTS draft_origin text,
  ADD COLUMN IF NOT EXISTS created_by_agent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_label text,
  ADD COLUMN IF NOT EXISTS dismissed_source_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS draft_pay_unconfirmed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.trade_invoices.draft_builder IS
  'Weekly Invoice screen snapshot while status is draft. Not a Xero bill and not the amount paid.';
COMMENT ON COLUMN public.trade_invoices.draft_origin IS
  'Who started this draft: staff, agent, or auto. Null on invoices from before this column.';
COMMENT ON COLUMN public.trade_invoices.created_by_agent IS
  'True when an agent added lines. The person or an admin still has to submit. An agent cannot.';
COMMENT ON COLUMN public.trade_invoices.agent_label IS
  'Short name of the agent that drafted lines. No secrets.';
COMMENT ON COLUMN public.trade_invoices.dismissed_source_keys IS
  'Work the person removed, so a later build does not put the same line back.';
COMMENT ON COLUMN public.trade_invoices.draft_pay_unconfirmed IS
  'True when the weekly deduction has not been taken. GST and super are the existing split. The amount paid is decided on submit.';

DO $$
BEGIN
  ALTER TABLE public.trade_invoices
    ADD CONSTRAINT trade_invoices_draft_origin_check
    CHECK (draft_origin IS NULL OR draft_origin IN ('staff', 'agent', 'auto'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- v1, v2 and v3 are unchanged. This wraps v3 and stamps the draft columns
-- in the same transaction. A failed stamp saves nothing. Service role only.
CREATE OR REPLACE FUNCTION public.persist_running_trade_invoice_draft_v1(
  p_invoice jsonb,
  p_lines jsonb,
  p_requested_prior_draft_id uuid,
  p_builder jsonb,
  p_origin text,
  p_agent_label text,
  p_dismissed text[],
  p_created_by_agent boolean,
  p_pay_unconfirmed boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invoice_id uuid;
  v_origin text;
BEGIN
  IF p_invoice IS NULL OR (p_invoice->>'status') IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'a running invoice draft must stay a draft'
      USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(p_invoice->>'invoice_source', '') IS DISTINCT FROM 'hourly' THEN
    RAISE EXCEPTION 'a running invoice draft is an hourly draft'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(p_invoice->>'xero_bill_id', '') IS NOT NULL
     OR NULLIF(p_invoice->>'xero_pushed_at', '') IS NOT NULL
     OR NULLIF(p_invoice->>'submitted_at', '') IS NOT NULL THEN
    RAISE EXCEPTION 'a running invoice draft cannot create or submit a Xero bill'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_pay_unconfirmed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'a running invoice draft leaves pay unconfirmed until submit'
      USING ERRCODE = 'P0001';
  END IF;

  v_origin := NULLIF(p_origin, '');
  IF v_origin IS NOT NULL AND v_origin NOT IN ('staff', 'agent', 'auto') THEN
    RAISE EXCEPTION 'draft origin must be staff, agent, or auto'
      USING ERRCODE = '22023';
  END IF;

  v_invoice_id := public.persist_weekly_trade_invoice_v3(
    p_invoice,
    p_lines,
    p_requested_prior_draft_id
  );

  UPDATE public.trade_invoices
  SET draft_builder = p_builder,
      draft_origin = v_origin,
      agent_label = NULLIF(left(COALESCE(p_agent_label, ''), 80), ''),
      dismissed_source_keys = COALESCE(p_dismissed, '{}'::text[]),
      created_by_agent = COALESCE(p_created_by_agent, false),
      draft_pay_unconfirmed = true
  WHERE id = v_invoice_id
    AND status = 'draft'
    AND xero_bill_id IS NULL
    AND xero_pushed_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'running draft stamp missed the draft row'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_running_trade_invoice_draft_v1(
  jsonb, jsonb, uuid, jsonb, text, text, text[], boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_running_trade_invoice_draft_v1(
  jsonb, jsonb, uuid, jsonb, text, text, text[], boolean, boolean
) TO service_role;

COMMENT ON FUNCTION public.persist_running_trade_invoice_draft_v1(
  jsonb, jsonb, uuid, jsonb, text, text, text[], boolean, boolean
) IS
  'Running weekly invoice draft (20261024120000): persist_weekly_trade_invoice_v3 unchanged, then stamps the screen snapshot. Status stays draft. No Xero identity. Header money is the existing GST and super split; the weekly deduction stays on submit.';
