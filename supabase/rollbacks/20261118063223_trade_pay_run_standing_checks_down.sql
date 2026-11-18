-- Rollback of 20261118063223_trade_pay_run_standing_checks. Drops the function
-- only when it is this migration's own body (Rule 15); any other body at this
-- signature belongs to someone else and is refused, never dropped.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $down$
DECLARE
  v_md5 text := (SELECT md5(p.prosrc) FROM pg_proc p
                 WHERE p.oid = to_regprocedure('public.trade_pay_run_standing_checks(uuid,uuid[],text)'));
/* block */ BEGIN
  IF v_md5 IS NOT NULL AND v_md5 <> 'b734f7d74eecc7dfee162613f38935a4' THEN
    RAISE EXCEPTION 'trade_pay_run_standing_checks rollback: another body is installed (md5 %); refusing to drop it', v_md5;
  END IF;
  DROP FUNCTION IF EXISTS public.trade_pay_run_standing_checks(uuid,uuid[],text);
END;
$down$;
