DO $$
BEGIN
 IF to_regprocedure('public.match_rule_install()') IS NOT NULL
 OR to_regprocedure('public.match_rules_proposed()') IS NOT NULL
 OR to_regprocedure('public.match_rule_confirm(bigint,boolean,uuid)') IS NOT NULL
 OR EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_decisions'::regclass AND tgname='match_rule_on_decision')
 OR to_regclass('public.match_rules') IS NULL OR to_regclass('public.reconcile_decisions') IS NULL THEN
   RAISE EXCEPTION 'match_rule_rollback_failed';
 END IF;
END $$;
SELECT 'PASS P2-02.12 rollback';
