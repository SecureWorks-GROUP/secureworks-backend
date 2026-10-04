-- Earlier registered context fixtures supply jobs, business_events, the run
-- ledger, receipts, the catch-up list (20260924220000) and the admission rule
-- (20261002170000). The open-invoice read needs xero_invoices.job_id. Prove the
-- pending read is still 20260924220000's body and the priority check is 1..2,
-- so the contract runs from production's starting point.
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS job_id uuid;
DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.context_catchup_pending_rows(uuid[])');
 IF live IS DISTINCT FROM '153a4a0e10b566445a029f0785c096ff' THEN RAISE EXCEPTION 'catch-up backlog setup: pending read is not the pre-image (%)',live; END IF;
 IF (SELECT array_agg(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.context_catchup_jobs'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%priority%') IS DISTINCT FROM ARRAY['CHECK ((priority = ANY (ARRAY[1, 2])))']
 THEN RAISE EXCEPTION 'catch-up backlog setup: priority check is not 1..2'; END IF;
END $$;
-- The policy before this migration, so the contract can prove every cap and
-- live_since are untouched.
DROP TABLE IF EXISTS public.backlog_contract_policy_preimage;
CREATE TABLE public.backlog_contract_policy_preimage AS SELECT public.context_cadence_policy() AS p;
