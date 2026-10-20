-- Contract for 20261020165000_context_job_reconciliation (CTX-N1). Proves, against the real
-- stacked schema and the live ladder triggers: a candidate email shows on every candidate job
-- with the other jobs named; a staff split shows it certain on each job; the per-job door lists
-- defect rows the daily list leaves out, with the hash the writer accepts and the queue's cause;
-- copies and decided rows leave; no browser role can call either function. Every fixture write
-- is rolled back.
\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_function_privilege('authenticated', 'public.context_job_mail(uuid,int,text[])', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_recon_job_items(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'job recon contract: a browser role holds a grant';
  END IF;
END $$;

BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, ghl_contact_id, created_at) VALUES
  ('7d000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-97101', 'jobrecon-1', '2026-09-01'),
  ('7d000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-97102', 'jobrecon-2', '2026-09-01');
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('7d100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Contract staff', 'ops_manager');
INSERT INTO public.business_events (id, channel, direction, occurred_at, payload, event_type, source) VALUES
  ('7d200000-0000-0000-0000-000000000001', 'email', 'inbound', '2026-10-08 09:10Z',
   '{"from":"orders@supplier.example","subject":"Material Order Ref SWP-97101 & SWP-97102","body":"Delivery   moved\nto Friday"}',
   'email.inbound', 'jobrecon-contract'),
  ('7d200000-0000-0000-0000-000000000002', 'email', 'inbound', '2026-10-07 09:10Z',
   '{"from":"orders@supplier.example","subject":"Material Order Ref SWP-97101","body":"Order confirmed"}',
   'email.inbound', 'jobrecon-contract'),
  ('7d200000-0000-0000-0000-000000000003', 'email', 'inbound', '2026-10-08 09:10Z',
   '{"from":"orders@supplier.example","subject":"Material Order Ref SWP-97101 & SWP-97102","body":"Delivery moved to Friday"}',
   'email.inbound', 'jobrecon-contract');
-- The split case as the ladder leaves it: no identity, two candidates. One placed row. One copy.
UPDATE public.business_events SET job_id = NULL, contact_id = NULL, attribution_status = 'unplaced',
  candidate_job_ids = ARRAY['7d000000-0000-0000-0000-00000000000a', '7d000000-0000-0000-0000-00000000000b']::uuid[]
WHERE id IN ('7d200000-0000-0000-0000-000000000001', '7d200000-0000-0000-0000-000000000003');
UPDATE public.business_events SET job_id = '7d000000-0000-0000-0000-00000000000a', attribution_status = 'single_open',
  candidate_job_ids = NULL WHERE id = '7d200000-0000-0000-0000-000000000002';
UPDATE public.business_events SET metadata = coalesce(metadata, '{}'::jsonb) || '{"duplicate_of":"7d200000-0000-0000-0000-000000000001"}'
WHERE id = '7d200000-0000-0000-0000-000000000003';

DO $$
DECLARE a uuid := '7d000000-0000-0000-0000-00000000000a'; b uuid := '7d000000-0000-0000-0000-00000000000b';
  ev uuid := '7d200000-0000-0000-0000-000000000001'; placed uuid := '7d200000-0000-0000-0000-000000000002';
  copy uuid := '7d200000-0000-0000-0000-000000000003'; staff uuid := '7d100000-0000-0000-0000-000000000001';
  it record; h text;
BEGIN
  -- 1. Before a decision: candidate on both jobs, each naming the other; the placed row only on A.
  IF NOT EXISTS (SELECT 1 FROM public.context_job_mail(a) m WHERE m.event_id = ev AND m.placement = 'candidate'
                 AND m.by = 'ladder' AND m.other_jobs @> jsonb_build_array(jsonb_build_object('job_number', 'SWP-97102', 'placement', 'candidate'))) THEN
    RAISE EXCEPTION 'job recon contract: candidate row missing on job A';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_job_mail(b) m WHERE m.event_id = ev AND m.placement = 'candidate') THEN
    RAISE EXCEPTION 'job recon contract: candidate row missing on job B';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_job_mail(a) m WHERE m.event_id = placed AND m.placement = 'certain' AND m.other_jobs = '[]'::jsonb)
     OR EXISTS (SELECT 1 FROM public.context_job_mail(b) m WHERE m.event_id = placed) THEN
    RAISE EXCEPTION 'job recon contract: placed row on the wrong jobs';
  END IF;
  IF EXISTS (SELECT 1 FROM public.context_job_mail(a) m WHERE m.event_id = copy)
     OR EXISTS (SELECT 1 FROM public.context_recon_job_items(a) i WHERE i.event_id = copy) THEN
    RAISE EXCEPTION 'job recon contract: a duplicate_of copy is shown';
  END IF;
  -- Newest first, the preview squeezes whitespace, the limit holds, and the role filter applies.
  IF (SELECT array_agg(m.event_id) FROM public.context_job_mail(a) m) IS DISTINCT FROM ARRAY[ev, placed]
     OR (SELECT count(*) FROM public.context_job_mail(a, 1)) <> 1
     OR EXISTS (SELECT 1 FROM public.context_job_mail(a, 100, ARRAY['no_such_role']))
     OR (SELECT m.preview FROM public.context_job_mail(a) m WHERE m.event_id = ev) IS DISTINCT FROM 'Delivery moved to Friday'
     OR (SELECT m.from_address FROM public.context_job_mail(a) m WHERE m.event_id = ev) IS DISTINCT FROM 'orders@supplier.example' THEN
    RAISE EXCEPTION 'job recon contract: mail order, preview, limit or role filter wrong';
  END IF;

  -- 2. The per-job door lists the defect row the daily list leaves out, with the queue's cause,
  --    the writer's hash and both offered jobs; the placed row is not queued.
  SELECT * INTO it FROM public.context_recon_job_items(b) i WHERE i.event_id = ev;
  IF it.event_id IS NULL OR it.cause <> 'defect:no_identity'
     OR it.shown_hash IS DISTINCT FROM public.context_recon_evidence_hash(ev)
     OR it.offered <> jsonb_build_array(jsonb_build_object('job_id', a, 'job_number', 'SWP-97101'),
                                       jsonb_build_object('job_id', b, 'job_number', 'SWP-97102')) THEN
    RAISE EXCEPTION 'job recon contract: per-job item wrong';
  END IF;
  IF it.cause IS DISTINCT FROM (SELECT q.cause FROM public.context_recon_queue('2026-10-20 05:00Z') q WHERE q.event_id = ev) THEN
    RAISE EXCEPTION 'job recon contract: per-job cause differs from the queue';
  END IF;
  IF EXISTS (SELECT 1 FROM public.context_recon_job_items(a) i WHERE i.event_id = placed) THEN
    RAISE EXCEPTION 'job recon contract: a placed row is listed as queued';
  END IF;

  -- 3. A staff split with the shown hash puts the row certain, by a person, on both jobs, and it
  --    leaves the per-job door.
  h := it.shown_hash;
  PERFORM public.context_recon_record_decision(ev, h, 'split', ARRAY[a, b], 'defect:no_identity', staff);
  IF NOT EXISTS (SELECT 1 FROM public.context_job_mail(a) m WHERE m.event_id = ev AND m.placement = 'certain' AND m.by = 'person'
                 AND m.other_jobs = jsonb_build_array(jsonb_build_object('job_id', b, 'job_number', 'SWP-97102', 'placement', 'certain')))
     OR NOT EXISTS (SELECT 1 FROM public.context_job_mail(b) m WHERE m.event_id = ev AND m.placement = 'certain' AND m.by = 'person') THEN
    RAISE EXCEPTION 'job recon contract: split row not certain on both jobs';
  END IF;
  IF EXISTS (SELECT 1 FROM public.context_recon_job_items(a) i WHERE i.event_id = ev)
     OR EXISTS (SELECT 1 FROM public.context_recon_job_items(b) i WHERE i.event_id = ev) THEN
    RAISE EXCEPTION 'job recon contract: decided row still listed';
  END IF;
END $$;
ROLLBACK;
