-- Reapply and read privileges, including grants inherited from table defaults.
\ir ../../../migrations/20261117173301_match_cost_register_followups.sql
DO $$
DECLARE relation text; operation text;
BEGIN
  IF (SELECT count(*) FROM public.match_clue_types WHERE code = 'who_ordered'
      AND class = 'narrower' AND family = 'history' AND mode = 'off') <> 1 THEN
    RAISE EXCEPTION 'followups: who_ordered must exist once and never count';
  END IF;
  FOREACH relation IN ARRAY ARRAY['match_clue_types', 'match_clues', 'match_queue',
    'match_shadow_runs', 'match_rules', 'job_cost_lines', 'job_cost_line_parts',
    'xero_draft_register', 'bookkeeping_checks'] LOOP
    FOREACH operation IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'] LOOP
      IF relation IN ('xero_draft_register', 'bookkeeping_checks') AND operation IN ('TRIGGER', 'REFERENCES') THEN
        CONTINUE;
      END IF;
      IF has_table_privilege('service_role', 'public.' || relation, operation)
         IS DISTINCT FROM (operation IN ('SELECT', 'INSERT', 'UPDATE')
           OR (operation = 'DELETE' AND relation NOT IN ('xero_draft_register', 'bookkeeping_checks'))) THEN
        RAISE EXCEPTION 'followups: unexpected service-role % on %', operation, relation;
      END IF;
    END LOOP;
  END LOOP;
END $$;
