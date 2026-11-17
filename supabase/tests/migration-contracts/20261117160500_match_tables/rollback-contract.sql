DO $$
DECLARE
  object_name text;
BEGIN
  FOREACH object_name IN ARRAY ARRAY['match_clue_types', 'match_clues', 'match_queue', 'match_shadow_runs', 'match_rules',
    'match_clues_id_seq', 'match_shadow_runs_id_seq', 'match_rules_id_seq'] LOOP
    IF to_regclass('public.' || object_name) IS NOT NULL THEN
      RAISE EXCEPTION 'match tables rollback contract: % still exists', object_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'reconcile_matcher_v1') THEN
    RAISE EXCEPTION 'match tables rollback contract: switch still exists';
  END IF;
END $$;
