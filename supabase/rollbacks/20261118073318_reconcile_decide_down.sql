-- P2-03.3 rollback: drop the two functions this migration created. Decisions
-- already recorded are append-only history and stay; cost lines keep their state.
DROP FUNCTION IF EXISTS public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid);
DROP FUNCTION IF EXISTS public.reconcile_decide_live_job(uuid,uuid);
