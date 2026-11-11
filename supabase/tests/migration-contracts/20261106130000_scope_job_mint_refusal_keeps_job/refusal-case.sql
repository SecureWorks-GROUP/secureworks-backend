-- One run of the refusal cases against whichever bind body is loaded. The
-- caller wraps it in BEGIN / ROLLBACK. Checks use IS DISTINCT FROM so a NULL
-- never passes.

INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-4000-8000-0000000000c2', 'Refusal contract org');
INSERT INTO public.users (id, org_id, name) VALUES
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000c2', 'Refusal contract scoper');

-- 1. The supplied-opportunity branch. A job names opportunity P and has no
-- contact. The completed mint holding P names contact B. A new request for
-- contact A supplies P: refused, and the job still has no contact.
DO $$
DECLARE v jsonb; job uuid; req record;
BEGIN
  INSERT INTO public.jobs (org_id, status, type, job_number, ghl_contact_id, ghl_opportunity_id, site_address)
  VALUES ('00000000-0000-4000-8000-0000000000c2', 'draft', 'patio', 'SWP-REFUSAL-1', NULL, 'oppP', 'Site P')
  RETURNING id INTO job;
  INSERT INTO public.fence_job_mint_requests (request_id, org_id, requested_by, type, intent, identity_key,
    input_fingerprint, state, contact_id, opportunity_id, job_id, mapping_outcome, attempt_count, completed_at)
  VALUES ('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000d2',
    'patio', 'RESOLVED_NO_JOB', 'ghl:contactb', 'fp-801', 'complete', 'contactB', 'oppP', job, 'created', 1, now());

  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000802', '00000000-0000-4000-8000-0000000000c2',
    '00000000-0000-4000-8000-0000000000d2', 'email:a@example.com', 'fp-802', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'a@example.com', '', 'Site A', 'Testville', 'patio');
  IF v->>'decision' IS DISTINCT FROM 'continue' THEN RAISE EXCEPTION 'case 1 reserve: %', v; END IF;
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000802', 'contactA', 'oppP');
  IF v->>'code' IS DISTINCT FROM 'opportunity_mapping_conflict' THEN RAISE EXCEPTION 'case 1 not refused: %', v; END IF;
  IF (SELECT ghl_contact_id FROM public.jobs WHERE id = job) IS NOT NULL THEN
    RAISE EXCEPTION 'refused mint wrote the contact onto the job';
  END IF;
  SELECT state, contact_id, opportunity_id, job_id INTO req
    FROM public.fence_job_mint_requests WHERE request_id = '00000000-0000-4000-8000-000000000802';
  IF req.state IS DISTINCT FROM 'reserved' OR req.contact_id IS NOT NULL OR req.opportunity_id IS NOT NULL OR req.job_id IS NOT NULL THEN
    RAISE EXCEPTION 'case 1 request row moved: % % % %', req.state, req.contact_id, req.opportunity_id, req.job_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fence_job_mint_locks WHERE identity_key = 'ghl:contacta'
    AND owner_request_id = '00000000-0000-4000-8000-000000000802') THEN
    RAISE EXCEPTION 'case 1 refused request kept the contact lock';
  END IF;
END $$;

-- 2. The open-job branch. Contact C has one open job with no opportunity. The
-- request supplies opportunity Q, which an in-flight mint for contact D holds:
-- refused, and the open job still has no opportunity.
DO $$
DECLARE v jsonb; job uuid;
BEGIN
  INSERT INTO public.jobs (org_id, status, type, job_number, ghl_contact_id, ghl_opportunity_id, site_address)
  VALUES ('00000000-0000-4000-8000-0000000000c2', 'draft', 'patio', 'SWP-REFUSAL-2', 'contactC', NULL, 'Site C')
  RETURNING id INTO job;
  INSERT INTO public.fence_job_mint_requests (request_id, org_id, requested_by, type, intent, identity_key,
    input_fingerprint, state, contact_id, opportunity_id, attempt_count, lease_expires_at, lease_holder_request_id)
  VALUES ('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000d2',
    'patio', 'RESOLVED_NO_JOB', 'ghl:contactd', 'fp-901', 'opportunity_created', 'contactD', 'oppQ', 1,
    now() + interval '60 seconds', '00000000-0000-4000-8000-000000000901');

  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000902', '00000000-0000-4000-8000-0000000000c2',
    '00000000-0000-4000-8000-0000000000d2', 'email:c@example.com', 'fp-902', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'c@example.com', '', 'Site C', 'Testville', 'patio');
  IF v->>'decision' IS DISTINCT FROM 'continue' THEN RAISE EXCEPTION 'case 2 reserve: %', v; END IF;
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000902', 'contactC', 'oppQ');
  IF v->>'code' IS DISTINCT FROM 'opportunity_mapping_conflict' THEN RAISE EXCEPTION 'case 2 not refused: %', v; END IF;
  IF (SELECT ghl_opportunity_id FROM public.jobs WHERE id = job) IS NOT NULL THEN
    RAISE EXCEPTION 'refused mint wrote the opportunity onto the open job';
  END IF;
END $$;
