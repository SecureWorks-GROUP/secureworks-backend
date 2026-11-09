-- After the down: the owner approval functions and the crew gate are gone,
-- the decisions are kept, and the earlier surface is back (an approver seals a
-- bound draft directly; release on acceptance releases).
DO $$
BEGIN
  ASSERT to_regclass('public.scope_owner_approvals') IS NOT NULL, 'down keeps the recorded decisions';
  ASSERT to_regprocedure('public.record_scope_price_approval(uuid,uuid,uuid,text,uuid,text[])') IS NULL
    AND to_regprocedure('public.record_job_work_order_approval(uuid,uuid,text,timestamptz,uuid,uuid,boolean)') IS NULL
    AND to_regprocedure('public.issue_owner_approved_job_work_order(uuid)') IS NULL
    AND to_regprocedure('public.job_work_order_owner_gate(public.work_orders,text)') IS NULL
    AND to_regprocedure('public.owner_approved_job_work_order_drafts(integer)') IS NULL
    AND to_regprocedure('public.approve_job_work_order(uuid,uuid,text,timestamptz,uuid)') IS NULL
    AND to_regprocedure('public.owner_approval_company_ok(uuid,uuid,uuid)') IS NULL
    AND to_regprocedure('public.record_quote_send_price_unapproved(text,uuid,text,uuid,text,uuid)') IS NULL
    AND to_regprocedure('public.scope_revision_quote_documents(uuid)') IS NULL
    AND to_regprocedure('public.owner_approval_required()') IS NULL
    AND to_regprocedure('public.record_work_order_owner_unapproved(uuid,uuid,text,text,text,uuid,text[])') IS NULL,
    'down removes the owner approval functions';
  ASSERT to_regclass('public.quote_send_price_unapproved_sends') IS NOT NULL, 'down keeps the unapproved-send records';
  ASSERT to_regclass('public.job_work_order_owner_unapproved') IS NOT NULL, 'down keeps the unapproved work order records';
  ASSERT position('acceptance_recorded_at' IN pg_get_functiondef('public.scope_payment_acceptance_event()'::regprocedure)) = 0,
    'down restores the earlier deposit event time';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_work_orders_crew_owner_gate'), 'down removes the crew gate';
  ASSERT NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'owner_approval_saved_revision_required_v1'),
    'down removes the saved-revision switch';
  ASSERT position('owner_approval' IN pg_get_functiondef('public.work_orders_job_kind_guard()'::regprocedure)) = 0,
    'down restores the earlier seal';
  ASSERT has_function_privilege('service_role', 'public.approve_job_work_order(uuid,uuid,text,timestamptz)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.release_scope_job_drafts(uuid,uuid,boolean)', 'EXECUTE'),
    'down keeps the earlier access';
END $$;

BEGIN;
DO $$
DECLARE
  org uuid := gen_random_uuid(); job uuid := gen_random_uuid(); rev uuid := gen_random_uuid(); wo uuid;
  pricing jsonb := '{"totalExGST":30.03,"gst":3.00,"totalIncGST":33.03,"labourCostEstimate":12.00,
    "internal":{"labour_lines":[{"line_key":"fixture-labour","description":"Synthetic installation","total":12}]},
    "parties":[{"id":"__client__","ex_gst":30.03,"gst":3.00,"inc_gst":33.03}]}';
BEGIN
  INSERT INTO public.jobs(id, org_id, type, status, job_number) VALUES (job, org, 'fencing', 'draft', 'ZZTEST-SE-OWR-1');
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, job, 1, 'frozen', '{}', pricing::text,
      encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to(pricing::text, 'UTF8')), 'hex'));
  PERFORM public.prepare_scope_job_drafts(job, rev, org);
  UPDATE public.jobs SET status = 'accepted' WHERE id = job;
  PERFORM public.release_scope_job_drafts(job, rev);
  ASSERT (SELECT released_at IS NOT NULL FROM public.scope_job_draft_sets WHERE job_id = job),
    'down: acceptance releases again';
  SELECT id INTO wo FROM public.work_orders WHERE job_id = job AND kind = 'job';
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = wo), 'down: release still never approves';
END $$;
ROLLBACK;
