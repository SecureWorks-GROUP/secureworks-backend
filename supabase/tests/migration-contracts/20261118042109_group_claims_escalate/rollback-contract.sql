DO $$ BEGIN
 IF to_regprocedure('public.group_claims_escalate_due()') IS NOT NULL
  OR to_regprocedure('public.install_group_claims_escalate()') IS NOT NULL
  OR to_regprocedure('public.remove_group_claims_escalate()') IS NOT NULL THEN
  RAISE EXCEPTION 'ZZTEST escalation functions survived rollback'; END IF;
END $$;
SELECT 'PASS: P1-13.9 rollback removed escalation only' AS result;
