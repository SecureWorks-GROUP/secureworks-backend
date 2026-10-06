-- Earlier registered context fixtures supply the run ledger, the
-- reservations, K1, the backlog ceiling, document vision, the ledger model and
-- store and the heartbeat. Prove each function this migration replaces is
-- still its repository body, which is production's (md5s read read-only on
-- 6 Oct 2026), so the contract runs from production's starting point.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.reserve_context_model_call(text,uuid,uuid)', '28545c710b6234b76ba25eb09093fa39'),
  ('public.context_ledger_budget()', '1584094b4240c206d05e12469e068c33'),
  ('public.context_document_vision_policy()', 'd56417f7977b5eb229417e2e03525a72'),
  ('public.context_document_vision_admission()', '4366041d73165b1562c1af304a7534b3'),
  ('public.context_core_status()', 'e26a2d4387c9f642f473aa16caf4ab98')) AS t(sig, md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'call budget setup: % is not the pre-image (%)', x.sig, live; END IF;
 END LOOP;
 SELECT md5(regexp_replace(prosrc, '(''live_since'','')[^'']*('')', '\1<live_since>\2')) INTO live
 FROM pg_proc WHERE oid = 'public.context_cadence_policy()'::regprocedure;
 IF live IS DISTINCT FROM 'dba14be399cee7dd3e5165835bb623c6' THEN
  RAISE EXCEPTION 'call budget setup: context_cadence_policy() is not K1''s body (masked md5 %)', live;
 END IF;
END $$;
-- What the contract compares against: the policies, the bodies of the readers
-- this migration leaves alone, and the policy's exact text.
DROP TABLE IF EXISTS public.call_budget_contract_preimage;
CREATE TABLE public.call_budget_contract_preimage AS
SELECT public.context_cadence_policy() AS policy, public.context_document_vision_policy() AS vision_policy,
 (SELECT prosrc FROM pg_proc WHERE oid = 'public.context_cadence_policy()'::regprocedure) AS policy_src,
 (SELECT jsonb_object_agg(p.oid::regprocedure::text, md5(p.prosrc)) FROM pg_proc p
  WHERE p.oid IN ('public.context_jobs_cadence(uuid[])'::regprocedure, 'public.context_cadence_status()'::regprocedure,
   'public.claim_context_extraction_run(uuid,date,text)'::regprocedure, 'public.context_pipeline_status()'::regprocedure,
   'public.context_document_vision_status()'::regprocedure, 'public.claim_context_document_vision(jsonb)'::regprocedure,
   'public.context_extraction_candidates(integer)'::regprocedure, 'public.context_ready_jobs_count(integer)'::regprocedure)) AS untouched;
