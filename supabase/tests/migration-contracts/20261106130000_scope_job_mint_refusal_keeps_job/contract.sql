-- Contract for 20261106130000_scope_job_mint_refusal_keeps_job. Every fixture
-- write is rolled back.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.bind_fence_job_mint_identity(uuid, text, text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.bind_fence_job_mint_identity(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'bind is callable by clients';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.bind_fence_job_mint_identity(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost bind';
  END IF;
END $$;

-- The current body.
BEGIN;
\ir refusal-case.sql

-- Control: the same contact restarting reuses its open job (the
-- 20261106081500 promise stands). The job's contact is the holder's own.
DO $$
DECLARE v jsonb; job uuid;
BEGIN
  INSERT INTO public.jobs (org_id, status, type, job_number, ghl_contact_id, ghl_opportunity_id, site_address)
  VALUES ('00000000-0000-4000-8000-0000000000c2', 'draft', 'patio', 'SWP-REFUSAL-3', NULL, 'oppR', 'Site R')
  RETURNING id INTO job;
  INSERT INTO public.fence_job_mint_requests (request_id, org_id, requested_by, type, intent, identity_key,
    input_fingerprint, state, contact_id, opportunity_id, job_id, mapping_outcome, attempt_count, completed_at)
  VALUES ('00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000d2',
    'patio', 'RESOLVED_NO_JOB', 'ghl:contactr', 'fp-a01', 'complete', 'contactR', 'oppR', job, 'created', 1, now());
  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000a02', '00000000-0000-4000-8000-0000000000c2',
    '00000000-0000-4000-8000-0000000000d2', 'email:r@example.com', 'fp-a02', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'r@example.com', '', 'Site R', 'Testville', 'patio');
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000a02', 'contactR', 'oppR');
  IF v->>'decision' IS DISTINCT FROM 'complete' OR (v->'canonical'->>'jobId')::uuid IS DISTINCT FROM job THEN
    RAISE EXCEPTION 'control: same contact not reused: %', v;
  END IF;
  IF (SELECT ghl_contact_id FROM public.jobs WHERE id = job) IS DISTINCT FROM 'contactR' THEN
    RAISE EXCEPTION 'control: job contact not filled';
  END IF;
END $$;

ROLLBACK;

-- Parity: the body before 20261106081500 refused these cases with the job
-- untouched too (its later ledger write raised, and the handler rolled back).
BEGIN;
\ir ../../../migrations/20261028031500_scope_job_mint_patio.sql
\ir refusal-case.sql
ROLLBACK;
