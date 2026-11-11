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
  a jsonb; b jsonb; refused boolean; n int;
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

  -- 7. Browser roles cannot call it.
  ASSERT NOT has_function_privilege('authenticated','public.register_scope_payer_parties(uuid,uuid,uuid)','EXECUTE')
     AND NOT has_function_privilege('anon','public.register_scope_payer_parties(uuid,uuid,uuid)','EXECUTE')
     AND has_function_privilege('service_role','public.register_scope_payer_parties(uuid,uuid,uuid)','EXECUTE'), 'service role only';
END $$;
SELECT 'scope payer parties contract passed' AS result;
