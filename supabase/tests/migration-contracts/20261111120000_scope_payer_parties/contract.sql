-- RQ-17.c: each payer the sealed quote names becomes a job party through
-- upsert_job_party. Synthetic data only.
DO $$
DECLARE
  org uuid := gen_random_uuid(); job uuid := gen_random_uuid(); legacy_job uuid := gen_random_uuid();
  solo_job uuid := gen_random_uuid(); bad_job uuid := gen_random_uuid();
  rev uuid := gen_random_uuid(); legacy_rev uuid := gen_random_uuid(); solo_rev uuid := gen_random_uuid();
  bad_rev uuid := gen_random_uuid(); stale_rev uuid := gen_random_uuid();
  two jsonb := '{"totalExGST":2000,"gst":200,"totalIncGST":2200,"labourCostEstimate":800,
    "internal":{"labour_lines":[]},
    "parties":[{"id":"__client__","role":"client","name":"ZZTEST Scope Checker","ex_gst":1000,"gst":100,"inc_gst":1100},
               {"id":"nb-1","role":"neighbour","name":"ZZTEST Neighbour One","phone":null,"email":"zztest-neighbour@example.invalid",
                "address":"1 ZZTEST Street","ex_gst":1000,"gst":100,"inc_gst":1100}]}';
  one jsonb := '{"totalExGST":1000,"gst":100,"totalIncGST":1100,"labourCostEstimate":400,"internal":{"labour_lines":[]},
    "parties":[{"id":"__client__","role":"client","name":"ZZTEST Scope Checker","ex_gst":1000,"gst":100,"inc_gst":1100}]}';
  bad jsonb := '{"totalExGST":2000,"gst":200,"totalIncGST":2200,"labourCostEstimate":800,"internal":{"labour_lines":[]},
    "parties":[{"id":"__client__","role":"client","ex_gst":1000,"gst":100,"inc_gst":1100},
               {"id":"bad payer id","role":"neighbour","name":"ZZTEST Neighbour Two","ex_gst":1000,"gst":100,"inc_gst":1100}]}';
  keep_job uuid := gen_random_uuid(); keep_rev uuid := gen_random_uuid();
  old_job uuid := gen_random_uuid(); old_rev uuid := gen_random_uuid();
  move_job uuid := gen_random_uuid(); move_rev1 uuid := gen_random_uuid();
  move_rev2 uuid := gen_random_uuid(); move_rev3 uuid := gen_random_uuid();
  sparse jsonb := '{"totalExGST":2000,"gst":200,"totalIncGST":2200,"labourCostEstimate":800,"internal":{"labour_lines":[]},
    "parties":[{"id":"__client__","role":"client","name":"ZZTEST Scope Checker","ex_gst":1000,"gst":100,"inc_gst":1100},
               {"id":"nb-1","role":"neighbour","name":"ZZTEST Neighbour One","phone":"","email":"","address":" ",
                "ex_gst":1000,"gst":100,"inc_gst":1100}]}';
  matched jsonb := '{"totalExGST":2000,"gst":200,"totalIncGST":2200,"labourCostEstimate":800,"internal":{"labour_lines":[]},
    "parties":[{"id":"__client__","role":"client","name":"ZZTEST Scope Checker","ex_gst":1000,"gst":100,"inc_gst":1100},
               {"id":"nb-1","role":"neighbour","name":"ZZTEST Neighbour One","phone":"","email":"zztest-neighbour@example.invalid",
                "ex_gst":1000,"gst":100,"inc_gst":1100}]}';
  a jsonb; b jsonb; refused boolean; n int; nb_id uuid; receipts int;
  owner_row public.job_contacts; nb_row public.job_contacts;
