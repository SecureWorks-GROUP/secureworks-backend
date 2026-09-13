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
CREATE FUNCTION pg_temp.refresh_receipt_count(p_run_id uuid, p_generation integer DEFAULT NULL)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT count(*)::integer
    FROM public.workflow_refresh_receipts
   WHERE run_id=p_run_id
     AND (p_generation IS NULL OR lease_generation=p_generation)
$$;

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
  job_reclaim constant uuid := '28000000-0000-4000-8000-000000000007';
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
  reclaimed jsonb;
  retry jsonb;
  old_lease uuid;
  unrelated_request uuid;
BEGIN
  INSERT INTO public.jobs(id,org_id,status,type,job_number)
  VALUES
    (job_a,org_a,'new','patio','REFRESH-280-1'),
    (job_capture,org_a,'new','patio','REFRESH-280-2'),
    (job_changed,org_a,'new','patio','REFRESH-280-3'),
    (job_missing,org_a,'new','patio','REFRESH-280-4'),
    (job_error,org_a,'new','patio','REFRESH-280-5'),
    (job_mutated,org_a,'new','patio','REFRESH-280-6'),
    (job_reclaim,org_a,'new','patio','REFRESH-280-7');
  INSERT INTO public.dispatch_refresh_test_sources(org_id,job_id,revision)
  VALUES
    (org_a,job_a,'source-a1'),
    (org_a,job_capture,'source-capture-before'),
    (org_a,job_changed,'source-change-1'),
    (org_a,job_error,'error'),
    (org_a,job_mutated,'source-mutation-1'),
    (org_a,job_reclaim,'source-reclaim-1');

  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.register_workflow_refresh_driver(
      'debt','debt-collection','dispatch_refresh/v1','contract-280','registered'
    );
    RAISE EXCEPTION 'debt registered with dispatch validator';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debt registered with dispatch validator' THEN RAISE; END IF;
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_validator_unavailable%',
      'debt must not register as a dispatch validator'
    );
  END;
  IF to_regprocedure('public.debt_source_version(uuid,uuid)') IS NULL
     OR to_regclass('public.debt_assess_commands') IS NULL THEN
    BEGIN
      PERFORM public.register_workflow_refresh_driver(
        'debt','debt-collection','debt_refresh/v1','contract-280','registered'
      );
      RAISE EXCEPTION 'unsupported debt validator unexpectedly registered';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'unsupported debt validator unexpectedly registered' THEN RAISE; END IF;
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
  ELSE
    BEGIN
      PERFORM public.start_workflow_refresh(
        'debt',jsonb_build_object('week_start','2026-09-13'),'fixture-ui',org_a
      );
      RAISE EXCEPTION 'week-only debt start queued';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM = 'week-only debt start queued' THEN RAISE; END IF;
      PERFORM pg_temp.assert_refresh_completion(
        SQLERRM LIKE '%workflow_refresh_scope_missing%',
        'week-only debt start must not queue after Debt registers'
      );
    END;
  END IF;

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
      'table','dispatch_commands','command','assess',
      'request_id',claimed_a->>'driver_request_id'
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_a,0,(claimed_a->>'driver_request_id')::uuid,'hash-a','operations','assess',observed_a,
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
      output_a || jsonb_build_object('retry_metadata','different'),observed_a
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
      'table','dispatch_commands','command','assess',
      'request_id',claimed->>'driver_request_id'
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_capture,0,(claimed->>'driver_request_id')::uuid,'hash-capture','operations','assess',observed,
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
      'table','dispatch_commands','command','assess',
      'request_id',claimed->>'driver_request_id'
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_changed,0,(claimed->>'driver_request_id')::uuid,'hash-changed','operations','assess',observed,
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
      'table','dispatch_commands','command','assess',
      'request_id',claimed->>'driver_request_id'
    )
  );
  PERFORM public.dispatch_commit(
    org_a,job_mutated,0,(claimed->>'driver_request_id')::uuid,'hash-mutated','operations','assess',observed,
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
                 WHERE org_id=org_a AND request_id=(claimed->>'driver_request_id')::uuid)
   WHERE org_id=org_a AND job_id=job_mutated;
  UPDATE public.dispatch_commands
     SET result=jsonb_set(result,'{version}','999'::jsonb)
   WHERE org_id=org_a AND request_id=(claimed->>'driver_request_id')::uuid;
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

  -- A server-issued command identity binds the assess output to this run and
  -- generation. An unrelated same-job assess after claim cannot be borrowed.
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job_reclaim::text),'fixture-ui-4c',org_a
  );
  claimed := public.claim_workflow_refresh((started->>'id')::uuid,'dispatch',NULL,NULL);
  observed := claimed->>'expected_source_revision';
  unrelated_request := gen_random_uuid();
  PERFORM public.dispatch_commit(
    org_a,job_reclaim,0,unrelated_request,'hash-unrelated','operations','assess',observed,
    jsonb_build_object('assessment',jsonb_build_object('source_version',observed))
  );
  scope_a := jsonb_build_object('job_id',job_reclaim::text,'org_id',org_a::text);
  output_a := jsonb_build_object(
    'ok',true,'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed,
    'output_ref',jsonb_build_object(
      'table','dispatch_commands','command','assess','request_id',unrelated_request::text
    )
  );
  BEGIN
    PERFORM public.record_workflow_refresh_receipt(
      (started->>'id')::uuid,'dispatch',(claimed->>'lease_token')::uuid,
      (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
    );
    RAISE EXCEPTION 'unrelated same-job command unexpectedly bound';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_driver_output_invalid%',
      'receipt must use the server-issued command identity'
    );
  END;

  -- The original generation may leave a verified receipt before interruption.
  -- Reclaim creates a new command identity and generation while retaining the
  -- old receipt as immutable history; only generation 2 can finish.
  PERFORM public.dispatch_commit(
    org_a,job_reclaim,1,(claimed->>'driver_request_id')::uuid,'hash-generation-1',
    'operations','assess',observed,jsonb_build_object('assessment',jsonb_build_object('source_version',observed))
  );
  output_a := jsonb_build_object(
    'ok',true,'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed,
    'output_ref',jsonb_build_object(
      'table','dispatch_commands','command','assess',
      'request_id',claimed->>'driver_request_id'
    )
  );
  receipt := public.record_workflow_refresh_receipt(
    (started->>'id')::uuid,'dispatch',(claimed->>'lease_token')::uuid,
    (claimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
  );
  old_lease := (claimed->>'lease_token')::uuid;
  UPDATE public.workflow_refresh_runs SET updated_at=now()-interval '16 minutes'
   WHERE id=(started->>'id')::uuid;
  reclaimed := public.claim_workflow_refresh(
    (started->>'id')::uuid,'dispatch',old_lease,(claimed->>'lease_generation')::integer
  );
  PERFORM pg_temp.assert_refresh_completion(
    reclaimed->>'lease_generation'='2'
      AND reclaimed->>'driver_request_id' IS NOT NULL
      AND reclaimed->>'driver_request_id' IS DISTINCT FROM claimed->>'driver_request_id',
    'reclaim must issue a fresh generation command identity'
  );
  observed := reclaimed->>'expected_source_revision';
  PERFORM public.dispatch_commit(
    org_a,job_reclaim,2,(reclaimed->>'driver_request_id')::uuid,'hash-generation-2',
    'operations','assess',observed,jsonb_build_object('assessment',jsonb_build_object('source_version',observed))
  );
  output_a := jsonb_build_object(
    'ok',true,'declared_output','dispatch_refresh/v1',
    'observed_source_revision',observed,
    'output_ref',jsonb_build_object(
      'table','dispatch_commands','command','assess',
      'request_id',reclaimed->>'driver_request_id'
    )
  );
  receipt := public.record_workflow_refresh_receipt(
    (started->>'id')::uuid,'dispatch',(reclaimed->>'lease_token')::uuid,
    (reclaimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
  );
  PERFORM pg_temp.assert_refresh_completion(
    pg_temp.refresh_receipt_count((started->>'id')::uuid)=2
      AND pg_temp.refresh_receipt_count((started->>'id')::uuid,1)=1
      AND pg_temp.refresh_receipt_count((started->>'id')::uuid,2)=1,
    'reclaim must retain one receipt per generation'
  );
  finished := public.finish_workflow_refresh(
    (started->>'id')::uuid,'completed',
    jsonb_build_object('receipt_id',receipt->>'receipt_id'),now(),
    (reclaimed->>'lease_token')::uuid,'dispatch',
    (reclaimed->>'lease_generation')::integer,observed
  );
  PERFORM pg_temp.assert_refresh_completion(
    finished->>'status'='completed','reclaimed generation must finish with its receipt'
  );
  retry := public.record_workflow_refresh_receipt(
    (started->>'id')::uuid,'dispatch',(reclaimed->>'lease_token')::uuid,
    (reclaimed->>'lease_generation')::integer,'dispatch_refresh/v1',scope_a,output_a,observed
  );
  PERFORM pg_temp.assert_refresh_completion(
    retry->>'outcome'='idempotent' AND retry->>'receipt_id'=receipt->>'receipt_id',
    'lost receipt response retry must be idempotent'
  );
  retry := public.finish_workflow_refresh(
    (started->>'id')::uuid,'completed',
    jsonb_build_object('receipt_id',receipt->>'receipt_id'),now(),
    (reclaimed->>'lease_token')::uuid,'dispatch',
    (reclaimed->>'lease_generation')::integer,observed
  );
  PERFORM pg_temp.assert_refresh_completion(
    retry->>'replayed'='true' AND retry->>'status'='completed'
      AND retry->'result'->>'receipt_id'=receipt->>'receipt_id',
    'lost finish response retry must return stored final result'
  );
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started->>'id')::uuid,'completed',jsonb_build_object('receipt_id',gen_random_uuid()::text),
      now(),(reclaimed->>'lease_token')::uuid,'dispatch',
      (reclaimed->>'lease_generation')::integer,observed
    );
    RAISE EXCEPTION 'different completed payload unexpectedly replayed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_receipt_retry_mismatch%',
      'different completed payload must not replay'
    );
  END;
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started->>'id')::uuid,'completed',
      jsonb_build_object('receipt_id',receipt->>'receipt_id'),now(),old_lease,'dispatch',1,observed
    );
    RAISE EXCEPTION 'stale generation unexpectedly replayed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_completion(
      SQLERRM LIKE '%workflow_refresh_lease_mismatch%',
      'stale generation must remain refused after reclaim'
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
          'table','dispatch_commands','command','assess',
          'request_id',claimed->>'driver_request_id'
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
