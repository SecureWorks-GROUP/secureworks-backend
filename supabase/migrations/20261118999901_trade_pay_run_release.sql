-- cl-payrun-escape: an office way out of an approved pay run.
--
-- With option A (20261118163000) a run's invoice carries pay_run_id, and every
-- old door refuses it (ops-api trade_pay_run_hold.ts). The run's own push
-- moves it to approved and then checks what it pays against the run, to the
-- cent. When the repayment save lock (BEFORE UPDATE OF ... status) changes
-- the deduction at that move, the push refuses (pay_run_pays_changed) and the
-- invoice stays approved, still stamped, with no bill: no door takes it and
-- the run's push takes only pending_ops_review or queried. It is stuck.
--
-- release_trade_pay_run_invoice lets a pay run approver take one such invoice
-- back out of its run, with a reason, in one transaction:
--   * the invoice loses pay_run_id, reviewed_at and reviewed_by, and an
--     approved invoice goes back to pending_ops_review (a pending_ops_review
--     or queried one keeps its status, and its status is not written);
--   * the run row becomes stopped, records who released it, when and why,
--     and loses any lapsed push claim. That frees the one clean row the
--     invoice may hold (trade_pay_run_invoices_clean_once), so a later run
--     can take it;
--   * when that was the run's last clean unpushed row, the run moves to
--     pushed, as the push does, so super can still be marked paid.
-- It refuses, writing nothing, when the invoice is not the run's, the row is
-- not clean, it was pushed, a push claim is live (a press may be calling
-- Xero), a lapsed claim is set and the approver did not say they checked
-- Xero (that press may have reached it), the invoice has any Xero identity (bill id or pushed stamp), or its
-- status is not approved, pending_ops_review or queried. A second press on a
-- released row answers already_released and writes nothing.
--
-- Creates one function and three nullable columns. Creates no table, index,
-- trigger or schedule and writes no row. Locks one table on apply:
-- trade_pay_run_invoices (ACCESS EXCLUSIVE for the ADD COLUMN; no default, no
-- rewrite; the table holds only runs, none while trade_pay_run_v1 is off).
-- Switch trade_pay_run_v1 is untouched (seeded off).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The push claim this function clears is 20261118163000's.
DO $prereq$
/* block */ BEGIN
  IF to_regprocedure('public.claim_trade_pay_run_push(uuid,uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass
                      AND a.attname = 'push_claimed_at' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice: apply 20261118163000 first';
  END IF;
END;
$prereq$;

-- This migration owns a column only when its comment starts "cl-payrun-escape:";
-- a column of one of these names without it belongs to someone else.
DO $cols$
DECLARE
  v_bad text;
/* block */ BEGIN
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO v_bad
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trade_pay_run_invoices'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname IN ('released_at', 'released_by', 'release_reason')
    AND coalesce(col_description(a.attrelid, a.attnum), '') NOT LIKE 'cl-payrun-escape:%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'trade_pay_run_invoices: columns % exist and are not this migration''s; refusing', v_bad;
  END IF;
END;
$cols$;

ALTER TABLE public.trade_pay_run_invoices
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by uuid,
  ADD COLUMN IF NOT EXISTS release_reason text;
COMMENT ON COLUMN public.trade_pay_run_invoices.released_at IS
  'cl-payrun-escape: when a pay run approver released this invoice from the run (release_trade_pay_run_invoice). Null: never released.';
COMMENT ON COLUMN public.trade_pay_run_invoices.released_by IS
  'cl-payrun-escape: the approver who released this invoice from the run.';
COMMENT ON COLUMN public.trade_pay_run_invoices.release_reason IS
  'cl-payrun-escape: why it was released, as the approver wrote it (5 to 500 characters).';

-- Rule 15: create, or replace only this file's own body.
DO $guard$
/* block */ BEGIN
  IF to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,boolean)') IS NOT NULL
     AND (SELECT md5(p.prosrc) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,boolean)'))
         IS DISTINCT FROM '4fd4374d1e8b365dc16bf206ceec1e78' THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice: Rule 15, another body is installed; refusing to replace it';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.release_trade_pay_run_invoice(
  p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_reason text, p_xero_checked boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
  v_approvers uuid[];
  v_run record;
  v_row record;
  v_inv record;
  v_status text;
  v_run_status text;
  v_at timestamptz;
