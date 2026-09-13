-- The earlier Dispatch projection contract installs its production-shaped
-- source function before its own transaction. Rebind it for this fixture's
-- explicit revision table so the completion contract stays portable and never
-- reads unrelated provider tables.
CREATE OR REPLACE FUNCTION public.dispatch_source_version(p_org uuid, p_job uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE source_revision text;
BEGIN
  SELECT revision INTO source_revision
    FROM public.dispatch_refresh_test_sources
   WHERE org_id=p_org AND job_id=p_job;
  IF source_revision = 'error' THEN RAISE EXCEPTION 'fixture_source_error'; END IF;
  RETURN source_revision;
END $$;

BEGIN;
CREATE FUNCTION pg_temp.assert_refresh_completion(ok boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END $$;

DO $$
DECLARE
  org_a constant uuid := '00000000-0000-0000-0000-000000000001';
  org_b constant uuid := '00000000-0000-0000-0000-000000000002';
  job_a constant uuid := '28000000-0000-4000-8000-000000000001';
  job_capture constant uuid := '28000000-0000-4000-8000-000000000002';
  job_changed constant uuid := '28000000-0000-4000-8000-000000000003';
  job_missing constant uuid := '28000000-0000-4000-8000-000000000004';
  job_error constant uuid := '28000000-0000-4000-8000-000000000005';
  job_mutated constant uuid := '28000000-0000-4000-8000-000000000006';
  request_a constant uuid := '28000000-0000-4000-8000-000000000101';
  request_capture constant uuid := '28000000-0000-4000-8000-000000000102';
  request_changed constant uuid := '28000000-0000-4000-8000-000000000103';
  request_mutated constant uuid := '28000000-0000-4000-8000-000000000104';
  started jsonb;
  claimed jsonb;
  receipt jsonb;
  finished jsonb;
  readback jsonb;
  scope_a jsonb;
  wrong_scope jsonb;
  output_a jsonb;
  observed text;
  started_a jsonb;
  claimed_a jsonb;
  observed_a text;
BEGIN
  INSERT INTO public.jobs(id,org_id,status,type,job_number)
  VALUES
    (job_a,org_a,'new','patio','REFRESH-280-1'),
    (job_capture,org_a,'new','patio','REFRESH-280-2'),
    (job_changed,org_a,'new','patio','REFRESH-280-3'),
    (job_missing,org_a,'new','patio','REFRESH-280-4'),
    (job_error,org_a,'new','patio','REFRESH-280-5'),
    (job_mutated,org_a,'new','patio','REFRESH-280-6');
  INSERT INTO public.dispatch_refresh_test_sources(org_id,job_id,revision)
  VALUES
    (org_a,job_a,'source-a1'),
    (org_a,job_capture,'source-capture-before'),
    (org_a,job_changed,'source-change-1'),
    (org_a,job_error,'error'),
    (org_a,job_mutated,'source-mutation-1');

  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.register_workflow_refresh_driver(
      'debt','debt-collection','debt_refresh/v1','contract-280','registered'
    );
    RAISE EXCEPTION 'unsupported debt validator unexpectedly registered';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_validator_unavailable%',
      'missing domain validator must remain unavailable'
    );
  END;
  started := public.start_workflow_refresh(
    'debt',jsonb_build_object('week_start','2026-09-13'),'fixture-ui',org_a
  );
  PERFORM pg_temp.assert_refresh_completion(
    started->>'outcome'='unavailable',
    'unsupported domain must not queue Refresh work'
  );

  PERFORM public.register_workflow_refresh_driver(
    'dispatch','operations','dispatch_refresh/v1','contract-280','registered'
  );
  PERFORM pg_temp.assert_refresh_completion(
    NOT has_function_privilege('anon',
      'public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)',
      'EXECUTE'),
    'receipt writer must remain service-only'
  );
  PERFORM pg_temp.assert_refresh_completion(
    has_function_privilege('service_role',
      'public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)',
      'EXECUTE'),
    'receipt writer service grant missing'
  );
  PERFORM pg_temp.assert_refresh_completion(
    NOT has_table_privilege('service_role','public.workflow_refresh_receipts','SELECT'),
    'receipt table must not be directly readable'
  );

  -- A real source revision does not make a declaration-only finish valid.
  started_a := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_a::text),'fixture-ui',org_a
  );
  claimed_a := public.claim_workflow_refresh((started_a->>'id')::uuid,'dispatch',NULL,NULL);
  observed_a := claimed_a->>'expected_source_revision';
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started_a->>'id')::uuid,'completed',
      jsonb_build_object('ok','true','declared_output','dispatch_refresh/v1'),
      now(),(claimed_a->>'lease_token')::uuid,'dispatch',
      (claimed_a->>'lease_generation')::integer,observed_a
    );
    RAISE EXCEPTION 'declaration-only finish unexpectedly completed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_driver_output_missing%',
      'declaration-only finish must require a receipt'
    );
  END;
  PERFORM pg_temp.assert_refresh_completion(
    (SELECT status='running' FROM public.workflow_refresh_runs WHERE id=(started_a->>'id')::uuid),
    'rejected finish must leave the run running'
  );

  -- Valid output is persisted, bound to scope/lease/generation/source, and
  -- then read back through the run without exposing the lease token.
  scope_a := jsonb_build_object('job_id',job_a::text,'org_id',org_a::text);
  output_a := jsonb_build_object(
    'ok',true,
    'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed_a,
    'work',jsonb_build_object('jobs_read',1,'source_cutoff','2026-09-13T00:00:00Z'),
    'output_ref',jsonb_build_object(
      'table','dispatch_commands','command','assess','request_id',request_a::text
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_a,0,request_a,'hash-a','operations','assess',observed_a,
    jsonb_build_object('assessment',jsonb_build_object('source_version',observed_a))
  );
  receipt := public.record_workflow_refresh_receipt(
    (started_a->>'id')::uuid,'dispatch',(claimed_a->>'lease_token')::uuid,
    (claimed_a->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,
    output_a,observed_a
  );
  PERFORM pg_temp.assert_refresh_completion(receipt->>'outcome'='persisted','receipt persistence');
  receipt := public.record_workflow_refresh_receipt(
    (started_a->>'id')::uuid,'dispatch',(claimed_a->>'lease_token')::uuid,
    (claimed_a->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,
    output_a,observed_a
  );
  PERFORM pg_temp.assert_refresh_completion(receipt->>'outcome'='idempotent','receipt replay');
  BEGIN
    PERFORM public.record_workflow_refresh_receipt(
      (started_a->>'id')::uuid,'dispatch',(claimed_a->>'lease_token')::uuid,
      (claimed_a->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,
      jsonb_set(output_a,'{work,jobs_read}','2'::jsonb),observed_a
    );
    RAISE EXCEPTION 'different receipt unexpectedly replayed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_receipt_conflict%',
      'different receipt must conflict'
    );
  END;
  finished := public.finish_workflow_refresh(
    (started_a->>'id')::uuid,'completed',jsonb_build_object('caller_claim','ignored'),now(),
    (claimed_a->>'lease_token')::uuid,'dispatch',(claimed_a->>'lease_generation')::integer,observed_a
  );
  PERFORM pg_temp.assert_refresh_completion(finished->>'status'='completed','verified finish');
  readback := public.workflow_refresh_readback((started_a->>'id')::uuid,org_a);
  PERFORM pg_temp.assert_refresh_completion(
    readback->>'status'='completed'
      AND readback->'result'->>'receipt_id'=receipt->>'receipt_id'
      AND NOT readback ? 'lease_token',
    'completed readback must expose receipt output without lease token'
  );

  -- Missing source and source errors remain unavailable at claim; neither is
  -- converted into a successful NULL comparison.
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_missing::text),'fixture-ui',org_a
  );
  BEGIN
    PERFORM public.claim_workflow_refresh((started->>'id')::uuid,'dispatch',NULL,NULL);
    RAISE EXCEPTION 'missing source unexpectedly claimed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_source_unavailable%',
      'missing source must be explicitly unavailable'
    );
  END;
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_error::text),'fixture-ui',org_a
  );
  BEGIN
    PERFORM public.claim_workflow_refresh((started->>'id')::uuid,'dispatch',NULL,NULL);
    RAISE EXCEPTION 'source error unexpectedly claimed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%fixture_source_error%',
      'source exception must remain an error'
    );
  END;

  -- A source update during legitimate capture may differ from the pre-work
  -- snapshot. The receipt/finish pair validates the post-assessment revision.
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_capture::text),'fixture-ui-3',org_a
  );
  claimed := public.claim_workflow_refresh((started->>'id')::uuid,'dispatch',NULL,NULL);
  UPDATE public.dispatch_refresh_test_sources SET revision='source-capture-after'
   WHERE org_id=org_a AND job_id=job_capture;
  scope_a := jsonb_build_object('job_id',job_capture::text,'org_id',org_a::text);
  observed := 'source-capture-after';
  output_a := jsonb_build_object(
    'ok',true,'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed,
    'work',jsonb_build_object('jobs_read',1,'source_cutoff','2026-09-13T00:01:00Z'),
    'output_ref',jsonb_build_object(
      'table','dispatch_commands','command','assess','request_id',request_capture::text
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_capture,0,request_capture,'hash-capture','operations','assess',observed,
    jsonb_build_object('assessment',jsonb_build_object('source_version',observed))
  );
  PERFORM public.record_workflow_refresh_receipt(
    (started->>'id')::uuid,'dispatch',(claimed->>'lease_token')::uuid,
    (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
  );
  finished := public.finish_workflow_refresh(
    (started->>'id')::uuid,'completed','{}',now(),
    (claimed->>'lease_token')::uuid,'dispatch',(claimed->>'lease_generation')::integer,observed
  );
  PERFORM pg_temp.assert_refresh_completion(
    finished->>'status'='completed','legitimate capture source update must complete'
  );

  -- A source update after assessment invalidates completion as partial.
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_changed::text),'fixture-ui-4',org_a
  );
  claimed := public.claim_workflow_refresh((started->>'id')::uuid,'dispatch',NULL,NULL);
  observed := claimed->>'expected_source_revision';
  scope_a := jsonb_build_object('job_id',job_changed::text,'org_id',org_a::text);
  output_a := jsonb_build_object(
    'ok',true,'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed,
    'work',jsonb_build_object('jobs_read',1,'source_cutoff','2026-09-13T00:02:00Z'),
    'output_ref',jsonb_build_object(
      'table','dispatch_commands','command','assess','request_id',request_changed::text
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_changed,0,request_changed,'hash-changed','operations','assess',observed,
    jsonb_build_object('assessment',jsonb_build_object('source_version',observed))
  );
  PERFORM public.record_workflow_refresh_receipt(
    (started->>'id')::uuid,'dispatch',(claimed->>'lease_token')::uuid,
    (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
  );
  UPDATE public.dispatch_refresh_test_sources SET revision='source-change-2'
   WHERE org_id=org_a AND job_id=job_changed;
  finished := public.finish_workflow_refresh(
    (started->>'id')::uuid,'completed','{}',now(),
    (claimed->>'lease_token')::uuid,'dispatch',(claimed->>'lease_generation')::integer,observed
  );
  PERFORM pg_temp.assert_refresh_completion(
    finished->>'status'='partial','outside source update must hold as partial'
  );

  -- Receipt evidence also covers the persisted Dispatch output itself. A
  -- plan or command result changed after receipt persistence cannot complete;
  -- the run remains running for a fresh assessment.
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_mutated::text),'fixture-ui-4b',org_a
  );
  claimed := public.claim_workflow_refresh((started->>'id')::uuid,'dispatch',NULL,NULL);
  observed := claimed->>'expected_source_revision';
  scope_a := jsonb_build_object('job_id',job_mutated::text,'org_id',org_a::text);
  output_a := jsonb_build_object(
    'ok',true,'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed,
    'work',jsonb_build_object('jobs_read',1,'source_cutoff','2026-09-13T00:02:30Z'),
    'output_ref',jsonb_build_object(
      'table','dispatch_commands','command','assess','request_id',request_mutated::text
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_mutated,0,request_mutated,'hash-mutated','operations','assess',observed,
    jsonb_build_object('assessment',jsonb_build_object('source_version',observed))
  );
  PERFORM public.record_workflow_refresh_receipt(
    (started->>'id')::uuid,'dispatch',(claimed->>'lease_token')::uuid,
    (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
  );
  UPDATE public.dispatch_plans
     SET state=jsonb_build_object('assessment',jsonb_build_object('source_version','forged'))
   WHERE org_id=org_a AND job_id=job_mutated;
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started->>'id')::uuid,'completed','{}',now(),
      (claimed->>'lease_token')::uuid,'dispatch',(claimed->>'lease_generation')::integer,observed
    );
    RAISE EXCEPTION 'changed Dispatch plan unexpectedly completed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_driver_output_invalid%',
      'changed Dispatch plan must invalidate the receipt'
    );
  END;
  UPDATE public.dispatch_plans
     SET state=(SELECT result->'state' FROM public.dispatch_commands
                 WHERE org_id=org_a AND request_id=request_mutated)
   WHERE org_id=org_a AND job_id=job_mutated;
  UPDATE public.dispatch_commands
     SET result=jsonb_set(result,'{version}','999'::jsonb)
   WHERE org_id=org_a AND request_id=request_mutated;
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started->>'id')::uuid,'completed','{}',now(),
      (claimed->>'lease_token')::uuid,'dispatch',(claimed->>'lease_generation')::integer,observed
    );
    RAISE EXCEPTION 'changed Dispatch output unexpectedly completed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_driver_output_invalid%',
      'changed Dispatch output must invalidate the receipt'
    );
  END;

  -- Wrong scope, stale token/generation and invalid output are all refused
  -- before a receipt can be persisted.
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_a::text),'fixture-ui-5',org_a
  );
  claimed := public.claim_workflow_refresh((started->>'id')::uuid,'dispatch',NULL,NULL);
  observed := claimed->>'expected_source_revision';
  scope_a := jsonb_build_object('job_id',job_a::text,'org_id',org_a::text);
  wrong_scope := jsonb_build_object('job_id',job_changed::text,'org_id',org_a::text);
  output_a := jsonb_build_object(
    'ok',true,'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed,
    'work',jsonb_build_object('jobs_read',1,'source_cutoff','2026-09-13T00:03:00Z')
  );
  BEGIN
    PERFORM public.record_workflow_refresh_receipt(
      (started->>'id')::uuid,'dispatch',(claimed->>'lease_token')::uuid,
      (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',wrong_scope,output_a,observed
    );
    RAISE EXCEPTION 'wrong scope unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_receipt_scope_mismatch%','wrong scope refusal'
    );
  END;
  BEGIN
    PERFORM public.record_workflow_refresh_receipt(
      (started->>'id')::uuid,'dispatch',gen_random_uuid(),
      (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
    );
    RAISE EXCEPTION 'stale token unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(SQLERRM LIKE '%workflow_refresh_lease_mismatch%','stale token refusal');
  END;
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started->>'id')::uuid,'completed','{}',now(),
      (claimed->>'lease_token')::uuid,'dispatch',(claimed->>'lease_generation')::integer + 1,observed
    );
    RAISE EXCEPTION 'stale generation unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(SQLERRM LIKE '%workflow_refresh_lease_mismatch%','stale generation refusal');
  END;
  BEGIN
    PERFORM public.record_workflow_refresh_receipt(
      (started->>'id')::uuid,'dispatch',(claimed->>'lease_token')::uuid,
      (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,
      jsonb_build_object(
        'ok',true,'declared_output','dispatch_refresh/v1',
        'observed_source_revision',observed,
        'work',jsonb_build_object('jobs_read',0,'source_cutoff','2026-09-13T00:03:00Z'),
        'output_ref',jsonb_build_object(
          'table','dispatch_commands','command','assess','request_id',request_a::text
        )
      ),observed
    );
    RAISE EXCEPTION 'no-work output unexpectedly accepted';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(SQLERRM LIKE '%workflow_refresh_driver_output_invalid%','no-work output refusal');
  END;
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started->>'id')::uuid,'completed','{}',now(),
      (claimed->>'lease_token')::uuid,'dispatch',(claimed->>'lease_generation')::integer,observed
    );
    RAISE EXCEPTION 'finish without valid receipt unexpectedly completed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(SQLERRM LIKE '%workflow_refresh_driver_output_missing%','validator failure cannot complete');
  END;

  -- Only org A can read org A's run.
  BEGIN
    PERFORM public.workflow_refresh_readback((started->>'id')::uuid,org_b);
    RAISE EXCEPTION 'wrong-org readback unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(SQLERRM LIKE '%workflow_refresh_org_mismatch%','wrong-org readback refusal');
  END;

  RESET ROLE;
  RAISE NOTICE 'Refresh completion receipt contracts: declaration shield, source errors, receipt persistence/idempotency, scope/lease/generation, capture revision and finish-time invalidation passed';
