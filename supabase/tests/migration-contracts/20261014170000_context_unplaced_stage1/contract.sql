-- Unplaced stage 1 (20261014170000). Registered on 29 Oct 2026 (TP-04) so the
-- walk carries stage 1 between L1g and its successors, as production does:
-- before this case, every later contract ran against L1g's rules ladder while
-- production ran stage 1's. This is a structural contract only; stage 1's
-- behaviour is documented in docs/context/unplaced-stage1.md and was proved
-- by its own review, not here.
DO $$
DECLARE f text; r text;
BEGIN
 -- The rules ladder is stage 1's, or its registered successor's (TP-04,
 -- 20261029190000, which changes only the holding predicate).
 IF coalesce(obj_description('public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure,'pg_proc'),'') NOT LIKE 'L1g plus unplaced stage 1%'
 THEN RAISE EXCEPTION 's1: the rules ladder is not marked as stage 1''s'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events,boolean,boolean)'::regprocedure)
  NOT IN ('58fcf93d4c82604822d4ca4b70cc4680','2ccef791fca954bfe1fcbb4e0de5f8a2')
 THEN RAISE EXCEPTION 's1: the rules ladder is neither stage 1''s nor TP-04''s'; END IF;
 -- The rules-off ladder and the entry are untouched.
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ladder_p1a(public.business_events,boolean)'::regprocedure)<>'ce620833c851196a00eca328d9b7426a'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure)<>'32365101d23dde1695707a0bddff640b'
 THEN RAISE EXCEPTION 's1: the rules-off ladder or the entry changed'; END IF;
 -- Its helpers exist and are private to the service role.
 FOREACH f IN ARRAY ARRAY['public.context_job_real(uuid)','public.context_job_live(uuid)','public.context_job_dead(uuid)',
  'public.context_rank_contact_set(uuid[],uuid[])','public.context_link_ref_jobs(text)','public.context_builder_ref_jobs(text,jsonb)',
  'public.context_party_key_jobs(text,text,timestamptz)','public.context_redecide_one(uuid,text,jsonb)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 's1: % is missing',f; END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF has_function_privilege(r,f,'EXECUTE') THEN RAISE EXCEPTION 's1: % can call %',r,f; END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('context_thread_bound_redecide','context_invoice_linked_redecide','context_job_contact_linked_reconsider') AND NOT tgisinternal)<>3
 THEN RAISE EXCEPTION 's1: an evidence trigger is missing'; END IF;
END $$;