BEGIN
  INSERT INTO public.jobs(id,org_id,type,status,job_number,client_name) VALUES
    (job,org,'fencing','quoted','ZZTEST-SE-20261111-17C1','ZZTEST Scope Checker'),
    (legacy_job,org,'fencing','quoted','ZZTEST-SE-20261111-17C2','ZZTEST Scope Checker'),
    (solo_job,org,'fencing','quoted','ZZTEST-SE-20261111-17C3','ZZTEST Scope Checker'),
    (bad_job,org,'fencing','quoted','ZZTEST-SE-20261111-17C4','ZZTEST Scope Checker');
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
  SELECT v.id, v.job, 1, 'frozen', '{}', v.p::text, encode(sha256(convert_to('{}','UTF8')),'hex'), encode(sha256(convert_to(v.p::text,'UTF8')),'hex')
  FROM (VALUES (rev,job,two),(legacy_rev,legacy_job,two),(solo_rev,solo_job,one),(bad_rev,bad_job,bad)) v(id,job,p);
  PERFORM public.prepare_scope_job_drafts(job,rev,org);
  PERFORM public.prepare_scope_job_drafts(legacy_job,legacy_rev,org);
  PERFORM public.prepare_scope_job_drafts(solo_job,solo_rev,org);
  PERFORM public.prepare_scope_job_drafts(bad_job,bad_rev,org);

  -- 1. Two payers: the client is the job's owner party, the neighbour its own party.
  a := public.register_scope_payer_parties(job,rev,org);
  ASSERT a->>'outcome' = 'registered' AND jsonb_array_length(a->'parties') = 2, 'one party per sealed payer';
  SELECT * INTO owner_row FROM public.job_contacts WHERE job_id=job AND source_party_key='primary';
  SELECT * INTO nb_row FROM public.job_contacts WHERE job_id=job AND source_party_key='nb-1';
  ASSERT owner_row.id IS NOT NULL AND owner_row.is_primary AND owner_row.party_role='owner'
    AND owner_row.client_name='ZZTEST Scope Checker', 'the client is the owner party, named from the job';
  ASSERT nb_row.id IS NOT NULL AND NOT nb_row.is_primary AND nb_row.party_role='neighbour'
    AND nb_row.client_name='ZZTEST Neighbour One' AND nb_row.client_email='zztest-neighbour@example.invalid',
    'the neighbour is its own party with its sealed contact';
  ASSERT owner_row.share_percentage = 50 AND nb_row.share_percentage = 50
    AND owner_row.quote_value_ex_gst = 1000 AND nb_row.quote_value_ex_gst = 1000, 'each party holds its own share of the one quote';
  ASSERT (SELECT count(*) FROM public.job_contacts WHERE job_id=job) = 2, 'no other party rows';
  ASSERT (SELECT count(*) FROM public.job_party_events WHERE job_id=job) = 2, 'one receipt per payer';
  ASSERT (SELECT sum(i.inc_cents) FROM public.scope_job_draft_invoices i WHERE i.job_id=job) = 220000,
    'payer drafts still reconcile to the one quote';

  -- 2. Running it again changes nothing.
  b := public.register_scope_payer_parties(job,rev,org);
  ASSERT (SELECT array_agg(x->>'job_contact_id' ORDER BY x->>'payer_id') FROM jsonb_array_elements(b->'parties') x)
       = (SELECT array_agg(x->>'job_contact_id' ORDER BY x->>'payer_id') FROM jsonb_array_elements(a->'parties') x), 'same party ids';
  ASSERT (SELECT count(*) FROM public.job_contacts WHERE job_id=job) = 2, 'a re-run adds no party';

  -- 3. Older unkeyed party rows are adopted, never duplicated. A neighbour row
  -- the writer cannot match (no equal phone or email) refuses the whole call.
  INSERT INTO public.job_contacts(job_id,contact_label,is_primary,client_name,share_percentage) VALUES
    (legacy_job,'A',true,'ZZTEST Scope Checker',50),
    (legacy_job,'B',false,'ZZTEST Neighbour One',50);
  refused := false;
  BEGIN PERFORM public.register_scope_payer_parties(legacy_job,legacy_rev,org);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_payer_parties_legacy_unmatched'; END;
  ASSERT refused, 'an unmatched older neighbour row refuses';
  ASSERT (SELECT count(*) FROM public.job_contacts WHERE job_id=legacy_job) = 2
     AND NOT EXISTS (SELECT 1 FROM public.job_contacts WHERE job_id=legacy_job AND source_party_key IS NOT NULL),
    'the refusal writes nothing';
  UPDATE public.job_contacts SET client_email='ZZTEST-Neighbour@example.invalid' WHERE job_id=legacy_job AND contact_label='B';
  PERFORM public.register_scope_payer_parties(legacy_job,legacy_rev,org);
  ASSERT (SELECT count(*) FROM public.job_contacts WHERE job_id=legacy_job) = 2, 'legacy rows adopted, not doubled';
  ASSERT (SELECT array_agg(source_party_key ORDER BY contact_label) FROM public.job_contacts WHERE job_id=legacy_job)
       = ARRAY['primary','nb-1'], 'legacy rows now carry the sealed payer keys';

  -- 4. A single-payer quote writes nothing.
  a := public.register_scope_payer_parties(solo_job,solo_rev,org);
  ASSERT a->>'outcome' = 'single_payer' AND NOT EXISTS (SELECT 1 FROM public.job_contacts WHERE job_id=solo_job),
    'single payer: the owner rule stays as it is';

  -- 5. A payer the party writer refuses rolls the whole call back.
  refused := false;
  BEGIN PERFORM public.register_scope_payer_parties(bad_job,bad_rev,org);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'party_key_invalid'; END;
  ASSERT refused, 'an invalid payer id is refused by the one writer';
  ASSERT NOT EXISTS (SELECT 1 FROM public.job_contacts WHERE job_id=bad_job), 'no partial parties';

  -- 6. Another company, or a revision the drafts were not prepared from, is refused.
  refused := false;
  BEGIN PERFORM public.register_scope_payer_parties(job,rev,gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN refused := SQLERRM = 'scope_payer_parties_job_forbidden'; END;
  ASSERT refused, 'cross-company refused';
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES (stale_rev,job,2,'frozen','{}',two::text,encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(two::text,'UTF8')),'hex'));
  refused := false;
  BEGIN PERFORM public.register_scope_payer_parties(job,stale_rev,org);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_payer_parties_revision_stale'; END;
  ASSERT refused, 'only the revision the payer drafts came from';

  -- 8. A detail the quote leaves out or blank keeps what the party holds, for a
  -- keyed payer and for an adopted older payer.
  INSERT INTO public.jobs(id,org_id,type,status,job_number,client_name) VALUES
    (keep_job,org,'fencing','quoted','ZZTEST-SE-20261111-17C5','ZZTEST Scope Checker'),
    (old_job,org,'fencing','quoted','ZZTEST-SE-20261111-17C6','ZZTEST Scope Checker'),
    (move_job,org,'fencing','quoted','ZZTEST-SE-20261111-17C7','ZZTEST Scope Checker');
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
  SELECT v.id, v.job, 1, 'frozen', '{}', v.p::text, encode(sha256(convert_to('{}','UTF8')),'hex'), encode(sha256(convert_to(v.p::text,'UTF8')),'hex')
  FROM (VALUES (keep_rev,keep_job,sparse),(old_rev,old_job,matched),(move_rev1,move_job,two)) v(id,job,p);
  PERFORM public.prepare_scope_job_drafts(keep_job,keep_rev,org);
  PERFORM public.prepare_scope_job_drafts(old_job,old_rev,org);
  PERFORM public.prepare_scope_job_drafts(move_job,move_rev1,org);
  PERFORM public.upsert_job_party(keep_job,'nb-1',jsonb_build_object('client_name','ZZTEST Neighbour One',
    'client_email','zztest-neighbour@example.invalid','site_address','1 ZZTEST Street','party_role','neighbour'),'zztest_fence_tool');
  a := public.register_scope_payer_parties(keep_job,keep_rev,org);
  SELECT * INTO nb_row FROM public.job_contacts WHERE job_id=keep_job AND source_party_key='nb-1';
  ASSERT a->>'outcome' = 'registered' AND nb_row.client_email='zztest-neighbour@example.invalid'
    AND nb_row.site_address='1 ZZTEST Street' AND nb_row.share_percentage = 50,
    'a keyed payer keeps the contact the quote leaves blank, and takes its share';
  INSERT INTO public.job_contacts(job_id,contact_label,is_primary,client_name,client_email,site_address,share_percentage) VALUES
    (old_job,'A',true,'ZZTEST Scope Checker',NULL,NULL,50),
    (old_job,'B',false,'ZZTEST Neighbour One','zztest-neighbour@example.invalid','2 ZZTEST Street',50);
  PERFORM public.register_scope_payer_parties(old_job,old_rev,org);
  SELECT * INTO nb_row FROM public.job_contacts WHERE job_id=old_job AND contact_label='B';
  ASSERT nb_row.source_party_key='nb-1' AND nb_row.site_address='2 ZZTEST Street'
    AND nb_row.client_email='zztest-neighbour@example.invalid', 'an adopted older payer keeps the address the quote leaves out';

  -- 9. A payer an earlier registration made that the next quote drops stops
  -- paying: soft-removed, row and receipts kept. A party it never registered
  -- is left alone; a payer named again comes back as the same party.
  PERFORM public.register_scope_payer_parties(move_job,move_rev1,org);
  PERFORM public.upsert_job_party(move_job,'nb-9',jsonb_build_object('client_name','ZZTEST Neighbour Nine',
    'party_role','neighbour'),'zztest_fence_tool');
  SELECT id INTO nb_id FROM public.job_contacts WHERE job_id=move_job AND source_party_key='nb-1';
  SELECT count(*) INTO receipts FROM public.job_party_events WHERE job_contact_id=nb_id;
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES (move_rev2,move_job,2,'frozen','{}',one::text,encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(one::text,'UTF8')),'hex'));
  UPDATE public.scope_revisions SET status='superseded', superseded_by_scope_revision_id=move_rev2, superseded_at=now() WHERE id=move_rev1;
  PERFORM public.prepare_scope_job_drafts(move_job,move_rev2,org);
  a := public.register_scope_payer_parties(move_job,move_rev2,org);
  SELECT * INTO nb_row FROM public.job_contacts WHERE id=nb_id;
  SELECT * INTO owner_row FROM public.job_contacts WHERE job_id=move_job AND source_party_key='primary';
  ASSERT a->>'outcome' = 'single_payer' AND jsonb_array_length(a->'removed') = 1
    AND (a->'removed'->0->>'job_contact_id')::uuid = nb_id, 'the dropped payer is named as removed';
  ASSERT nb_row.status='removed' AND nb_row.removed_at IS NOT NULL AND nb_row.client_name='ZZTEST Neighbour One',
    'the dropped payer is soft-removed, its row kept';
  ASSERT (SELECT count(*) FROM public.job_party_events WHERE job_contact_id=nb_id) = receipts + 1, 'its receipts kept, one added';
  ASSERT owner_row.share_percentage = 100 AND owner_row.quote_value_ex_gst = 1000, 'the owner holds the whole quote';
  ASSERT (SELECT status FROM public.job_contacts WHERE job_id=move_job AND source_party_key='nb-9') = 'active',
    'a party this function never registered is left alone';
  ASSERT (SELECT count(*) FROM public.job_contacts WHERE job_id=move_job AND removed_at IS NULL AND status<>'removed') = 2,
    'only the owner and the untouched party still count';
  INSERT INTO public.scope_revisions(id,job_id,revision_number,status,scope_canonical_text,pricing_canonical_text,scope_hash,pricing_hash)
    VALUES (move_rev3,move_job,3,'frozen','{}',two::text,encode(sha256(convert_to('{}','UTF8')),'hex'),encode(sha256(convert_to(two::text,'UTF8')),'hex'));
  UPDATE public.scope_revisions SET status='superseded', superseded_by_scope_revision_id=move_rev3, superseded_at=now() WHERE id=move_rev2;
  PERFORM public.prepare_scope_job_drafts(move_job,move_rev3,org);
  a := public.register_scope_payer_parties(move_job,move_rev3,org);
  SELECT * INTO nb_row FROM public.job_contacts WHERE id=nb_id;
  ASSERT a->>'outcome' = 'registered' AND nb_row.status='active' AND nb_row.removed_at IS NULL AND nb_row.share_percentage = 50
    AND jsonb_array_length(a->'removed') = 0, 'a payer named again comes back as the same party';
  ASSERT (SELECT count(*) FROM public.job_contacts WHERE job_id=move_job) = 3, 'no duplicate party';

  -- 7. Browser roles cannot call it.
  ASSERT NOT has_function_privilege('authenticated','public.register_scope_payer_parties(uuid,uuid,uuid)','EXECUTE')
     AND NOT has_function_privilege('anon','public.register_scope_payer_parties(uuid,uuid,uuid)','EXECUTE')
     AND has_function_privilege('service_role','public.register_scope_payer_parties(uuid,uuid,uuid)','EXECUTE'), 'service role only';
END $$;
SELECT 'scope payer parties contract passed' AS result;
