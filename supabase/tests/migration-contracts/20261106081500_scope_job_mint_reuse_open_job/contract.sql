-- Contract for 20261106081500_scope_job_mint_reuse_open_job. Every fixture
-- write is rolled back. Checks use IS DISTINCT FROM so a NULL never passes.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public._fence_mint_settle_held_opportunity(uuid, text, text, uuid, text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public._fence_mint_settle_held_opportunity(uuid, text, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'settle helper is callable by clients';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.bind_fence_job_mint_identity(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost bind';
  END IF;
END $$;

BEGIN;
INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-4000-8000-0000000000c1', 'Reuse contract org');
INSERT INTO public.users (id, org_id, name) VALUES
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1', 'Reuse contract scoper');

-- Short helpers for this transaction only.
CREATE FUNCTION pg_temp.reserve(p_req uuid, p_key text, p_fp text, p_site text, p_type text DEFAULT 'patio',
  p_intent text DEFAULT 'RESOLVED_NO_JOB', p_expected uuid[] DEFAULT '{}', p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT public.reserve_fence_job_mint(p_req, '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000d1', p_key, p_fp, p_intent, NULL, NULL, p_expected, p_reason,
    'Test', 'Customer', 'shared@example.com', '', p_site, 'Testville', p_type)
$f$;
CREATE FUNCTION pg_temp.mint(p_req uuid, p_key text, p_fp text, p_site text, p_contact text, p_opp text, p_type text DEFAULT 'patio')
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  v := pg_temp.reserve(p_req, p_key, p_fp, p_site, p_type);
  IF v->>'decision' IS DISTINCT FROM 'continue' THEN RAISE EXCEPTION 'mint reserve %: %', p_req, v; END IF;
  v := public.bind_fence_job_mint_identity(p_req, p_contact, NULL);
  IF v->>'state' IS DISTINCT FROM 'contact_resolved' THEN RAISE EXCEPTION 'mint bind %: %', p_req, v; END IF;
  PERFORM public.record_fence_job_mint_opportunity(p_req, p_opp, p_contact);
  v := public.complete_fence_job_mint(p_req);
  IF v->'canonical'->>'mappingOutcome' IS DISTINCT FROM 'created' THEN RAISE EXCEPTION 'mint complete %: %', p_req, v; END IF;
  RETURN v;
END $f$;

CREATE TEMP TABLE r (k text PRIMARY KEY, v jsonb) ON COMMIT DROP;

-- 1. Whole test 2: an email-only test customer already has an open patio job
-- from an earlier start. A new start (new request id, same email, so the same
-- GHL contact, new site) returns that job instead of opportunity_mapping_conflict.
INSERT INTO r VALUES ('first', pg_temp.mint('00000000-0000-4000-8000-000000000101', 'email:shared@example.com', 'fp-101', 'Site 02', 'contactS', 'oppS'));
INSERT INTO r VALUES ('second_reserve', pg_temp.reserve('00000000-0000-4000-8000-000000000154', 'email:shared@example.com', 'fp-154', 'Site 54'));
INSERT INTO r VALUES ('second_bind', public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000154', 'contactS', NULL));

DO $$
DECLARE v jsonb; first_job text; row record;
BEGIN
  SELECT r.v->'canonical'->>'jobId' INTO first_job FROM r WHERE k = 'first';
  SELECT r.v INTO v FROM r WHERE k = 'second_reserve';
  IF v->>'decision' IS DISTINCT FROM 'continue' OR (v->>'executor')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'second start reserve: %', v;
  END IF;
  SELECT r.v INTO v FROM r WHERE k = 'second_bind';
  IF v->>'decision' IS DISTINCT FROM 'complete'
    OR v->'canonical'->>'jobId' IS DISTINCT FROM first_job
    OR v->'canonical'->>'mappingOutcome' IS DISTINCT FROM 'existing_contact_job_reused'
    OR (v->'canonical'->>'requiresLoad')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'second start did not reuse the open patio job: %', v;
  END IF;
  SELECT * INTO row FROM public.fence_job_mint_requests WHERE request_id = '00000000-0000-4000-8000-000000000154';
  IF row.state IS DISTINCT FROM 'joined' OR row.owner_request_id IS DISTINCT FROM '00000000-0000-4000-8000-000000000101'::uuid
    OR row.job_id::text IS DISTINCT FROM first_job THEN
    RAISE EXCEPTION 'second start ledger row: % % %', row.state, row.owner_request_id, row.job_id;
  END IF;
  IF (SELECT count(*) FROM public.jobs WHERE org_id = '00000000-0000-4000-8000-0000000000c1' AND type = 'patio') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'second start made another patio job';
  END IF;

  -- 2. The same request id retried replays the same job, never a conflict.
  v := pg_temp.reserve('00000000-0000-4000-8000-000000000154', 'email:shared@example.com', 'fp-154', 'Site 54');
  IF v->>'decision' IS DISTINCT FROM 'complete' OR v->'canonical'->>'jobId' IS DISTINCT FROM first_job THEN
    RAISE EXCEPTION 'retry of the reused start: %', v;
  END IF;
  v := public.get_fence_job_mint_progress('00000000-0000-4000-8000-000000000154');
  IF v->'canonical'->>'jobId' IS DISTINCT FROM first_job THEN RAISE EXCEPTION 'progress of the reused start: %', v; END IF;

  -- 3. The patio job does not answer for fencing: a fencing start for the same
  -- contact still makes its own job.
  v := pg_temp.mint('00000000-0000-4000-8000-000000000201', 'email:shared@example.com', 'fp-201', 'Site 01', 'contactS', 'oppSF', 'fencing');
  IF v->'canonical'->>'jobNumber' NOT LIKE 'SWF-%' THEN RAISE EXCEPTION 'fencing start: %', v; END IF;
END $$;

-- 4. Failed then retried: the request refused by the old code (state conflict,
-- nothing bound) is judged again when the same request id is retried, and
-- reaches the open job.
DO $$
DECLARE v jsonb; first_job text; stamped text;
BEGIN
  SELECT r.v->'canonical'->>'jobId' INTO first_job FROM r WHERE k = 'first';
  v := pg_temp.reserve('00000000-0000-4000-8000-000000000155', 'email:shared@example.com', 'fp-155', 'Site 55');
  stamped := public.record_fence_job_mint_failure('00000000-0000-4000-8000-000000000155', 'opportunity_mapping_conflict',
    'Opportunity is reserved by another mint request', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1', NULL);
  IF stamped IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'failure stamp: %', stamped; END IF;
  v := public.get_fence_job_mint_progress('00000000-0000-4000-8000-000000000155');
  IF v->>'code' IS DISTINCT FROM 'opportunity_mapping_conflict' THEN RAISE EXCEPTION 'refusal not recorded: %', v; END IF;

  v := pg_temp.reserve('00000000-0000-4000-8000-000000000155', 'email:shared@example.com', 'fp-155', 'Site 55');
  IF v->>'decision' IS DISTINCT FROM 'continue' OR (v->>'executor')::boolean IS NOT TRUE
    OR (v->>'attemptCount')::int IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'refused request was not judged again: %', v;
  END IF;
  IF (SELECT state FROM public.fence_job_mint_requests WHERE request_id = '00000000-0000-4000-8000-000000000155') IS DISTINCT FROM 'reserved' THEN
    RAISE EXCEPTION 'refused request not back to reserved';
  END IF;
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000155', 'contactS', NULL);
  IF v->'canonical'->>'jobId' IS DISTINCT FROM first_job THEN RAISE EXCEPTION 'retried request did not reach the open job: %', v; END IF;
  v := pg_temp.reserve('00000000-0000-4000-8000-000000000155', 'email:shared@example.com', 'fp-155', 'Site 55');
  IF v->'canonical'->>'jobId' IS DISTINCT FROM first_job THEN RAISE EXCEPTION 'second retry: %', v; END IF;

  -- A changed payload under the same request id is still a reused key.
  v := pg_temp.reserve('00000000-0000-4000-8000-000000000155', 'email:shared@example.com', 'fp-other', 'Site 55');
  IF v->>'code' IS DISTINCT FROM 'idempotency_key_reused' THEN RAISE EXCEPTION 'changed payload: %', v; END IF;
END $$;

-- 5. A refusal that already bound an opportunity is never re-judged: retrying
-- it returns the same refusal and writes nothing.
DO $$
DECLARE v jsonb;
BEGIN
  INSERT INTO public.fence_job_mint_requests (request_id, org_id, requested_by, type, intent, identity_key,
    input_fingerprint, state, contact_id, opportunity_id, attempt_count, last_error_code, last_error_message)
  VALUES ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1',
    'patio', 'RESOLVED_NO_JOB', 'email:bound@example.com', 'fp-301', 'conflict', 'contactB', 'oppB', 1,
    'opportunity_contact_conflict', 'Opportunity is already mapped to another contact job');
  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000d1', 'email:bound@example.com', 'fp-301', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'bound@example.com', '', 'Site B', 'Testville', 'patio');
  IF v->>'code' IS DISTINCT FROM 'opportunity_contact_conflict' THEN RAISE EXCEPTION 'bound refusal re-judged: %', v; END IF;
  IF (SELECT state FROM public.fence_job_mint_requests WHERE request_id = '00000000-0000-4000-8000-000000000301') IS DISTINCT FROM 'conflict' THEN
    RAISE EXCEPTION 'bound refusal changed state';
  END IF;
END $$;

-- 6. Abandoned: a mint that resolved its contact and then vanished (lease
-- lapsed) does not block the customer. A new start takes it over and the one
-- job is made once.
DO $$
DECLARE v jsonb; owner uuid;
BEGIN
  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000d1', 'email:gone@example.com', 'fp-401', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'gone@example.com', '', 'Site G', 'Testville', 'patio');
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000401', 'contactG', NULL);
  UPDATE public.fence_job_mint_requests SET lease_expires_at = now() - interval '1 second'
    WHERE request_id = '00000000-0000-4000-8000-000000000401';

  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000d1', 'email:gone@example.com', 'fp-402', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'gone@example.com', '', 'Site G', 'Testville', 'patio');
  owner := (v->>'ownerRequestId')::uuid;
  IF owner IS DISTINCT FROM '00000000-0000-4000-8000-000000000401'::uuid OR (v->>'executor')::boolean IS NOT TRUE
    OR v->>'contactId' IS DISTINCT FROM 'contactG' THEN
    RAISE EXCEPTION 'abandoned mint not taken over: %', v;
  END IF;
  v := public.bind_fence_job_mint_identity(owner, 'contactG', NULL);
  PERFORM public.record_fence_job_mint_opportunity(owner, 'oppG', 'contactG');
  v := public.complete_fence_job_mint(owner);
  IF v->>'decision' IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'takeover complete: %', v; END IF;
  v := public.get_fence_job_mint_progress('00000000-0000-4000-8000-000000000402');
  IF v->>'decision' IS DISTINCT FROM 'complete' THEN RAISE EXCEPTION 'takeover joiner: %', v; END IF;
  IF (SELECT count(*) FROM public.jobs WHERE ghl_contact_id = 'contactG') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'abandoned mint made two jobs';
  END IF;
END $$;

-- 7. An in-flight holder of the open job's opportunity is joined, not refused:
-- the new start waits on it and then replays its job.
DO $$
DECLARE v jsonb; job uuid;
BEGIN
  INSERT INTO public.jobs (org_id, status, type, job_number, ghl_contact_id, ghl_opportunity_id, site_address)
  VALUES ('00000000-0000-4000-8000-0000000000c1', 'draft', 'patio', 'SWP-CONTRACT-7', 'contactH', 'oppH', 'Site H')
  RETURNING id INTO job;
  INSERT INTO public.fence_job_mint_requests (request_id, org_id, requested_by, type, intent, identity_key,
    input_fingerprint, state, contact_id, opportunity_id, job_id, mapping_outcome, attempt_count, lease_expires_at, lease_holder_request_id)
  VALUES ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1',
    'patio', 'RESOLVED_NO_JOB', 'ghl:contacth', 'fp-501', 'opportunity_created', 'contactH', 'oppH', job,
    'existing_contact_job_reused', 1, now() + interval '60 seconds', '00000000-0000-4000-8000-000000000501');

  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000d1', 'email:h@example.com', 'fp-502', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'h@example.com', '', 'Site H2', 'Testville', 'patio');
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000502', 'contactH', NULL);
  IF v->>'decision' IS DISTINCT FROM 'continue' OR v->>'ownerRequestId' IS DISTINCT FROM '00000000-0000-4000-8000-000000000501'
    OR (v->>'joined')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'in-flight holder not joined: %', v;
  END IF;
  v := public.complete_fence_job_mint('00000000-0000-4000-8000-000000000501');
  v := public.get_fence_job_mint_progress('00000000-0000-4000-8000-000000000502');
  IF v->>'decision' IS DISTINCT FROM 'complete' OR (v->'canonical'->>'jobId')::uuid IS DISTINCT FROM job THEN
    RAISE EXCEPTION 'joiner of in-flight holder: %', v;
  END IF;
END $$;

-- 8. A holder of the same opportunity for another trade is a real conflict.
DO $$
DECLARE v jsonb;
BEGIN
  INSERT INTO public.jobs (org_id, status, type, job_number, ghl_contact_id, ghl_opportunity_id, site_address)
  VALUES ('00000000-0000-4000-8000-0000000000c1', 'draft', 'patio', 'SWP-CONTRACT-8', 'contactX', 'oppX', 'Site X');
  INSERT INTO public.fence_job_mint_requests (request_id, org_id, requested_by, type, intent, identity_key,
    input_fingerprint, state, contact_id, opportunity_id, attempt_count)
  VALUES ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1',
    'fencing', 'RESOLVED_NO_JOB', 'ghl:contactx', 'fp-601', 'opportunity_created', 'contactX', 'oppX', 1);
  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000d1', 'email:x@example.com', 'fp-602', 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Test', 'Customer', 'x@example.com', '', 'Site X', 'Testville', 'patio');
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000602', 'contactX', NULL);
  IF v->>'code' IS DISTINCT FROM 'opportunity_mapping_conflict' THEN RAISE EXCEPTION 'cross-trade holder: %', v; END IF;
END $$;

-- 9. DELIBERATE_REPEAT racing another repeat with the same evidence replays the
-- job the other one made, instead of colliding on its opportunity.
DO $$
DECLARE v jsonb; existing uuid; made jsonb;
BEGIN
  SELECT (r.v->'canonical'->>'jobId')::uuid INTO existing FROM r WHERE k = 'first';
  v := pg_temp.reserve('00000000-0000-4000-8000-000000000701', 'email:shared@example.com', 'fp-701', 'Site 57', 'patio',
    'DELIBERATE_REPEAT', ARRAY[existing], 'New site');
  v := pg_temp.reserve('00000000-0000-4000-8000-000000000702', 'email:shared@example.com', 'fp-702', 'Site 57', 'patio',
    'DELIBERATE_REPEAT', ARRAY[existing], 'New site');
  -- 701 owns the identity lock while in flight, so 702 joins it at reserve.
  IF v->>'ownerRequestId' IS DISTINCT FROM '00000000-0000-4000-8000-000000000701' THEN RAISE EXCEPTION 'repeat join: %', v; END IF;
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000701', 'contactS', NULL);
  IF v->>'state' IS DISTINCT FROM 'contact_resolved' THEN RAISE EXCEPTION 'repeat bind: %', v; END IF;
  PERFORM public.record_fence_job_mint_opportunity('00000000-0000-4000-8000-000000000701', 'oppS2', 'contactS');
  made := public.complete_fence_job_mint('00000000-0000-4000-8000-000000000701');
  IF made->'canonical'->>'mappingOutcome' IS DISTINCT FROM 'deliberate_repeat_created' THEN RAISE EXCEPTION 'repeat made: %', made; END IF;

  -- A third repeat that read the same evidence before 701 finished arrives
  -- under its own identity key and reaches bind with one job added.
  v := public.reserve_fence_job_mint('00000000-0000-4000-8000-000000000703', '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000d1', 'ghl:contacts', 'fp-703', 'DELIBERATE_REPEAT', 'contactS', NULL, ARRAY[existing], 'New site',
    'Test', 'Customer', 'shared@example.com', '', 'Site 57', 'Testville', 'patio');
  v := public.bind_fence_job_mint_identity('00000000-0000-4000-8000-000000000703', 'contactS', NULL);
  IF v->>'decision' IS DISTINCT FROM 'complete' OR v->'canonical'->>'jobId' IS DISTINCT FROM made->'canonical'->>'jobId'
    OR v->'canonical'->>'mappingOutcome' IS DISTINCT FROM 'concurrent_request_reused' THEN
    RAISE EXCEPTION 'racing repeat did not replay: %', v;
  END IF;
  IF (SELECT count(*) FROM public.jobs WHERE ghl_contact_id = 'contactS' AND type = 'patio') IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'racing repeat made a third job';
  END IF;
END $$;
ROLLBACK;
