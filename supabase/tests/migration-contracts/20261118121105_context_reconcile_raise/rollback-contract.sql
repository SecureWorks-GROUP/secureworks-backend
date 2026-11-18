BEGIN;
DO $rollback$
/* block */ BEGIN
  IF to_regprocedure('public.context_reconcile_raise(text,uuid,text,text,jsonb,text)') IS NOT NULL
     OR to_regprocedure('public.context_reconcile_withdraw(text,text,text)') IS NOT NULL
     OR to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'P4-01.6 rollback must drop Phase 4 door functions and 8-arg overload';
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)'))
     IS DISTINCT FROM '24c912f38faed264b7bf1f42073778f6' THEN
    RAISE EXCEPTION 'P4-01.6 rollback must restore P2-03.2 seven-argument reconcile_item_raise body';
  END IF;

  IF (SELECT count(*) FROM public.reconcile_item_kinds
      WHERE kind IN ('message_no_job', 'open_item_check', 'agent_money_proposal', 'ai_job_failed')) <> 4 THEN
    RAISE EXCEPTION 'P4-01.6 rollback must keep the four allow-list kind rows';
  END IF;
END $rollback$;
SELECT 'PASS P4-01.6 rollback: door functions and 8-arg overload removed, P2-03.2 raise restored, four kinds kept';
ROLLBACK;