END $$;
ROLLBACK;

BEGIN;
CREATE FUNCTION pg_temp.assert_refresh_queue(ok boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END $$;

DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-000000000001';
  job_good constant uuid := '28000000-0000-4000-8000-000000000201';
  job_missing constant uuid := '28000000-0000-4000-8000-000000000202';
  job_error constant uuid := '28000000-0000-4000-8000-000000000203';
  unsupported jsonb;
  started jsonb;
  joined jsonb;
  consumed jsonb;
  readback jsonb;
  rejected record;
  failures integer := 0;
BEGIN
  INSERT INTO public.jobs(id,org_id,status,type,job_number) VALUES
    (job_good,org,'new','patio','REFRESH-QUEUE-GOOD'),
    (job_missing,org,'new','patio','REFRESH-QUEUE-MISSING'),
    (job_error,org,'new','patio','REFRESH-QUEUE-ERROR');
  INSERT INTO public.dispatch_refresh_test_sources(org_id,job_id,revision) VALUES
    (org,job_good,'source-queue-good'),(org,job_error,'error');

  SET LOCAL ROLE service_role;
  started := public.start_workflow_refresh('dispatch','{}','queue-fixture',org);
  PERFORM pg_temp.assert_refresh_queue(
    started->>'outcome'='unavailable', 'unregistered Dispatch must remain unavailable'
  );
  PERFORM public.register_workflow_refresh_driver(
    'dispatch','operations','dispatch_refresh/v1','queue-fixture','registered'
  );
  FOR unsupported IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    '{}'::jsonb,jsonb_build_object('week_start','2026-09-13'),
    jsonb_build_object('org_id',org),jsonb_build_object('job_id',NULL),
    jsonb_build_object('job_id',''),jsonb_build_object('job_id','invalid')
  )) LOOP
    BEGIN
      PERFORM public.start_workflow_refresh('dispatch',unsupported,'queue-fixture',org);
      RAISE EXCEPTION 'unsupported Dispatch scope unexpectedly queued';
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_temp.assert_refresh_queue(
        SQLERRM='workflow_refresh_scope_missing', 'Dispatch start must require an existing scoped job'
      );
    END;
  END LOOP;
  PERFORM pg_temp.assert_refresh_queue(
    NOT EXISTS (SELECT 1 FROM public.workflow_refresh_runs WHERE requested_by='queue-fixture'),
    'unsupported scopes must not enqueue runs'
  );

  INSERT INTO public.workflow_refresh_runs(workflow,scope,status,requested_by,org_id,created_at)
  VALUES
    ('dispatch',jsonb_build_object('org_id',org),'queued','queue-fixture',org,now()-interval '4 minutes'),
    ('dispatch',jsonb_build_object('org_id',org,'week_start','2026-09-13'),
     'queued','queue-fixture',org,now()-interval '3 minutes');
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_missing),'queue-fixture',org
  );
  UPDATE public.workflow_refresh_runs SET created_at=now()-interval '2 minutes'
   WHERE id=(started->>'id')::uuid;
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_error),'queue-fixture',org
  );
  UPDATE public.workflow_refresh_runs SET created_at=now()-interval '1 minute'
   WHERE id=(started->>'id')::uuid;
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_good),'queue-fixture',org
  );
  joined := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_good),'queue-fixture',org
  );
  PERFORM pg_temp.assert_refresh_queue(
    joined->>'outcome'='joined' AND joined->>'id'=started->>'id',
    'supported starts must still coalesce'
  );

  RESET ROLE;
  ALTER FUNCTION public.dispatch_source_version(uuid,uuid) RENAME TO dispatch_source_version_queue_unavailable;
  SET LOCAL ROLE service_role;
  consumed := public.consume_workflow_refresh('dispatch');
  PERFORM pg_temp.assert_refresh_queue(
    consumed->>'outcome'='unavailable'
      AND (SELECT count(*)=5 FROM public.workflow_refresh_runs
            WHERE requested_by='queue-fixture' AND status='queued'),
    'missing validator must leave queued work unavailable and unchanged'
  );
  RESET ROLE;
  ALTER FUNCTION public.dispatch_source_version_queue_unavailable(uuid,uuid) RENAME TO dispatch_source_version;
  SET LOCAL ROLE service_role;

  FOR rejected IN
    SELECT id,scope FROM public.workflow_refresh_runs
     WHERE requested_by='queue-fixture' AND id<>(started->>'id')::uuid
     ORDER BY created_at
  LOOP
    consumed := public.consume_workflow_refresh('dispatch');
    PERFORM pg_temp.assert_refresh_queue(
      consumed->>'id'=rejected.id::text AND consumed->>'status'='failed'
        AND consumed->>'ok'='false' AND consumed->>'reason'='claim_failed',
      'consumer must contain each invalid scope or source claim failure'
    );
    readback := public.workflow_refresh_readback(rejected.id,org);
    PERFORM pg_temp.assert_refresh_queue(
      readback->>'status'='failed' AND readback->>'lease_generation'='0'
        AND readback#>>'{result,step}'='claim_failed'
        AND readback#>>'{result,error}'=CASE rejected.scope->>'job_id'
          WHEN job_missing::text THEN 'workflow_refresh_source_unavailable'
          WHEN job_error::text THEN 'fixture_source_error'
          ELSE 'workflow_refresh_validator_unavailable' END
        AND NOT readback ? 'lease_token',
      'claim failures must be persisted without a lease or successful assessment'
    );
    failures := failures+1;
  END LOOP;
  PERFORM pg_temp.assert_refresh_queue(failures=4,'all four broken queued runs must be contained');
  consumed := public.consume_workflow_refresh('dispatch');
  PERFORM pg_temp.assert_refresh_queue(
    consumed->>'id'=started->>'id' AND consumed->>'status'='running'
      AND consumed->>'lease_generation'='1' AND consumed->>'lease_token' IS NOT NULL
      AND consumed->>'expected_source_revision'='source-queue-good',
    'valid queued work must remain claimable after earlier claim failures'
  );
  consumed := public.consume_workflow_refresh('dispatch');
  PERFORM pg_temp.assert_refresh_queue(consumed->>'outcome'='idle','failed runs must not be retried by consume');
  RESET ROLE;
  PERFORM pg_temp.assert_refresh_queue(
    NOT EXISTS (SELECT 1 FROM public.workflow_refresh_receipts),
    'consumer claim failures must never fabricate assessment receipts'
  );
  RAISE NOTICE 'Refresh queue contracts: scope rejection, unavailable validator, claim failure isolation and later valid work passed';
END $$;
ROLLBACK;
