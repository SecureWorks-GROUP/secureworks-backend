-- Synthetic sources only. Verify replacement, source custody and sealed holds.
BEGIN;
DO $$
DECLARE
  org uuid := gen_random_uuid(); job uuid; revision uuid; next_revision uuid;
  wo uuid; trade text; pricing jsonb; a jsonb; b jsonb; refused boolean;
BEGIN
  FOREACH trade IN ARRAY ARRAY['fencing', 'patio'] LOOP
    job := gen_random_uuid(); revision := gen_random_uuid();
    INSERT INTO public.jobs(id,org_id,type,status,job_number)
      VALUES(job,org,trade,'draft','ZZTEST-SE-SAVED-HANDOFF-' || trade);
    wo := public.ensure_job_work_order_draft(job,'manual');
    UPDATE public.work_orders SET scope_items='[{"description":"Synthetic earlier draft","total":3.69}]',
      agreed_labour_ex=3.69 WHERE id=wo;
    pricing := '{"labourCostEstimate":27.41,"job_description":"Synthetic saved installation"}';
    INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
      VALUES(revision,job,1,'frozen','{}',pricing::text,
        encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
    a := public.prepare_scope_job_drafts(job,revision,org);
    b := public.prepare_scope_job_drafts(job,revision,org);
    ASSERT a=b AND a#>>'{work_order,id}'=wo::text, 'repeat must retain stored identities';
    ASSERT (SELECT count(*) FROM public.work_orders WHERE job_id=job AND kind='job')=1, 'one work order per job';
    ASSERT (SELECT scope_revision_id=revision AND quote_filled_scope_revision_id=revision
      AND status='draft' AND approved_at IS NULL AND agreed_labour_ex=27.41
      AND scope_items#>>'{0,description}'='Synthetic saved installation'
      AND (scope_items#>>'{0,total}')::numeric=27.41 FROM public.work_orders WHERE id=wo),
      'saved frozen amount replaces previous draft lines and binds its source';
    ASSERT a->>'amounts_confirmed'='false' AND a#>'{invoices,0,ex_gst}'='null'::jsonb,
      'unknown client price must not prevent a known labour handoff or become zero';
    -- The mutable working pricing is never the monetary source.
    UPDATE public.jobs SET pricing_json='{"labourCostEstimate":999}' WHERE id=job;
    PERFORM public.prepare_scope_job_drafts(job,revision,org);
    ASSERT (SELECT agreed_labour_ex=27.41 FROM public.work_orders WHERE id=wo), 'frozen pricing only';
    next_revision := gen_random_uuid();
    pricing := '{"labourCostEstimate":19.87,"internal":{"labour_lines":[{"description":"Synthetic revised work","total":19.87}]}}';
    INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
      VALUES(next_revision,job,2,'frozen','{}',pricing::text,
        encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
    UPDATE public.scope_revisions SET status='superseded', superseded_by_scope_revision_id=next_revision, superseded_at=now() WHERE id=revision;
    b := public.prepare_scope_job_drafts(job,next_revision,org);
    ASSERT b#>>'{work_order,id}'=wo::text AND b->'invoices'=a->'invoices', 'new source retains work-order and payer ids';
    ASSERT (SELECT agreed_labour_ex=19.87 AND scope_items=pricing#>'{internal,labour_lines}'
      AND scope_revision_id=next_revision FROM public.work_orders WHERE id=wo), 'new source replaces old lines';
    -- Mismatched labour lines cannot replace the retained draft.
    next_revision := gen_random_uuid();
    pricing := '{"labourCostEstimate":19.87,"internal":{"labour_lines":[{"description":"Synthetic bad work","total":2.01}]}}';
    INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
      VALUES(next_revision,job,3,'frozen','{}',pricing::text,
        encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
    refused := false;
    BEGIN PERFORM public.prepare_scope_job_drafts(job,next_revision,org);
    EXCEPTION WHEN check_violation THEN refused := SQLERRM='scope_drafts_labour_total_mismatch'; END;
    ASSERT refused AND (SELECT agreed_labour_ex=19.87 FROM public.work_orders WHERE id=wo), 'mismatched lines cannot rewrite saved money';
    -- Use the current source with matching lines for the independent seal test.
    pricing := '{"labourCostEstimate":19.87,"internal":{"labour_lines":[{"description":"Synthetic revised work","total":19.87}]}}';
    revision := gen_random_uuid();
    INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
      VALUES(revision,job,4,'frozen','{}',pricing::text,
        encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
    -- A draft carrying a seal is protected independently of its status label.
    UPDATE public.work_orders SET sealed_content_hash='synthetic-seal' WHERE id=wo;
    refused := false;
    BEGIN PERFORM public.prepare_scope_job_drafts(job,revision,org);
    EXCEPTION WHEN check_violation THEN refused := SQLERRM='scope_drafts_work_order_sealed'; END;
    ASSERT refused AND (SELECT agreed_labour_ex=19.87 AND sealed_content_hash='synthetic-seal' FROM public.work_orders WHERE id=wo),
      'sealed draft is untouched';
  END LOOP;
END $$;
ROLLBACK;
