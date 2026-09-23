-- The down migration restores the exact live production body (so the forward
-- guard accepts it again) and its legacy step 1.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)
  <>'e6d5a8ec5ab942dff7f288d579d1b8f4' THEN RAISE EXCEPTION 'L1 rollback: body is not the live production body'; END IF;
 IF has_function_privilege('anon','public.resolve_context_attribution(public.business_events)','EXECUTE')
 THEN RAISE EXCEPTION 'L1 rollback: ladder callable by anon'; END IF;
END $$;
BEGIN;
DO $$
DECLARE org uuid:='00000000-0000-0000-0000-000000000001'; holding uuid:=gen_random_uuid(); e public.business_events;
BEGIN
 INSERT INTO public.jobs(id,org_id,status,type,job_number,metadata) VALUES
 (holding,org,'archived','fencing','SWF-PDF-BUCKET','{"do_not_schedule":true}');
 INSERT INTO public.xero_invoices(org_id,xero_invoice_id,invoice_number,invoice_type,job_id) VALUES(org,'l1-rb-21','21','ACCPAY',holding);
 INSERT INTO public.business_events(payload) VALUES('{"body":"see you on the 21 Sep"}') RETURNING * INTO e;
 IF e.job_id IS DISTINCT FROM holding THEN RAISE EXCEPTION 'L1 rollback: legacy step 1 not restored'; END IF;
END $$;
ROLLBACK;
-- A repeated rollback is accepted and leaves the live body.
\ir ../../../rollbacks/20260923230000_context_ladder_step1_own_references_live_down.sql
-- The forward migration applies again cleanly on the restored production body.
\ir ../../../migrations/20260923230000_context_ladder_step1_own_references_live.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)
  <>'acb80ebe792beeb7e5b537643bf9f184' THEN RAISE EXCEPTION 'L1 rollback: forward re-apply on the live body failed'; END IF;
END $$;
-- A database built from the repository migrations (20260911171000 body, comment-only
-- difference) is also accepted by the forward guard.
\ir repository-preimage.sql
\ir ../../../migrations/20260923230000_context_ladder_step1_own_references_live.sql
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)
  <>'acb80ebe792beeb7e5b537643bf9f184' THEN RAISE EXCEPTION 'L1 rollback: forward apply on the repository body failed'; END IF;
END $$;
