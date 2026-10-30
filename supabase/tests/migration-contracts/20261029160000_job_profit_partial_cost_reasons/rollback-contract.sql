-- After the down migration: v_job_profit is 20261020181800's body again (same
-- columns, no TP-13 reason), the story book's money signature and book are
-- 20261028190000's bodies again, the policy function is gone, job_profit(uuid)
-- still answers and the grants are unchanged.
\set ON_ERROR_STOP on
DO $$
DECLARE v_def text := pg_get_viewdef('public.v_job_profit'::regclass);
BEGIN
  IF v_def LIKE '%materials_below_quote%' OR v_def LIKE '%po_no_bill_overdue%' OR v_def LIKE '%variation_not_invoiced%'
     OR v_def LIKE '%expected_cost_lane_missing%' THEN
    RAISE EXCEPTION 'tp13 rollback: TP-13 reasons survived';
  END IF;
  IF v_def NOT LIKE '%installer_bill_unconfirmed%' THEN
    RAISE EXCEPTION 'tp13 rollback: the JP-12 body was not restored';
  END IF;
  IF to_regprocedure('public.job_profit_partial_cost_policy()') IS NOT NULL THEN
    RAISE EXCEPTION 'tp13 rollback: policy function survived';
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND attnum > 0 AND NOT attisdropped) <> 51 THEN
    RAISE EXCEPTION 'tp13 rollback: v_job_profit columns changed';
  END IF;
  PERFORM 1 FROM public.job_profit('00000000-0000-0000-0000-000000000000'::uuid);
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_money_sig(uuid)'::regprocedure) <> 'dea95169f891563e26f40b1c340897b9'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_job_story_book(uuid,timestamptz)'::regprocedure) <> 'bd9484273117b728d1d7c021ea6ca4c1' THEN
    RAISE EXCEPTION 'tp13 rollback: the story book functions are not 20261028190000''s bodies';
  END IF;
  IF obj_description('public.context_job_story_book(uuid,timestamptz)'::regprocedure, 'pg_proc') NOT LIKE 'Story money book (20261028190000): %'
     OR obj_description('public.context_job_story_money_sig(uuid)'::regprocedure, 'pg_proc') NOT LIKE 'Story money book (20261028190000): %' THEN
    RAISE EXCEPTION 'tp13 rollback: the story book comments are not 20261028190000''s';
  END IF;
  IF has_function_privilege('anon', 'public.context_job_story_book(uuid,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_job_story_money_sig(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'tp13 rollback: story book grants not restored';
  END IF;
  IF public.context_job_story_book('00000000-0000-0000-0000-000000000000'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'tp13 rollback: the restored book answers for an unknown job';
  END IF;
  IF has_table_privilege('anon', 'public.v_job_profit', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'tp13 rollback: grants not restored';
  END IF;
END $$;
