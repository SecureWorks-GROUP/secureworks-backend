DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.match_clue_types WHERE code = 'who_ordered')
     OR NOT has_table_privilege('service_role', 'public.match_clues', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.job_cost_line_parts', 'TRUNCATE')
     OR NOT has_table_privilege('service_role', 'public.xero_draft_register', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.bookkeeping_checks', 'TRUNCATE') THEN
    RAISE EXCEPTION 'followups: rollback did not restore prior grants and seed set';
  END IF;
END $$;
