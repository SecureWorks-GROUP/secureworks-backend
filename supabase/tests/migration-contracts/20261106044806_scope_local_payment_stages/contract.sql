-- Synthetic-only local business outcomes. No accounting providers involved.
BEGIN;
DO $$
DECLARE org uuid:=gen_random_uuid(); job uuid:=gen_random_uuid(); rev uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
  submission uuid:=gen_random_uuid(); assignment uuid:=gen_random_uuid(); ghost uuid:=gen_random_uuid();
  pricing jsonb; schedule jsonb; result jsonb; first_ids jsonb; held_id uuid; bad_job uuid:=gen_random_uuid(); bad_rev uuid:=gen_random_uuid();
BEGIN
  INSERT INTO public.users(id,org_id,role,name) VALUES(actor,org,'admin','ZZTEST Scope Checker');
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'fencing','draft','ZZTEST-SE-STAGES-LOCAL');
  INSERT INTO public.council_submissions(id,org_id,job_id,steps) VALUES(submission,org,job,
    '[{"step_id":"fixture-step","name":"Synthetic council step","status":"pending"}]');
  schedule:=jsonb_build_object('version',1,'currency','AUD','terms_version','2026-11-06','total_inc_gst',11,
    'stages',jsonb_build_array(
      jsonb_build_object('id','first','label','First payment','printed_terms','Synthetic deposit terms','amount_inc_gst',3,
        'basis','deposit','trigger',jsonb_build_object('kind','quote_accepted'),'due_rule',jsonb_build_object('kind','days_after_trigger','days',2),
        'payers',jsonb_build_array(jsonb_build_object('payer_id','__client__','amount_inc_gst',3))),
      jsonb_build_object('id','install','label','Installation','printed_terms','Synthetic work terms','amount_inc_gst',4,
        'basis','work_done','trigger',jsonb_build_object('kind','install_scheduled'),'due_rule',jsonb_build_object('kind','days_after_trigger','days',3),
        'payers',jsonb_build_array(jsonb_build_object('payer_id','__client__','amount_inc_gst',4))),
      jsonb_build_object('id','council','label','Council','printed_terms','Synthetic council terms','amount_inc_gst',2,
        'basis','work_done','trigger',jsonb_build_object('kind','council_step_completed','submission_id',submission,'step_id','fixture-step','step_name','Synthetic council step'),
        'due_rule',jsonb_build_object('kind','days_after_trigger','days',1),'payers',jsonb_build_array(jsonb_build_object('payer_id','__client__','amount_inc_gst',2))),
      jsonb_build_object('id','manual','label','Manual stage','printed_terms','Unconfirmed synthetic terms','amount_inc_gst',2,
        'basis','unconfirmed','trigger',jsonb_build_object('kind','stage_confirmed'),'due_rule',jsonb_build_object('kind','days_after_trigger','days',0),
        'payers',jsonb_build_array(jsonb_build_object('payer_id','__client__','amount_inc_gst',2)))));
  schedule:=jsonb_set(schedule,'{stages,0,payers}','[{"payer_id":"__client__","amount_inc_gst":2},{"payer_id":"fixture-neighbour","amount_inc_gst":1}]');
  schedule:=jsonb_set(schedule,'{stages,1,payers}','[{"payer_id":"__client__","amount_inc_gst":2},{"payer_id":"fixture-neighbour","amount_inc_gst":2}]');
  schedule:=jsonb_set(schedule,'{stages,2,payers}','[{"payer_id":"__client__","amount_inc_gst":1},{"payer_id":"fixture-neighbour","amount_inc_gst":1}]');
  schedule:=jsonb_set(schedule,'{stages,3,payers}','[{"payer_id":"__client__","amount_inc_gst":1},{"payer_id":"fixture-neighbour","amount_inc_gst":1}]');
  pricing:=jsonb_build_object('totalExGST',10,'gst',1,'totalIncGST',11,'labourCostEstimate',4,
    'parties','[{"id":"__client__","ex_gst":5.45,"gst":0.55,"inc_gst":6},{"id":"fixture-neighbour","ex_gst":4.55,"gst":0.45,"inc_gst":5}]'::jsonb,
    'internal',jsonb_build_object('labour_lines',jsonb_build_array(jsonb_build_object('description','Synthetic labour','total',4))),
    'local_invoice_stages',schedule);
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES(rev,job,1,'frozen','{}',pricing::text,encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
  PERFORM public.prepare_scope_job_drafts(job,rev,org);
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status,is_ghost,role,assignment_type)
    VALUES(assignment,job,actor,current_date,'confirmed',false,'lead_installer','install');
  result:=public.read_scope_payment_stages(job,rev,org);
  ASSERT result->'stages'='[]'::jsonb AND result->>'prepared'='false','unaccepted stages stay absent';
  UPDATE public.jobs SET status='partially_accepted' WHERE id=job;
  ASSERT NOT EXISTS(SELECT 1 FROM public.scope_payment_plans WHERE job_id=job),'partial acceptance creates no plan';
  UPDATE public.jobs SET status='accepted' WHERE id=job;
  PERFORM public.release_scope_job_drafts(job,rev);
  result:=public.read_scope_payment_stages(job,rev,org);
  ASSERT jsonb_array_length(result->'stages')=4 AND result#>>'{stages,0,stage_id}'='first','first payment and retained pre-acceptance booking consume only after acceptance';
  ASSERT (SELECT sum(amount_cents) FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='first')=300,'first amount is sealed amount';
  first_ids:=result->'stages';
  PERFORM public.release_scope_job_drafts(job,rev);
  ASSERT (public.read_scope_payment_stages(job,rev,org))->'stages'=first_ids,'acceptance retry retains first identities';
  INSERT INTO public.job_assignments(id,job_id,user_id,scheduled_date,status,is_ghost,role,assignment_type)
    VALUES(ghost,job,actor,current_date+10,'confirmed',true,'observer','install');
  ASSERT (SELECT count(*) FROM public.scope_payment_stage_drafts WHERE job_id=job)=4,'ghost booking creates no stage';
  UPDATE public.jobs SET pricing_json='{"totalIncGST":999,"local_invoice_stages":{"stages":[]}}'::jsonb WHERE id=job;
  UPDATE public.job_assignments SET is_ghost=false,role='lead_installer',scheduled_date=current_date+1 WHERE id=assignment;
  SELECT id INTO held_id FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='install' AND payer_id='__client__';
  ASSERT held_id IS NOT NULL AND (SELECT held_reason='work_or_material_evidence_required' FROM public.scope_payment_stage_drafts WHERE id=held_id),
    'booking alone is held, never work proof';
  PERFORM public.confirm_scope_payment_stage(job,rev,org,actor,'install','work_done','Synthetic staff completion evidence');
  ASSERT (SELECT held_reason IS NULL FROM public.scope_payment_stage_drafts WHERE id=held_id),'recorded work evidence clears only hold';
  UPDATE public.job_assignments SET scheduled_date=current_date+2 WHERE id=assignment;
  ASSERT (SELECT count(*) FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='install')=2,'rescheduling cannot duplicate';
  ASSERT (SELECT sum(amount_cents) FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='install')=400,'mutable current pricing never reprices an accepted stage';
  PERFORM public.consume_scope_council_payment_event(submission,'fixture-step');
  ASSERT NOT EXISTS(SELECT 1 FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='council'),'pending step is not completion';
  UPDATE public.council_submissions SET steps='[{"step_id":"fixture-step","name":"Synthetic council step","status":"complete","completed_at":"2026-11-06T00:00:00Z"}]' WHERE id=submission;
  PERFORM public.consume_scope_council_payment_event(submission,'wrong-step');
  ASSERT NOT EXISTS(SELECT 1 FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='council'),'wrong step is refused';
  PERFORM public.consume_scope_council_payment_event(submission,'fixture-step');
  PERFORM public.consume_scope_council_payment_event(submission,'fixture-step');
  ASSERT (SELECT count(*) FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='council')=2,'exact council event consumes once per payer';
  PERFORM public.confirm_scope_payment_stage(job,rev,org,actor,'manual','work_done','Synthetic stage completion evidence');
  ASSERT (SELECT bool_and(held_reason='basis_unconfirmed') FROM public.scope_payment_stage_drafts WHERE job_id=job AND stage_id='manual'),
    'unknown contractual basis never becomes collectible';
  ASSERT (SELECT sum(amount_cents) FROM public.scope_payment_stage_drafts WHERE job_id=job)=1100,'all stages reconcile to parent';
  ASSERT (SELECT count(*) FROM public.scope_job_draft_invoices WHERE job_id=job)=2,'stages never create duplicate whole-quote invoices';
  ASSERT NOT EXISTS(SELECT 1 FROM public.scope_job_draft_invoices i WHERE i.job_id=job AND i.inc_cents<>(
    SELECT sum(amount_cents) FROM public.scope_payment_stage_drafts d WHERE d.payer_invoice_id=i.id)), 'each payer reconciles across all stages';
  -- A malformed schedule must not partially consume a stage or fail acceptance.
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(bad_job,org,'fencing','draft','ZZTEST-SE-STAGES-INVALID');
  pricing:=jsonb_set(pricing,'{local_invoice_stages,stages,0,payers,0,amount_inc_gst}','1.99');
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES(bad_rev,bad_job,1,'frozen','{}',pricing::text,encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
  PERFORM public.prepare_scope_job_drafts(bad_job,bad_rev,org);
  UPDATE public.jobs SET status='accepted' WHERE id=bad_job;
  PERFORM public.release_scope_job_drafts(bad_job,bad_rev);
  ASSERT NOT EXISTS(SELECT 1 FROM public.scope_payment_plans WHERE job_id=bad_job),'invalid schedule writes no partial plan';
  ASSERT (SELECT released_at IS NOT NULL FROM public.scope_job_draft_sets WHERE job_id=bad_job),'invalid stages cannot fail acceptance';
  ASSERT NOT has_table_privilege('authenticated','public.scope_payment_stage_drafts','SELECT'),'no browser money read';
  ASSERT NOT has_table_privilege('service_role','public.scope_payment_stage_drafts','UPDATE'),'no direct money rewriting';
END $$;
ROLLBACK;
