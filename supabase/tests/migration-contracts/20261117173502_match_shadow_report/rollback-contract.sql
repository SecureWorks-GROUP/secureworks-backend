DO $$ BEGIN IF to_regprocedure('public.match_shadow_report(integer)') IS NOT NULL THEN RAISE EXCEPTION 'shadow report: rollback'; END IF; END $$;
