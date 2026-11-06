-- One scoper's start, step by step, each step its own transaction as the edge
-- command runs it. :req is this session's request id, :key its identity key
-- (the two sessions use different keys, email and phone, so they only meet at
-- the contact lock), :opp the opportunity GHL would give this session, and
-- :delay how long this session waits before it starts.
\set ON_ERROR_STOP on
SELECT set_config('mint.req', :'req', false), set_config('mint.key', :'key', false), set_config('mint.opp', :'opp', false),
  set_config('mint.delay', :'delay', false) \gset
DO $$
DECLARE
  v jsonb;
  me uuid := current_setting('mint.req')::uuid;
  owner uuid;
  i integer;
BEGIN
  PERFORM pg_sleep(current_setting('mint.delay')::double precision);
  v := public.reserve_fence_job_mint(me, '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000f1',
    current_setting('mint.key'), 'fp-' || me::text, 'RESOLVED_NO_JOB', NULL, NULL, '{}', NULL,
    'Race', 'Customer', 'race@example.com', '0400000077', 'Race Site', 'Testville', 'patio');
  COMMIT;
  IF (v->>'executor')::boolean THEN
    owner := (v->>'ownerRequestId')::uuid;
    v := public.bind_fence_job_mint_identity(owner, 'contactRace', NULL);
    COMMIT;
    IF v->>'decision' = 'continue' AND (v->>'ownerRequestId')::uuid = owner AND (v->>'joined')::boolean IS NOT TRUE THEN
      -- The GHL opportunity create takes a while: let the other session arrive.
      PERFORM pg_sleep(0.6);
      v := public.record_fence_job_mint_opportunity(owner, current_setting('mint.opp'), 'contactRace');
      COMMIT;
      v := public.complete_fence_job_mint(owner);
      COMMIT;
    END IF;
  END IF;
  FOR i IN 1..100 LOOP
    v := public.get_fence_job_mint_progress(me);
    COMMIT;
    EXIT WHEN v->>'decision' IN ('complete', 'conflict');
    PERFORM pg_sleep(0.1);
  END LOOP;
  RAISE NOTICE 'RESULT decision=% job=%', v->>'decision', v->'canonical'->>'jobId';
END $$;
