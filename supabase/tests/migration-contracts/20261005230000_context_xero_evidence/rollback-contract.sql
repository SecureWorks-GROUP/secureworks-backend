-- After the down migration: the seven functions are gone, and the surfaces
-- they read are untouched.
DO $$
DECLARE left_over text;
BEGIN
 SELECT string_agg(p.proname,', ') INTO left_over FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname LIKE 'context_xero_%';
 IF left_over IS NOT NULL THEN RAISE EXCEPTION 'xero_evidence_rollback: still present: %',left_over; END IF;
 IF to_regprocedure('public.capture_business_event(jsonb)') IS NULL
  OR to_regprocedure('public.context_catchup_eligible_rows(uuid[])') IS NULL
  OR to_regclass('public.xero_invoices') IS NULL THEN
  RAISE EXCEPTION 'xero_evidence_rollback: a surface the migration only read is gone';
 END IF;
END $$;
