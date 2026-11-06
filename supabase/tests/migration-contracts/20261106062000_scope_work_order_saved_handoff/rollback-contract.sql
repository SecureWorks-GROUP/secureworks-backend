BEGIN;
DO $$
DECLARE org uuid:=gen_random_uuid(); job uuid:=gen_random_uuid(); revision uuid:=gen_random_uuid(); wo uuid; refused boolean:=false;
BEGIN
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'patio','draft','ZZTEST-SE-HANDOFF-UNDO');
  wo := public.ensure_job_work_order_draft(job,'manual');
  UPDATE public.work_orders SET agreed_labour_ex=3.69 WHERE id=wo;
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES(revision,job,1,'frozen','{}','{}',encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to('{}','UTF8')),'hex'));
  BEGIN PERFORM public.prepare_scope_job_drafts(job,revision,org);
  EXCEPTION WHEN check_violation THEN refused:=SQLERRM='scope_drafts_work_order_has_content'; END;
  ASSERT refused AND (SELECT agreed_labour_ex=3.69 FROM public.work_orders WHERE id=wo), 'undo restores the previous content-preservation policy';
  ASSERT NOT has_function_privilege('anon','public.prepare_scope_job_drafts(uuid,uuid,uuid)','EXECUTE'), 'undo preserves private RPC';
END $$;
ROLLBACK;
