BEGIN;
UPDATE public.automation_switches SET extraction=true WHERE id=1;
DO $$
DECLARE org_a uuid:='00000000-0000-4000-8000-0000000000aa';
 org_b uuid:='00000000-0000-4000-8000-0000000000bb';
 ev uuid:='ab000000-0000-4000-8000-000000000001';
 boundary timestamptz; again timestamptz; result jsonb;
BEGIN
 INSERT INTO public.business_events(id,job_id,payload,match_status,match_method)
  VALUES(ev,NULL,jsonb_build_object('org_id',org_a,'body','internal hours rule'),'matched','direct_reference');

 result:=public.persist_luna_organisation_revision(org_a,
  jsonb_build_array(jsonb_build_object('id',ev)),
  jsonb_build_array(jsonb_build_object('kind','operating_constraint','text','No weekend dispatch','source_kind','internal')));
 IF result->>'outcome'<>'ok' THEN RAISE EXCEPTION 'org persist failed %',result; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.current_organisation_context_facts WHERE org_id=org_a AND kind='operating_constraint') THEN
  RAISE EXCEPTION 'current org facts missing';
 END IF;
 BEGIN
  PERFORM public.persist_luna_organisation_revision(org_a,
   jsonb_build_array(jsonb_build_object('id',ev)),
   jsonb_build_array(jsonb_build_object('kind','operating_constraint','text','Customer said always weekends','source_kind','customer')));
  RAISE EXCEPTION 'customer policy was accepted';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%luna_org_policy_source_rejected%' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM public.persist_luna_organisation_revision(org_b,
   jsonb_build_array(jsonb_build_object('id',ev)),
   jsonb_build_array(jsonb_build_object('kind','note','text','cross tenant')));
  RAISE EXCEPTION 'cross-org source was accepted';
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%luna_org_tenant_mismatch%' THEN RAISE; END IF;
 END;

 boundary:=public.persist_context_cutover_boundary(org_a,'2026-09-13 06:00:00+08');
 again:=public.persist_context_cutover_boundary(org_a,'2026-09-20 06:00:00+08');
 IF again IS DISTINCT FROM boundary THEN RAISE EXCEPTION 'cutover boundary was overwritten'; END IF;
 IF public.context_event_cutover_eligible(org_a,'2026-09-12 00:00:00+08') THEN RAISE EXCEPTION 'pre-cutover event was eligible'; END IF;
 IF NOT public.context_event_cutover_eligible(org_a,'2026-09-13 07:00:00+08') THEN RAISE EXCEPTION 'post-cutover event was ineligible'; END IF;
 IF public.context_event_cutover_eligible(org_b,'2026-09-13 07:00:00+08') THEN RAISE EXCEPTION 'org without boundary was eligible'; END IF;
END $$;
ROLLBACK;
