-- Synthetic data only. Exercises stored business outcomes in PostgreSQL.
BEGIN;
DO $$
DECLARE
  org uuid := gen_random_uuid(); job uuid := gen_random_uuid(); other_job uuid := gen_random_uuid();
  revision uuid := gen_random_uuid(); next_revision uuid := gen_random_uuid(); prior_revision uuid;
  pricing jsonb := '{"totalExGST":30.03,"gst":3.00,"totalIncGST":33.03,"labourCostEstimate":12.00,
    "internal":{"labour_lines":[{"line_key":"fixture-labour","description":"Synthetic installation","total":12}]},
    "parties":[{"id":"__client__","ex_gst":15.01,"gst":1.50,"inc_gst":16.51},
               {"id":"fixture-payer","ex_gst":15.02,"gst":1.50,"inc_gst":16.52}]}';
  a jsonb; b jsonb; wo uuid; refused boolean; n bigint;
BEGIN
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
    (job,org,'fencing','draft','ZZTEST-SE-FIXTURE-LOCAL'),
    (other_job,org,'patio','draft','ZZTEST-SE-FIXTURE-UNKNOWN');
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES (revision,job,1,'frozen','{}',pricing::text,
      encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
  refused := false;
  BEGIN PERFORM public.read_scope_job_drafts(job,revision,org);
  EXCEPTION WHEN no_data_found THEN refused := SQLERRM = 'scope_drafts_not_found'; END;
  ASSERT refused, 'absent drafts must be a not-found result';
  a := public.prepare_scope_job_drafts(job,revision,org);
  b := public.prepare_scope_job_drafts(job,revision,org);
  ASSERT a = b, 'repeat preparation must return the same persisted identities';
  ASSERT a = public.read_scope_job_drafts(job,revision,org), 'read must return stored drafts';
  ASSERT jsonb_array_length(a->'invoices') = 2 AND a->>'amounts_confirmed' = 'true', 'one invoice per payer';
  ASSERT (SELECT sum((v->>'ex_gst')::numeric) FROM jsonb_array_elements(a->'invoices') v) = 30.03, 'payer cents must reconcile';
  ASSERT a->>'xero_writes' = 'false' AND a->>'sent' = 'false' AND a->>'payment_links' = 'false', 'local only';
  wo := (a#>>'{work_order,id}')::uuid;
  ASSERT (SELECT count(*) FROM public.work_orders WHERE job_id=job AND kind='job') = 1, 'one persistent job work order';
  ASSERT (SELECT status='draft' AND approved_at IS NULL AND quote_filled_at IS NULL AND scope_revision_id=revision AND quote_filled_scope_revision_id=revision
    AND scope_items=pricing#>'{internal,labour_lines}' AND agreed_labour_ex=12 FROM public.work_orders WHERE id=wo), 'bound draft, never approval';
  refused := false;
  BEGIN PERFORM public.prepare_scope_job_drafts(job,revision,gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  ASSERT refused, 'cross-organisation access must refuse';
  refused := false;
  BEGIN PERFORM public.prepare_scope_job_drafts(other_job,revision,org);
  EXCEPTION WHEN no_data_found THEN refused := true; END;
  ASSERT refused, 'different-job revision must refuse';
  refused := false;
  BEGIN UPDATE public.work_orders SET agreed_labour_ex=99 WHERE id=wo;
  EXCEPTION WHEN check_violation THEN refused := SQLERRM='scope_drafts_source_bound'; END;
  ASSERT refused, 'generic editor must not move source-bound labour';
  UPDATE public.jobs SET status='partially_accepted' WHERE id=job;
  refused := false;
  BEGIN PERFORM public.release_scope_job_drafts(job,revision);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM='scope_drafts_acceptance_required'; END;
  ASSERT refused AND (SELECT released_at IS NULL FROM public.scope_job_draft_sets WHERE job_id=job), 'partial acceptance releases nothing';
  UPDATE public.jobs SET status='accepted' WHERE id=job;
  refused := false;
  BEGIN PERFORM public.release_scope_job_drafts(job,gen_random_uuid());
  EXCEPTION WHEN check_violation THEN refused := SQLERRM='scope_drafts_accepted_revision_mismatch'; END;
  ASSERT refused, 'accepted source cannot be replaced with another revision';
  PERFORM public.release_scope_job_drafts(job,revision);
  PERFORM public.release_scope_job_drafts(job,revision);
  b := public.read_scope_job_drafts(job,revision,org);
  ASSERT b#>>'{work_order,status}'='released' AND b#>>'{work_order,id}'=wo::text, 'release the same work order';
  ASSERT (SELECT status='draft' AND approved_at IS NULL FROM public.work_orders WHERE id=wo), 'release never approves';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id=job AND event_type='scope_job_draft_work_order_released')=1, 'one release audit';
  ASSERT b->'invoices'=a->'invoices', 'acceptance must leave local invoices as drafts';
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES (next_revision,other_job,1,'frozen','{}','{}',
      encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to('{}','UTF8')),'hex'));
  b := public.prepare_scope_job_drafts(other_job,next_revision,org);
  ASSERT b->>'amounts_confirmed'='false' AND b#>'{invoices,0,ex_gst}'='null'::jsonb
    AND b#>'{work_order,labour_total_ex_gst}'='null'::jsonb, 'unknown must stay null';
  -- A new frozen scope updates the same unaccepted work order. Removed payer
  -- records are retained under their previous revision, never deleted.
  prior_revision := next_revision;
  next_revision := gen_random_uuid();
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES (next_revision,other_job,2,'frozen','{}',pricing::text,
      encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
  UPDATE public.scope_revisions SET status='superseded', superseded_by_scope_revision_id=next_revision, superseded_at=now() WHERE id=prior_revision;
  a := public.prepare_scope_job_drafts(other_job,next_revision,org);
  ASSERT a#>>'{work_order,id}'=b#>>'{work_order,id}', 'new source must not duplicate work order';
  -- Deliberately inconsistent split must roll back without a draft set.
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES
    (gen_random_uuid(),org,'fencing','draft','ZZTEST-SE-FIXTURE-INVALID') RETURNING id INTO other_job;
  pricing := jsonb_set(pricing,'{parties,0,ex_gst}','15.02');
  next_revision := gen_random_uuid();
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES (next_revision,other_job,1,'frozen','{}',pricing::text,
      encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(pricing::text,'UTF8')),'hex'));
  refused := false;
  BEGIN PERFORM public.prepare_scope_job_drafts(other_job,next_revision,org);
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused AND NOT EXISTS(SELECT 1 FROM public.scope_job_draft_sets WHERE job_id=other_job), 'invalid split must write nothing';
  ASSERT NOT has_table_privilege('authenticated','public.scope_job_draft_invoices','SELECT'), 'private money table';
  ASSERT NOT has_function_privilege('anon','public.prepare_scope_job_drafts(uuid,uuid,uuid)','EXECUTE'), 'no public prepare RPC';
  ASSERT NOT has_function_privilege('authenticated','public.release_scope_job_drafts(uuid,uuid,boolean)','EXECUTE'), 'no browser release RPC';
END $$;
ROLLBACK;
