-- After the down: the reader's tables and functions are gone, the views read
-- as 20261020181800 left them, and agent_ai is no longer a source.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.materials_ai_placements') IS NOT NULL OR to_regclass('public.materials_ai_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: tables remain';
  END IF;
  IF to_regprocedure('public.materials_ai_apply(uuid, text, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: apply remains';
  END IF;
  IF pg_get_viewdef('public.v_job_cost_events'::regclass) LIKE '%agent_ai%'
     OR pg_get_viewdef('public.v_bill_allocation_balance'::regclass) LIKE '%agent_ai%' THEN
    RAISE EXCEPTION 'rollback: views still name agent_ai';
  END IF;
  PERFORM 1 FROM public.v_job_profit LIMIT 1;
END $$;
