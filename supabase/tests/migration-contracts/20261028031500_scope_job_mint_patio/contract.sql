-- Contract for 20261028031500_scope_job_mint_patio: one server mint for
-- fencing and patio. Every fixture write is rolled back.

\set ON_ERROR_STOP on

-- Shape: the two-trade CHECKs, one reserve signature, service role only.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'reserve_fence_job_mint') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one reserve_fence_job_mint';
  END IF;
  IF NOT has_function_privilege('service_role',
      'public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot reserve';
  END IF;
  IF has_function_privilege('authenticated',
      'public.reserve_fence_job_mint(uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, text, text, text, text, text, text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.complete_fence_job_mint(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can call the mint';
  END IF;
END $$;

BEGIN;
INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-4000-8000-0000000000a1', 'Contract org');
INSERT INTO public.users (id, org_id, name) VALUES
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Contract scoper');

CREATE TEMP TABLE r (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;

-- 1. A patio mint: reserve, bind, record the opportunity, complete.
INSERT INTO r VALUES ('patio_reserve', public.reserve_fence_job_mint(
  '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000b1', 'phone:0400000001', 'fp-patio-1', 'RESOLVED_NO_JOB',
  NULL, NULL, '{}', NULL, 'Test', 'Patio', NULL, '0400000001', '1 Contract St', 'Testville', 'patio'));
INSERT INTO r VALUES ('patio_bind', public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000001', 'contactP1', NULL));
INSERT INTO r VALUES ('patio_opp', public.record_fence_job_mint_opportunity('00000000-0000-4000-8000-000000000001', 'oppP1', 'contactP1'));
INSERT INTO r VALUES ('patio_complete', public.complete_fence_job_mint('00000000-0000-4000-8000-000000000001'));

DO $$
DECLARE v jsonb; j record;
BEGIN
  SELECT r.v INTO v FROM r WHERE k = 'patio_reserve';
  IF v->>'decision' <> 'continue' OR (v->>'executor')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'patio reserve: %', v; END IF;
  SELECT r.v INTO v FROM r WHERE k = 'patio_bind';
  IF v->>'state' <> 'contact_resolved' THEN RAISE EXCEPTION 'patio bind: %', v; END IF;
  SELECT r.v INTO v FROM r WHERE k = 'patio_complete';
  IF v->>'decision' <> 'complete' OR v->'canonical'->>'mappingOutcome' <> 'created' THEN RAISE EXCEPTION 'patio complete: %', v; END IF;
  SELECT * INTO j FROM public.jobs WHERE id = (v->'canonical'->>'jobId')::uuid;
  IF j.type <> 'patio' OR j.job_number NOT LIKE 'SWP-%' OR j.status <> 'draft' OR j.ghl_opportunity_id <> 'oppP1' THEN
    RAISE EXCEPTION 'patio job wrong: % % % %', j.type, j.job_number, j.status, j.ghl_opportunity_id;
  END IF;
  IF (SELECT type FROM public.fence_job_mint_requests WHERE request_id = '00000000-0000-4000-8000-000000000001') <> 'patio'
    OR NOT EXISTS (SELECT 1 FROM public.fence_job_mint_locks WHERE type = 'patio' AND identity_key = 'phone:0400000001') THEN
    RAISE EXCEPTION 'patio ledger or lock not typed patio';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_events WHERE job_id = j.id AND event_type = 'job_created'
      AND detail_json->>'source' = 'scope_server_mint') THEN
    RAISE EXCEPTION 'patio job_created event missing';
  END IF;
END $$;

-- 2. The same request id under another trade is a reused key, never a second job.
DO $$
DECLARE v jsonb;
BEGIN
  v := public.reserve_fence_job_mint(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000b1', 'phone:0400000001', 'fp-patio-1', 'RESOLVED_NO_JOB',
    NULL, NULL, '{}', NULL, 'Test', 'Patio', NULL, '0400000001', '1 Contract St', 'Testville', 'fencing');
  IF v->>'code' <> 'idempotency_key_reused' THEN RAISE EXCEPTION 'cross-trade replay: %', v; END IF;
  -- Same trade replays the finished job.
  v := public.reserve_fence_job_mint(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000b1', 'phone:0400000001', 'fp-patio-1', 'RESOLVED_NO_JOB',
    NULL, NULL, '{}', NULL, 'Test', 'Patio', NULL, '0400000001', '1 Contract St', 'Testville', 'patio');
  IF v->>'decision' <> 'complete' THEN RAISE EXCEPTION 'patio replay: %', v; END IF;
  -- An unknown trade is refused before anything is written.
  v := public.reserve_fence_job_mint(
    '00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000b1', 'phone:0400000009', 'fp-x', 'RESOLVED_NO_JOB',
    NULL, NULL, '{}', NULL, 'Test', 'X', NULL, '0400000009', NULL, NULL, 'decking');
  IF v->>'code' <> 'invalid_mint_request' THEN RAISE EXCEPTION 'unknown trade: %', v; END IF;
  IF EXISTS (SELECT 1 FROM public.fence_job_mint_requests WHERE request_id = '00000000-0000-4000-8000-000000000009') THEN
    RAISE EXCEPTION 'unknown trade wrote a ledger row';
  END IF;
END $$;

-- 3. A fencing mint for the same contact is its own trade: it neither reuses
-- nor is blocked by the patio job, and still numbers SWF with the old source.
DO $$
DECLARE v jsonb; j record;
BEGIN
  -- The 16 argument call (no trade) still means fencing.
  v := public.reserve_fence_job_mint(
    '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000b1', 'phone:0400000001', 'fp-fence-1', 'RESOLVED_NO_JOB',
    NULL, NULL, '{}', NULL, 'Test', 'Patio', NULL, '0400000001', '1 Contract St', 'Testville');
  IF v->>'decision' <> 'continue' THEN RAISE EXCEPTION 'fence reserve: %', v; END IF;
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000002', 'contactP1', NULL);
  IF v->>'state' <> 'contact_resolved' THEN RAISE EXCEPTION 'fence bind saw the patio job: %', v; END IF;
  PERFORM public.record_fence_job_mint_opportunity('00000000-0000-4000-8000-000000000002', 'oppF1', 'contactP1');
  v := public.complete_fence_job_mint('00000000-0000-4000-8000-000000000002');
  SELECT * INTO j FROM public.jobs WHERE id = (v->'canonical'->>'jobId')::uuid;
  IF j.type <> 'fencing' OR j.job_number NOT LIKE 'SWF-%' THEN RAISE EXCEPTION 'fence job wrong: % %', j.type, j.job_number; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_events WHERE job_id = j.id AND detail_json->>'source' = 'fence_server_mint') THEN
    RAISE EXCEPTION 'fence source label changed';
  END IF;
END $$;

-- 4. A second patio start for the same contact reuses the open patio job.
DO $$
DECLARE v jsonb;
BEGIN
  v := public.reserve_fence_job_mint(
    '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000b1', 'ghl:contactp1', 'fp-patio-2', 'RESOLVED_NO_JOB',
    'contactP1', NULL, '{}', NULL, 'Test', 'Patio', NULL, '0400000001', NULL, NULL, 'patio');
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000003', 'contactP1', NULL);
  IF v->'canonical'->>'jobNumber' IS NULL AND v->>'state' <> 'opportunity_created' THEN
    RAISE EXCEPTION 'second patio start did not reuse: %', v;
  END IF;
  v := public.complete_fence_job_mint('00000000-0000-4000-8000-000000000003');
  IF v->'canonical'->>'mappingOutcome' <> 'existing_contact_job_reused'
    OR (SELECT count(*) FROM public.jobs WHERE type = 'patio' AND ghl_contact_id = 'contactP1') <> 1 THEN
    RAISE EXCEPTION 'second patio start made another job: %', v;
  END IF;
END $$;
ROLLBACK;
