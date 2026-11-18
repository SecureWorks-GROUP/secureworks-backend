-- cl-payrun-xero-found: a Xero bill found at a release press is kept on the
-- run row, not only logged.
--
-- Before-switch item for trade_pay_run_v1, director ruling 18 Nov (1658, (b)).
-- Since 20261118193900 a run row whose push claim lapsed is released only on
-- ops-api's own Xero search. When that search finds a live bill the release
-- is refused; until now the bill was only written to the function log. Now
-- ops-api records it first, through record_trade_pay_run_xero_found, in a
-- new column release_xero_found on the run row: who searched, when, the
-- number searched, the bills found (Xero id, number and status only) and the
-- result. The newest search replaces an earlier one. The release itself is
-- unchanged and still refuses.
--
-- Adds one nullable column (no default, no rewrite) and one function,
-- service role only. No index (the write is by the run row's primary key),
-- no trigger, schedule or row. trade_pay_run_v1 stays off; the only caller
-- is the release door, which refuses while it is off.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Rule 15: the release and its run row must be there; a column or function
-- of this name that is not this file's is never replaced.
DO $guard$
/* block */ BEGIN
  IF to_regprocedure('public.release_trade_pay_run_invoice(uuid,uuid,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'record_trade_pay_run_xero_found: apply 20261118193900 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                 WHERE a.attrelid = to_regclass('public.trade_pay_run_invoices')
                   AND a.attname = 'push_claimed_at' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'record_trade_pay_run_xero_found: trade_pay_run_invoices.push_claimed_at is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = to_regclass('public.trade_pay_run_invoices')
               AND a.attname = 'release_xero_found' AND NOT a.attisdropped
               AND a.atttypid IS DISTINCT FROM 'jsonb'::regtype) THEN
    RAISE EXCEPTION 'record_trade_pay_run_xero_found: Rule 15, another release_xero_found column is installed';
  END IF;
  IF to_regprocedure('public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)') IS NOT NULL
     AND (SELECT md5(p.prosrc) FROM pg_proc p
          WHERE p.oid = to_regprocedure('public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)'))
         IS DISTINCT FROM '2c21adbf78f1aeeb2dd329e5c1beea71' THEN
    RAISE EXCEPTION 'record_trade_pay_run_xero_found: Rule 15, another body is installed; refusing to replace it';
  END IF;
END;
$guard$;

ALTER TABLE public.trade_pay_run_invoices
  ADD COLUMN IF NOT EXISTS release_xero_found jsonb;

COMMENT ON COLUMN public.trade_pay_run_invoices.release_xero_found IS
  'cl-payrun-xero-found: the newest Xero search at a release press that found a live bill for this run row (the release was refused). result found_in_xero, checked_by, checked_at, source ops_api_xero_lookup, searched_number, bills_found and bills (xero_bill_id, number, status). Written only by record_trade_pay_run_xero_found.';

CREATE OR REPLACE FUNCTION public.record_trade_pay_run_xero_found(
  p_run_id uuid, p_invoice_id uuid, p_actor uuid, p_found jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_approvers uuid[];
  v_run record;
  v_row record;
  v_checked_at timestamptz;
  v_number text;
  v_bill jsonb;
  v_bills jsonb := '[]'::jsonb;
  v_record jsonb;
BEGIN
  IF p_run_id IS NULL OR p_invoice_id IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'pay_run_release_invalid';
  END IF;
  -- trade_pay_settings_pkey. The approver list, before anything else is read.
  SELECT s.pay_run_approver_user_ids INTO v_approvers
  FROM public.trade_pay_settings s WHERE s.id = 1;
  IF NOT (p_actor = ANY(coalesce(v_approvers, ARRAY[]::uuid[]))) THEN
    RAISE EXCEPTION 'pay_run_not_approver';
  END IF;
  -- trade_pay_runs_pkey, then trade_pay_run_invoices_pkey: the release's
  -- lock order, so the two never wait on each other the wrong way round.
  SELECT r.id INTO v_run FROM public.trade_pay_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pay_run_not_found';
  END IF;
  SELECT ri.pushed_at, ri.push_claimed_at, ri.released_at INTO v_row
  FROM public.trade_pay_run_invoices ri
  WHERE ri.run_id = p_run_id AND ri.invoice_id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_in_run';
  END IF;
  -- Only a row the release would have searched for: a lapsed claim, not
  -- pushed, not released.
  IF v_row.released_at IS NOT NULL OR v_row.pushed_at IS NOT NULL
     OR v_row.push_claimed_at IS NULL
     OR v_row.push_claimed_at >= clock_timestamp() - interval '10 minutes' THEN
    RAISE EXCEPTION 'pay_run_xero_found_not_lapsed';
  END IF;
  -- ops-api's own search, by the pressing approver, made at this press.
  IF p_found IS NULL OR jsonb_typeof(p_found) IS DISTINCT FROM 'object'
     OR p_found->>'source' IS DISTINCT FROM 'ops_api_xero_lookup'
     OR jsonb_typeof(p_found->'checked_by') IS DISTINCT FROM 'string'
     OR btrim(p_found->>'checked_by') IS DISTINCT FROM p_actor::text
     OR jsonb_typeof(p_found->'checked_at') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_found->'searched_number') IS DISTINCT FROM 'string'
     OR btrim(p_found->>'searched_number') = ''
     OR jsonb_typeof(p_found->'bills') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_found->'bills') NOT BETWEEN 1 AND 50
     OR p_found->'bills_found' IS DISTINCT FROM to_jsonb(jsonb_array_length(p_found->'bills')) THEN
    RAISE EXCEPTION 'pay_run_xero_found_invalid';
  END IF;
  BEGIN
    v_checked_at := (p_found->>'checked_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'pay_run_xero_found_invalid';
  END;
  IF v_checked_at < clock_timestamp() - interval '5 minutes'
     OR v_checked_at > clock_timestamp() + interval '5 minutes'
     OR v_checked_at <= v_row.push_claimed_at + interval '10 minutes' THEN
    RAISE EXCEPTION 'pay_run_xero_found_invalid';
  END IF;
  v_number := left(btrim(p_found->>'searched_number'), 100);
  -- Each bill: its Xero id (required), number and status. Nothing else is
  -- kept (no reference, contact or amount).
  FOR v_bill IN SELECT b FROM jsonb_array_elements(p_found->'bills') b LOOP
    IF jsonb_typeof(v_bill) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_bill->'xero_bill_id') IS DISTINCT FROM 'string'
       OR btrim(v_bill->>'xero_bill_id') = '' THEN
      RAISE EXCEPTION 'pay_run_xero_found_invalid';
    END IF;
    v_bills := v_bills || jsonb_build_array(jsonb_build_object(
      'xero_bill_id', left(btrim(v_bill->>'xero_bill_id'), 100),
      'number', CASE WHEN jsonb_typeof(v_bill->'number') = 'string'
                     THEN left(btrim(v_bill->>'number'), 100) END,
      'status', CASE WHEN jsonb_typeof(v_bill->'status') = 'string'
                     THEN left(upper(btrim(v_bill->>'status')), 20) END));
  END LOOP;
  v_record := jsonb_build_object(
    'result', 'found_in_xero',
    'checked_by', p_actor,
    'checked_at', v_checked_at,
    'source', 'ops_api_xero_lookup',
    'searched_number', v_number,
    'bills_found', jsonb_array_length(v_bills),
    'bills', v_bills);
  UPDATE public.trade_pay_run_invoices ri
     SET release_xero_found = v_record
   WHERE ri.run_id = p_run_id AND ri.invoice_id = p_invoice_id;
  RETURN jsonb_build_object('run_id', p_run_id, 'invoice_id', p_invoice_id,
    'recorded', true, 'found', v_record);
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb) TO service_role;

COMMENT ON FUNCTION public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb) IS
  'cl-payrun-xero-found: keeps on the run row the Xero bill ops-api found at a release press (lapsed push claim, not pushed, not released), with who searched and when. Records only; releases nothing and calls no Xero. Service role only.';

DO $own$
/* block */ BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.record_trade_pay_run_xero_found(uuid,uuid,uuid,jsonb)'))
     IS DISTINCT FROM '2c21adbf78f1aeeb2dd329e5c1beea71' THEN
    RAISE EXCEPTION 'record_trade_pay_run_xero_found: body is not this file''s';
  END IF;
END;
$own$;
