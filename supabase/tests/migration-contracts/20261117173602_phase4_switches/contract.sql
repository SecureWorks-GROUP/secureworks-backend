BEGIN;
CREATE TEMP TABLE phase4_flags_before AS
SELECT flag_name, enabled, description FROM public.feature_flags WHERE flag_name IN (
  'context_fact_read_v1',
  'context_record_close_v1',
  'context_story_code_parts_v1',
  'context_checker_must_differ_v1',
  'job_page_stored_read_v1',
  'agent_money_press_v1',
  'agent_money_press_observe_v1',
  'ops_chat_engine_agent_v1'
);
DO $$ BEGIN
  IF (SELECT count(*) FROM phase4_flags_before) <> 8
     OR EXISTS (SELECT 1 FROM phase4_flags_before WHERE enabled IS DISTINCT FROM false) THEN
    RAISE EXCEPTION 'phase4 switches contract: eight switches must be seeded off';
  END IF;
END $$;
-- Reapply twice and compare every pre-existing flag, including unrelated flags.
UPDATE public.feature_flags SET enabled = true, description = 'ZZTEST existing setting'
WHERE flag_name = 'context_fact_read_v1';
CREATE TEMP TABLE phase4_existing AS SELECT flag_name, enabled, description FROM public.feature_flags;
\ir ../../../migrations/20261117173602_phase4_switches.sql
\ir ../../../migrations/20261117173602_phase4_switches.sql
DO $$ BEGIN
  IF EXISTS (
    (SELECT flag_name, enabled, description FROM public.feature_flags EXCEPT SELECT * FROM phase4_existing)
    UNION ALL
    (SELECT * FROM phase4_existing EXCEPT SELECT flag_name, enabled, description FROM public.feature_flags)
  ) THEN
    RAISE EXCEPTION 'phase4 switches contract: reapply changed an existing flag';
  END IF;
END $$;
SELECT 'PASS: P4-01.5 eight switches off, two reapplies preserve every flag' AS result;
ROLLBACK;
