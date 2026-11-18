-- Rollback of P2-02.8: match_apply back to main's (20261118195300's) body; the helper, the read
-- function and the slow-bills table dropped (its rows are runner bookkeeping only).
-- Guarded on the live bodies: this migration's, or main's when it never applied.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE sig regprocedure := 'public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure;
  h text; def text; helper text;
/* reverse only the checked edit */ BEGIN
  SELECT md5(prosrc) INTO helper FROM pg_proc WHERE oid = to_regprocedure('public.match_clues_unchanged(text,text,jsonb,text)');
  IF helper IS NOT NULL AND helper <> 'f228062ecc1a3a69e266533282028e5e' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged down: match_clues_unchanged body changed';
  END IF;
  SELECT md5(prosrc) INTO helper FROM pg_proc WHERE oid = to_regprocedure('public.match_bill_read(text,jsonb)');
  IF helper IS NOT NULL AND helper <> '5107006995e323d24746b965cf6614c0' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged down: match_bill_read body changed';
  END IF;
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO STRICT h, def FROM pg_proc WHERE oid = sig;
  IF h = 'a63d82c7f7a24ea5a99c0933bec7352a' THEN
    def := replace(def,
$new$  -- A held bill whose clues are the ones already current writes nothing (P2-02.8).
  IF enabled_now THEN
    stop_reason := public.match_apply_stop(p_subject_id);
    IF stop_reason IS NOT NULL AND public.match_clues_unchanged(p_subject_kind,p_subject_id,p_clues,p_rule_version) THEN
      RETURN jsonb_build_object('applied',stop_reason);
    END IF;
  END IF;
  UPDATE public.match_clues k SET current = false WHERE k.current AND k.kept_from IS NULL
$new$,
$old$  UPDATE public.match_clues k SET current = false WHERE k.current AND k.kept_from IS NULL
$old$);
    EXECUTE def;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = sig) <> 'b011ec334de5208fffc613e5f6fe7fc9' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged down: match_apply body changed';
  END IF;
END $guard$;

DROP FUNCTION IF EXISTS public.match_clues_unchanged(text,text,jsonb,text);
DROP FUNCTION IF EXISTS public.match_bill_read(text,jsonb);
DROP TABLE IF EXISTS public.match_slow_bills;
