DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name IN (
  'context_fact_read_v1',
  'context_record_close_v1',
  'context_story_code_parts_v1',
  'context_checker_must_differ_v1',
  'job_page_stored_read_v1',
  'agent_money_press_v1',
  'agent_money_press_observe_v1',
  'ops_chat_engine_agent_v1'
  )) THEN
    RAISE EXCEPTION 'phase4 switches rollback: a phase4 flag remains';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'phase4 switches rollback: feature_flags removed';
  END IF;
END $$;