BEGIN
  IF p_run_id IS NULL OR p_invoice_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'pay_run_release_invalid';
  END IF;
  IF char_length(v_reason) < 5 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'pay_run_release_reason_required';
  END IF;
  -- trade_pay_settings_pkey. The approver list, before anything else is read.
  SELECT s.pay_run_approver_user_ids INTO v_approvers
  FROM public.trade_pay_settings s WHERE s.id = 1;
  IF NOT (p_actor = ANY(coalesce(v_approvers, ARRAY[]::uuid[]))) THEN
    RAISE EXCEPTION 'pay_run_not_approver';
  END IF;
  -- trade_pay_runs_pkey. Locked so the run's status move below cannot race
  -- a push recording the run as pushed.
  SELECT r.id, r.status INTO v_run
  FROM public.trade_pay_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pay_run_not_found';
  END IF;
  -- trade_pay_run_invoices_pkey. The row the push claim stamps.
  SELECT ri.verdict, ri.pushed_at, ri.push_claimed_at, ri.released_at, ri.released_by
    INTO v_row
  FROM public.trade_pay_run_invoices ri
  WHERE ri.run_id = p_run_id AND ri.invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_in_run';
  END IF;
  IF v_row.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('run_id', p_run_id, 'invoice_id', p_invoice_id,
      'already_released', true, 'released_at', v_row.released_at, 'released_by', v_row.released_by,
      'run_status', v_run.status);
  END IF;
  IF v_row.verdict IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION 'invoice_not_clean';
  END IF;
  IF v_row.pushed_at IS NOT NULL THEN
    RAISE EXCEPTION 'pay_run_invoice_pushed';
  END IF;
  -- The same lease claim_trade_pay_run_push uses: a live claim means a press
  -- may be calling Xero right now.
  IF v_row.push_claimed_at IS NOT NULL
     AND v_row.push_claimed_at >= clock_timestamp() - interval '10 minutes' THEN
    RAISE EXCEPTION 'pay_run_push_in_progress';
  END IF;
  -- A lapsed claim was never given back: that press may have reached Xero
  -- (a refusal before Xero gives its claim back). Only an approver who says
  -- they checked Xero for a bill may release it, and that is recorded.
  IF v_row.push_claimed_at IS NOT NULL AND p_xero_checked IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'pay_run_push_claim_lapsed';
  END IF;
  -- trade_invoices_pkey.
  SELECT i.status, i.pay_run_id, i.xero_bill_id, i.xero_pushed_at INTO v_inv
  FROM public.trade_invoices i WHERE i.id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR v_inv.pay_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'invoice_not_in_run';
  END IF;
  IF btrim(coalesce(v_inv.xero_bill_id, '')) <> '' OR v_inv.xero_pushed_at IS NOT NULL THEN
    RAISE EXCEPTION 'pay_run_invoice_billed';
  END IF;
  IF v_inv.status NOT IN ('approved', 'pending_ops_review', 'queried') THEN
    RAISE EXCEPTION 'pay_run_invoice_status';
  END IF;

  -- Back to review. Status is written only when it moves, so a held invoice
  -- that never left pending_ops_review or queried fires no status trigger.
  IF v_inv.status = 'approved' THEN
    UPDATE public.trade_invoices i
       SET status = 'pending_ops_review', pay_run_id = NULL, reviewed_at = NULL, reviewed_by = NULL
     WHERE i.id = p_invoice_id AND i.pay_run_id = p_run_id AND i.xero_bill_id IS NULL;
    v_status := 'pending_ops_review';
  ELSE
    UPDATE public.trade_invoices i
       SET pay_run_id = NULL, reviewed_at = NULL, reviewed_by = NULL
     WHERE i.id = p_invoice_id AND i.pay_run_id = p_run_id AND i.xero_bill_id IS NULL;
    v_status := v_inv.status;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_in_run';
  END IF;

  v_at := clock_timestamp();
  UPDATE public.trade_pay_run_invoices ri
     SET verdict = 'stopped',
         stops = coalesce(ri.stops, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'code', 'released_from_run',
           'words', 'An approver took this invoice back out of the run. It went back to review.',
           'xero_checked_after_lapsed_claim', v_row.push_claimed_at IS NOT NULL)),
         released_at = v_at, released_by = p_actor, release_reason = v_reason,
         push_claimed_at = NULL, push_claimed_by = NULL
   WHERE ri.run_id = p_run_id AND ri.invoice_id = p_invoice_id;

  -- The run's last clean unpushed row is gone: the run is pushed, as the push
  -- records it (recordPushed), so its super can be marked paid.
  v_run_status := v_run.status;
  IF v_run.status = 'approved' AND NOT EXISTS (
    SELECT 1 FROM public.trade_pay_run_invoices ri
    WHERE ri.run_id = p_run_id AND ri.verdict = 'clean' AND ri.pushed_at IS NULL) THEN
    UPDATE public.trade_pay_runs r SET status = 'pushed' WHERE r.id = p_run_id AND r.status = 'approved';
    v_run_status := 'pushed';
  END IF;

  RETURN jsonb_build_object('run_id', p_run_id, 'invoice_id', p_invoice_id,
    'already_released', false, 'released_at', v_at, 'released_by', p_actor,
    'status', v_status, 'run_status', v_run_status,
    'xero_checked_after_lapsed_claim', v_row.push_claimed_at IS NOT NULL);
END;
$fn$;
REVOKE ALL ON FUNCTION public.release_trade_pay_run_invoice(uuid, uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_trade_pay_run_invoice(uuid, uuid, uuid, text, boolean) TO service_role;
COMMENT ON FUNCTION public.release_trade_pay_run_invoice(uuid, uuid, uuid, text, boolean) IS
  'cl-payrun-escape: a pay run approver takes one unpushed invoice back out of its run, to review, with a reason. Service role only.';

-- The guard's md5 is this file's own body.
DO $own$
/* block */ BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,boolean)'))
     IS DISTINCT FROM '4fd4374d1e8b365dc16bf206ceec1e78' THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice: Rule 15 guard md5 is not this migration''s body';
  END IF;
END;
$own$;
