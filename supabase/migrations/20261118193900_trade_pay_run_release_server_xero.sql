-- cl-payrun-xero-lookup: the lapsed-claim Xero check is the server's own search.
--
-- Follow-up (a) to cl-payrun-escape (20261118170500, PR 1646), director
-- 18 Nov. That migration released a run row with a lapsed push claim on a
-- Xero check that came from the request body; the database could check only
-- its form. Now ops-api searches Xero itself at the press (the same live-bill
-- search the office's stuck-invoice release uses: the bill number, and the
-- number inside bill references) and passes what it found. This body accepts
-- only that: source ops_api_xero_lookup, the searched number, bills_found 0,
-- checked_by the pressing approver, checked_at within the last five minutes
-- and after the claim lapsed. A bill found is refused
-- (pay_run_xero_check_found_in_xero); any other check is refused
-- (pay_run_xero_check_not_server). The stored check keeps what was searched
-- and found. The database still trusts ops-api: it cannot read Xero itself.
--
-- Follow-up (b): the released row's words say the invoice went back to the
-- office for review and that a queried invoice stays queried, and the stop
-- keeps the status it had at the release. Wording only: what the release
-- writes to the invoice is unchanged.
--
-- Replaces one function body (signature, grants and comment unchanged). No
-- table, column, index, trigger, schedule or row. trade_pay_run_v1 stays off.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Rule 15: built on 20261118170500's body; re-applying this file is a no-op.
DO $guard$
/* block */ BEGIN
  IF to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice: apply 20261118170500 first';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'))
     NOT IN ('152edcbbc1ddff5f29d91e8f8af71860', '62293ef4dd638c21ab9a25c86669d9f4') THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice: Rule 15, another body is installed; refusing to replace it';
  END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.release_trade_pay_run_invoice(
  p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_reason text, p_xero_check jsonb DEFAULT NULL
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
  v_lapsed_at timestamptz;
  v_checked_by uuid;
  v_checked_at timestamptz;
  v_check jsonb;
  v_number text;
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
  -- (a refusal before Xero gives its claim back). Director ruling 18 Nov: it
  -- is released only with a recorded Xero check that says the invoice is not
  -- in Xero, names the approver who checked, and is dated after the lapse.
  -- Since cl-payrun-xero-lookup the check is ops-api's own Xero search at the
  -- press (source ops_api_xero_lookup), never words from the request: it is
  -- the pressing approver's, made in the last five minutes, and found no bill.
  IF v_row.push_claimed_at IS NOT NULL THEN
    IF p_xero_check IS NULL OR jsonb_typeof(p_xero_check) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'pay_run_push_claim_lapsed';
    END IF;
    -- (1) Not in Xero: only an explicit false releases.
    IF p_xero_check->'in_xero' = 'true'::jsonb THEN
      RAISE EXCEPTION 'pay_run_xero_check_found_in_xero';
    END IF;
    IF p_xero_check->'in_xero' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'pay_run_xero_check_invalid';
    END IF;
    -- (2) A named pay run approver checked.
    IF jsonb_typeof(p_xero_check->'checked_by') IS DISTINCT FROM 'string'
       OR btrim(p_xero_check->>'checked_by') = '' THEN
      RAISE EXCEPTION 'pay_run_xero_check_unnamed';
    END IF;
    IF btrim(p_xero_check->>'checked_by') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'pay_run_xero_check_unnamed';
    END IF;
    v_checked_by := btrim(p_xero_check->>'checked_by')::uuid;
    IF NOT (v_checked_by = ANY(v_approvers)) THEN
      RAISE EXCEPTION 'pay_run_xero_check_not_approver';
    END IF;
    -- (3) Dated after the claim lapsed, and not in the future (five minutes
    -- of clock difference between the page and the database is allowed).
    IF jsonb_typeof(p_xero_check->'checked_at') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'pay_run_xero_check_invalid';
    END IF;
    BEGIN
      v_checked_at := (p_xero_check->>'checked_at')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'pay_run_xero_check_invalid';
    END;
    IF v_checked_at IS NULL OR v_checked_at > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'pay_run_xero_check_invalid';
    END IF;
    v_lapsed_at := v_row.push_claimed_at + interval '10 minutes';
    IF v_checked_at <= v_lapsed_at THEN
      RAISE EXCEPTION 'pay_run_xero_check_stale';
    END IF;
    -- What the server's own search found: none, by the invoice's bill number
    -- and in bill references. A bill found is never released.
    IF p_xero_check->'bills_found' IS NOT NULL
       AND p_xero_check->'bills_found' IS DISTINCT FROM '0'::jsonb THEN
      RAISE EXCEPTION 'pay_run_xero_check_found_in_xero';
    END IF;
    v_number := CASE WHEN jsonb_typeof(p_xero_check->'searched_number') = 'string'
                     THEN btrim(p_xero_check->>'searched_number') END;
    IF p_xero_check->>'source' IS DISTINCT FROM 'ops_api_xero_lookup'
       OR p_xero_check->'bills_found' IS DISTINCT FROM '0'::jsonb
       OR coalesce(v_number, '') = ''
       OR v_checked_by IS DISTINCT FROM p_actor
       OR v_checked_at < clock_timestamp() - interval '5 minutes' THEN
      RAISE EXCEPTION 'pay_run_xero_check_not_server';
    END IF;
    v_check := jsonb_build_object('in_xero', false, 'checked_by', v_checked_by,
      'checked_at', v_checked_at, 'claim_lapsed_at', v_lapsed_at,
      'source', 'ops_api_xero_lookup', 'searched_number', v_number, 'bills_found', 0);
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
           'words', 'An approver took this invoice back out of the run. It went back to the office for review (a queried invoice stays queried) and waits for a later run.',
           'status_at_release', v_status,
           'xero_check', v_check)),
         released_at = v_at, released_by = p_actor, release_reason = v_reason,
         release_xero_check = v_check,
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
    'status', v_status, 'run_status', v_run_status, 'xero_check', v_check);
END;
$fn$;
REVOKE ALL ON FUNCTION public.release_trade_pay_run_invoice(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_trade_pay_run_invoice(uuid, uuid, uuid, text, jsonb) TO service_role;
COMMENT ON FUNCTION public.release_trade_pay_run_invoice(uuid, uuid, uuid, text, jsonb) IS
  'cl-payrun-escape: a pay run approver takes one unpushed invoice back out of its run, to review, with a reason. Service role only.';

-- The guard's md5 is this file's own body.
DO $own$
/* block */ BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)'))
     IS DISTINCT FROM '62293ef4dd638c21ab9a25c86669d9f4' THEN
    RAISE EXCEPTION 'release_trade_pay_run_invoice: Rule 15 guard md5 is not this migration''s body';
  END IF;
END;
$own$;
