SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5s';

-- Stamp the same guarded update as the receipt release.
DO $guard$ DECLARE fn regprocedure := 'public.reject_trade_invoice_v1(uuid,text,text)'::regprocedure;
  body_hash text; definition text; BEGIN
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO body_hash, definition FROM pg_proc WHERE oid = fn;
  IF body_hash = '73c277c035c43cea9156f46bce919813' THEN RETURN; END IF;
  IF body_hash IS DISTINCT FROM 'd689b65f2fa743a8af8e5e795f2cc39e' THEN
    RAISE EXCEPTION 'effort_reject_preimage_mismatch';
  END IF;
  EXECUTE replace(definition, $old$SET status = 'ops-reject', query_note = p_note, office_sent_back_at = clock_timestamp()$old$, $new$SET status = 'ops-reject', query_note = p_note$new$);
END $guard$;
DROP FUNCTION IF EXISTS public.pay_effort_stats(uuid,integer);
DROP INDEX IF EXISTS public.trade_invoice_lines_effort_held_idx;
DROP INDEX IF EXISTS public.trade_invoices_effort_week_idx;
