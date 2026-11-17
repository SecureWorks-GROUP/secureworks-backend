\set ON_ERROR_STOP on
DO $$
BEGIN
  IF to_regclass('public.agent_action_proposals') IS NOT NULL
     OR to_regprocedure('public.agent_action_proposal_claim(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.agent_action_proposals_expire()') IS NOT NULL THEN
    RAISE EXCEPTION 'proposal rollback contract: proposal surface remains';
  END IF;
  PERFORM 1 FROM public.users LIMIT 1;
END $$;
