-- Debt source version, assess commands, and register on 5f03d6fd.
-- start(debt) uses invoice or book scope without job_id. No send. No cache write.
BEGIN;
CREATE FUNCTION pg_temp.assert_debt_source(ok boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END $$;

DO $$
DECLARE
  org_a constant uuid := '00000000-0000-0000-0000-000000000001';
  org_b constant uuid := '00000000-0000-0000-0000-000000000002';
  inv_a constant uuid := '29400000-0000-4000-8000-000000000001';
  inv_b constant uuid := '29400000-0000-4000-8000-000000000002';
  inv_missing constant uuid := '29400000-0000-4000-8000-000000000099';
  job_a constant uuid := '28000000-0000-4000-8000-000000000001';
  book_scope constant uuid := '00000000-0000-0000-0000-000000000000';
  version_a text;
  version_a2 text;
  version_book text;
  version_book2 text;
  registered jsonb;
  started jsonb;
  started_book jsonb;
  claimed jsonb;
  claimed_book jsonb;
  receipt jsonb;
  finished jsonb;
  readback jsonb;
  observed text;
  observed_book text;
  scope_inv jsonb;
  output_inv jsonb;
  commit_result jsonb;
BEGIN
  PERFORM pg_temp.assert_debt_source(
    to_regprocedure('public.debt_source_version(uuid,uuid)') IS NOT NULL
      AND to_regclass('public.debt_assess_commands') IS NOT NULL,
    'debt_source_version and debt_assess_commands must exist'
  );
  PERFORM pg_temp.assert_debt_source(
    (SELECT capability='registered' AND validator_key='debt_source_v1'
        AND declared_output='debt_refresh/v1'
       FROM public.workflow_refresh_drivers WHERE workflow='debt'),
    'debt must be registered with debt_source_v1 on this SHA'
  );

  INSERT INTO public.xero_invoices(
    id, org_id, xero_invoice_id, invoice_type, status, amount_due, amount_paid,
    synced_at, debt_classification, debt_blocker, debt_as_of, debt_brief
  ) VALUES (
    inv_a, org_a, inv_a::text, 'ACCREC', 'AUTHORISED', 100.00, 0,
    '2026-09-13 07:00:00+08', 'genuine_debt', NULL, '2026-09-13 15:05:00+08',
    jsonb_build_object('notes_digest','brief-a')
  ), (
    inv_b, org_a, inv_b::text, 'ACCREC', 'AUTHORISED', 50.00, 0,
    '2026-09-13 07:00:00+08', 'blocked_by_us', 'invoice_wrong',
    '2026-09-13 15:05:00+08', jsonb_build_object('notes_digest','brief-b')
  );
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id=job_a) THEN
    INSERT INTO public.jobs(id,org_id,status,type,job_number)
    VALUES (job_a,org_a,'new','patio','REFRESH-294-DISPATCH');
  END IF;

  version_a := public.debt_source_version(org_a, inv_a);
  PERFORM pg_temp.assert_debt_source(
    version_a IS NOT NULL AND length(version_a) = 32,
    'invoice source version must be a non-null md5'
  );
  version_a2 := public.debt_source_version(org_a, inv_a);
  PERFORM pg_temp.assert_debt_source(
    version_a = version_a2,
    'invoice source version must be stable for unchanged facts'
  );

  UPDATE public.xero_invoices SET amount_due = 120.00 WHERE id = inv_a;
  version_a2 := public.debt_source_version(org_a, inv_a);
  PERFORM pg_temp.assert_debt_source(
    version_a IS DISTINCT FROM version_a2,
    'amount_due change must change the invoice source version'
  );
  UPDATE public.xero_invoices SET amount_due = 100.00 WHERE id = inv_a;
  version_a2 := public.debt_source_version(org_a, inv_a);
  PERFORM pg_temp.assert_debt_source(
    version_a = version_a2,
    'restored amount_due must restore the invoice source version'
  );

  version_book := public.debt_source_version(org_a, book_scope);
  PERFORM pg_temp.assert_debt_source(
    version_book IS NOT NULL AND version_book IS DISTINCT FROM version_a,
    'book scope uses the nil uuid and is not an invoice hash'
  );
  UPDATE public.xero_invoices SET amount_due = 51.00 WHERE id = inv_b;
  version_book2 := public.debt_source_version(org_a, book_scope);
  PERFORM pg_temp.assert_debt_source(
    version_book IS DISTINCT FROM version_book2,
    'book hash must move when any open invoice fact changes'
  );
  UPDATE public.xero_invoices SET amount_due = 50.00 WHERE id = inv_b;

  BEGIN
    PERFORM public.debt_source_version(org_a, inv_missing);
    RAISE EXCEPTION 'missing invoice unexpectedly hashed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'missing invoice unexpectedly hashed' THEN RAISE; END IF;
    PERFORM pg_temp.assert_debt_source(
      SQLERRM LIKE '%workflow_refresh_source_unavailable%',
      'missing invoice must raise workflow_refresh_source_unavailable, never NULL'
    );
  END;
  BEGIN
    PERFORM public.debt_source_version(NULL, inv_a);
    RAISE EXCEPTION 'null org unexpectedly hashed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'null org unexpectedly hashed' THEN RAISE; END IF;
    PERFORM pg_temp.assert_debt_source(
      SQLERRM LIKE '%workflow_refresh_source_unavailable%',
      'null org must raise workflow_refresh_source_unavailable'
    );
  END;

  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.register_workflow_refresh_driver(
      'debt','debt-collection','dispatch_refresh/v1','contract-294','registered'
    );
    RAISE EXCEPTION 'debt registered with dispatch validator';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debt registered with dispatch validator' THEN RAISE; END IF;
    PERFORM pg_temp.assert_debt_source(
      SQLERRM LIKE '%workflow_refresh_validator_unavailable%',
      'register debt as dispatch_refresh/v1 must stay unavailable'
    );
  END;

  registered := public.register_workflow_refresh_driver(
    'debt','debt-collection','debt_refresh/v1','contract-294','registered'
  );
  PERFORM pg_temp.assert_debt_source(
    registered->>'validator_key'='debt_source_v1',
    're-register on this SHA must keep debt_source_v1'
  );

  BEGIN
    PERFORM public.start_workflow_refresh(
      'debt',jsonb_build_object('job_id',job_a::text),'contract-294',org_a
    );
    RAISE EXCEPTION 'debt start with only job_id unexpectedly queued';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'debt start with only job_id unexpectedly queued' THEN RAISE; END IF;
    PERFORM pg_temp.assert_debt_source(
      SQLERRM='workflow_refresh_scope_missing',
      'start(debt) must not treat dispatch job_id as sufficient scope'
    );
  END;

  started := public.start_workflow_refresh(
    'debt',jsonb_build_object('xero_invoice_id',inv_a::text),'contract-294',org_a
  );
  PERFORM pg_temp.assert_debt_source(
    started->>'outcome'='started' AND started->>'status'='queued'
      AND started->'scope' ? 'xero_invoice_id'
      AND NOT (started->'scope' ? 'job_id'),
    'start(debt) with invoice scope must queue without job_id'
  );

  started_book := public.start_workflow_refresh(
    'debt',jsonb_build_object('population','open'),'contract-294',org_a
  );
  PERFORM pg_temp.assert_debt_source(
    started_book->>'outcome'='started'
      AND started_book->'scope'->>'population'='open'
      AND NOT (started_book->'scope' ? 'job_id'),
    'start(debt) with population=open must queue the book without job_id'
  );

  started := public.start_workflow_refresh(
    'debt',jsonb_build_object('xero_invoice_id',inv_a::text),'contract-294',org_a
  );
  PERFORM pg_temp.assert_debt_source(
    started->>'outcome'='joined',
    'second invoice start must join the queued run'
  );

  claimed := public.claim_workflow_refresh((
    SELECT id FROM public.workflow_refresh_runs
     WHERE workflow='debt' AND scope->>'xero_invoice_id'=inv_a::text
     ORDER BY created_at LIMIT 1
  ),'debt',NULL,NULL);
  observed := claimed->>'expected_source_revision';
  PERFORM pg_temp.assert_debt_source(
    observed = public.debt_source_version(org_a, inv_a)
      AND claimed->>'lease_token' IS NOT NULL
      AND claimed->>'driver_request_id' IS DISTINCT FROM claimed->>'lease_token',
    'claim must bind the live hash and keep lease_token distinct from driver_request_id'
  );

  BEGIN
    PERFORM public.finish_workflow_refresh(
      (claimed->>'id')::uuid,'completed',
      jsonb_build_object('ok','true','declared_output','debt_refresh/v1'),
      now(),(claimed->>'lease_token')::uuid,'debt',
      (claimed->>'lease_generation')::integer,observed
    );
    RAISE EXCEPTION 'declaration-only debt finish unexpectedly completed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'declaration-only debt finish unexpectedly completed' THEN RAISE; END IF;
    PERFORM pg_temp.assert_debt_source(
      SQLERRM LIKE '%workflow_refresh_driver_output_missing%',
      'declaration-only finish must require a real assess command'
    );
  END;

  BEGIN
    PERFORM public.debt_assess_commit(
      org_a, (claimed->>'driver_request_id')::uuid, inv_a,
      jsonb_build_object(
        'mode','assess','writes',true,'sends',false,'complete',true,
        'live_actions_enabled',false,'source_version',observed
      )
    );
    RAISE EXCEPTION 'writes=true assess unexpectedly committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'writes=true assess unexpectedly committed' THEN RAISE; END IF;
    PERFORM pg_temp.assert_debt_source(
      SQLERRM LIKE '%debt_assess_live_actions_forbidden%',
      'assess commit must refuse writes'
    );
  END;
  BEGIN
    PERFORM public.debt_assess_commit(
      org_a, (claimed->>'driver_request_id')::uuid, inv_a,
      jsonb_build_object(
        'mode','assess','writes',false,'sends',true,'complete',true,
        'live_actions_enabled',false,'source_version',observed
      )
    );
    RAISE EXCEPTION 'sends=true assess unexpectedly committed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'sends=true assess unexpectedly committed' THEN RAISE; END IF;
    PERFORM pg_temp.assert_debt_source(
      SQLERRM LIKE '%debt_assess_live_actions_forbidden%',
      'assess commit must refuse sends'
    );
  END;

  commit_result := public.debt_assess_commit(
    org_a, (claimed->>'driver_request_id')::uuid, inv_a,
    jsonb_build_object(
      'mode','assess','writes',false,'sends',false,'complete',true,
      'door_count',1,'picture_count',1,'provider_count',1,
      'by_class',jsonb_build_object('genuine_debt',1),
      'errors',jsonb_build_array(),'missing',jsonb_build_array(),
      'live_actions_enabled',false,'source_version',observed
    )
  );
  PERFORM pg_temp.assert_debt_source(
    commit_result->>'mode'='assess'
      AND commit_result->>'writes'='false'
      AND commit_result->>'sends'='false'
      AND commit_result->>'live_actions_enabled'='false'
      AND commit_result->>'source_version'=observed,
    'assess result must bind mode/writes/sends/live_actions_enabled/source_version'
  );

  scope_inv := jsonb_build_object('xero_invoice_id',inv_a::text,'org_id',org_a::text);
  output_inv := jsonb_build_object(
    'ok',true,
    'declared_output','debt_refresh/v1',
    'observed_source_revision',observed,
    'output_ref',jsonb_build_object(
      'table','debt_assess_commands','command','assess',
      'request_id',claimed->>'driver_request_id'
    )
  );
  receipt := public.record_workflow_refresh_receipt(
    (claimed->>'id')::uuid,'debt',(claimed->>'lease_token')::uuid,
    (claimed->>'lease_generation')::integer,'debt_refresh/v1',scope_inv,
    output_inv,observed
  );
  PERFORM pg_temp.assert_debt_source(receipt->>'outcome'='persisted','debt receipt persistence');
  finished := public.finish_workflow_refresh(
    (claimed->>'id')::uuid,'completed',jsonb_build_object('caller_claim','ignored'),now(),
    (claimed->>'lease_token')::uuid,'debt',(claimed->>'lease_generation')::integer,observed
  );
  PERFORM pg_temp.assert_debt_source(finished->>'status'='completed','verified debt finish');
  readback := public.workflow_refresh_readback((claimed->>'id')::uuid,org_a);
  PERFORM pg_temp.assert_debt_source(
    readback->>'status'='completed' AND NOT (readback ? 'lease_token'),
    'debt readback must hide lease_token'
  );

  claimed_book := public.claim_workflow_refresh((
    SELECT id FROM public.workflow_refresh_runs
     WHERE workflow='debt' AND scope->>'population'='open'
     ORDER BY created_at LIMIT 1
  ),'debt',NULL,NULL);
  observed_book := claimed_book->>'expected_source_revision';
  PERFORM pg_temp.assert_debt_source(
    observed_book = public.debt_source_version(org_a, book_scope),
    'book claim must bind the nil-uuid book hash'
  );
  PERFORM public.debt_assess_commit(
    org_a, (claimed_book->>'driver_request_id')::uuid, book_scope,
    jsonb_build_object(
      'mode','assess','writes',false,'sends',false,'complete',true,
      'door_count',2,'picture_count',2,'provider_count',2,
      'by_class',jsonb_build_object('genuine_debt',1,'blocked_by_us',1),
      'errors',jsonb_build_array(),'missing',jsonb_build_array(),
      'live_actions_enabled',false,'source_version',observed_book
    )
  );
  receipt := public.record_workflow_refresh_receipt(
    (claimed_book->>'id')::uuid,'debt',(claimed_book->>'lease_token')::uuid,
    (claimed_book->>'lease_generation')::integer,'debt_refresh/v1',
    jsonb_build_object('population','open','org_id',org_a::text),
    jsonb_build_object(
      'ok',true,'declared_output','debt_refresh/v1',
      'observed_source_revision',observed_book,
      'output_ref',jsonb_build_object(
        'table','debt_assess_commands','command','assess',
        'request_id',claimed_book->>'driver_request_id'
      )
    ),
    observed_book
  );
  PERFORM pg_temp.assert_debt_source(receipt->>'outcome'='persisted','book receipt persistence');
  finished := public.finish_workflow_refresh(
    (claimed_book->>'id')::uuid,'completed',jsonb_build_object('caller_claim','ignored'),now(),
    (claimed_book->>'lease_token')::uuid,'debt',
    (claimed_book->>'lease_generation')::integer,observed_book
  );
  PERFORM pg_temp.assert_debt_source(finished->>'status'='completed','verified book finish');

  PERFORM pg_temp.assert_debt_source(
    NOT has_function_privilege('anon',
      'public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)',
      'EXECUTE'),
    'JWT/anon must not call record_workflow_refresh_receipt'
  );
  PERFORM pg_temp.assert_debt_source(
    NOT has_function_privilege('authenticated',
      'public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)',
      'EXECUTE'),
    'authenticated UI must not call record_workflow_refresh_receipt'
  );
  PERFORM pg_temp.assert_debt_source(
    NOT EXISTS (
      SELECT 1 FROM public.xero_invoices
       WHERE org_id=org_b
    ),
    'assess path must not invent invoices in another org'
  );
  RESET ROLE;
END $$;
ROLLBACK;
