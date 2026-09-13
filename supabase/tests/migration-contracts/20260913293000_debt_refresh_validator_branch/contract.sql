-- Debt validator branch: start(debt) uses invoice or book scope without job_id.
-- Registering debt still requires Debt-owned debt_source_version and
-- debt_assess_commands. Stubs live only inside this rolled-back transaction.
BEGIN;
CREATE FUNCTION pg_temp.assert_debt_refresh(ok boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END $$;

DO $$
DECLARE
  org_a constant uuid := '00000000-0000-0000-0000-000000000001';
  started jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.register_workflow_refresh_driver(
      'debt','debt-collection','debt_refresh/v1','contract-293','registered'
    );
    RAISE EXCEPTION 'debt registered without domain functions';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_debt_refresh(
      SQLERRM LIKE '%workflow_refresh_validator_unavailable%',
      'register debt without source function must stay unavailable'
    );
  END;
  BEGIN
    PERFORM public.register_workflow_refresh_driver(
      'debt','debt-collection','dispatch_refresh/v1','contract-293','registered'
    );
    RAISE EXCEPTION 'debt registered with dispatch validator';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_debt_refresh(
      SQLERRM LIKE '%workflow_refresh_validator_unavailable%',
      'register debt while still a dispatch validator must stay unavailable'
    );
  END;
  started := public.start_workflow_refresh(
    'debt',jsonb_build_object('week_start','2026-09-13'),'fixture-ui',org_a
  );
  PERFORM pg_temp.assert_debt_refresh(
    started->>'outcome'='unavailable',
    'start(debt) stays unavailable until validator_key and source function exist'
  );
  started := public.start_workflow_refresh(
    'debt',jsonb_build_object('xero_invoice_id','29300000-0000-4000-8000-000000000001'),
    'fixture-ui',org_a
  );
  PERFORM pg_temp.assert_debt_refresh(
    started->>'outcome'='unavailable',
    'invoice-scoped start(debt) must not queue before Debt registers'
  );
  PERFORM pg_temp.assert_debt_refresh(
    NOT EXISTS (
      SELECT 1 FROM public.workflow_refresh_runs WHERE requested_by='fixture-ui'
    ),
    'unregistered debt must not enqueue runs'
  );
  PERFORM pg_temp.assert_debt_refresh(
    NOT has_function_privilege('anon',
      'public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)',
      'EXECUTE'),
    'JWT/anon must not call record_workflow_refresh_receipt'
  );
  PERFORM pg_temp.assert_debt_refresh(
    NOT has_function_privilege('authenticated',
      'public.record_workflow_refresh_receipt(uuid,text,uuid,integer,text,jsonb,jsonb,text)',
      'EXECUTE'),
    'authenticated UI must not call record_workflow_refresh_receipt'
  );
  RESET ROLE;
END $$;

CREATE TABLE public.debt_assess_commands (
  request_id uuid NOT NULL,
  org_id uuid NOT NULL,
  xero_invoice_id uuid,
  command text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, request_id)
);
CREATE FUNCTION public.debt_source_version(p_org uuid, p_invoice uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN p_invoice = '00000000-0000-0000-0000-000000000000'::uuid THEN 'debt-book-1'
    ELSE 'debt-inv-1'
  END;
$$;
GRANT SELECT, INSERT ON public.debt_assess_commands TO service_role;
GRANT EXECUTE ON FUNCTION public.debt_source_version(uuid,uuid) TO service_role;

INSERT INTO public.xero_invoices(id,org_id,xero_invoice_id,invoice_type,status,amount_due)
VALUES (
  '29300000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '29300000-0000-4000-8000-000000000001',
  'ACCREC','AUTHORISED',100.00
);

DO $$
DECLARE
  org_a constant uuid := '00000000-0000-0000-0000-000000000001';
  inv_a constant uuid := '29300000-0000-4000-8000-000000000001';
  job_a constant uuid := '28000000-0000-4000-8000-000000000001';
  registered jsonb;
  started jsonb;
  claimed jsonb;
  receipt jsonb;
  finished jsonb;
  readback jsonb;
  scope_inv jsonb;
  output_inv jsonb;
  observed text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id=job_a) THEN
    INSERT INTO public.jobs(id,org_id,status,type,job_number)
    VALUES (job_a,org_a,'new','patio','REFRESH-293-DISPATCH');
  END IF;
  SET LOCAL ROLE service_role;
  registered := public.register_workflow_refresh_driver(
    'debt','debt-collection','debt_refresh/v1','contract-293','registered'
  );
  PERFORM pg_temp.assert_debt_refresh(
    registered->>'validator_key'='debt_source_v1'
      AND registered->>'capability'='registered',
    'debt registers only after source function and command table exist'
  );

  BEGIN
    PERFORM public.start_workflow_refresh(
      'debt',jsonb_build_object('job_id',job_a::text),'fixture-ui',org_a
    );
    RAISE EXCEPTION 'debt start with only job_id unexpectedly queued';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_debt_refresh(
      SQLERRM='workflow_refresh_scope_missing',
      'start(debt) must not treat dispatch job_id as sufficient scope'
    );
  END;

  PERFORM public.register_workflow_refresh_driver(
    'dispatch','operations','dispatch_refresh/v1','contract-293','registered'
  );
  BEGIN
    PERFORM public.start_workflow_refresh(
      'dispatch',jsonb_build_object('week_start','2026-09-13'),'fixture-ui',org_a
    );
    RAISE EXCEPTION 'dispatch start without job_id unexpectedly queued';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_debt_refresh(
      SQLERRM='workflow_refresh_scope_missing',
      'dispatch start must still require job_id'
    );
  END;

  started := public.start_workflow_refresh(
    'debt',jsonb_build_object('xero_invoice_id',inv_a::text),'fixture-ui',org_a
  );
  PERFORM pg_temp.assert_debt_refresh(
    started->>'outcome'='started' AND started->>'status'='queued',
    'start(debt) with invoice scope must queue without job_id'
  );
  PERFORM pg_temp.assert_debt_refresh(
    started->'scope' ? 'xero_invoice_id' AND NOT (started->'scope' ? 'job_id'),
    'debt invoice run must not invent a job_id'
  );

  started := public.start_workflow_refresh(
    'debt',jsonb_build_object('population','open'),'fixture-ui',org_a
  );
  PERFORM pg_temp.assert_debt_refresh(
    started->>'outcome'='started',
    'start(debt) with population=open must queue the book'
  );

  claimed := public.claim_workflow_refresh((
    SELECT id FROM public.workflow_refresh_runs
     WHERE workflow='debt' AND scope->>'xero_invoice_id'=inv_a::text
     ORDER BY created_at LIMIT 1
  ),'debt',NULL,NULL);
  observed := claimed->>'expected_source_revision';
  PERFORM pg_temp.assert_debt_refresh(
    observed='debt-inv-1'
      AND claimed->>'lease_token' IS NOT NULL
      AND claimed->>'driver_request_id' IS DISTINCT FROM claimed->>'lease_token',
    'claim must bind a source revision and keep lease_token distinct from driver_request_id'
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
    PERFORM pg_temp.assert_debt_refresh(
      SQLERRM LIKE '%workflow_refresh_driver_output_missing%',
      'declaration-only finish must require a real assess command'
    );
  END;

  INSERT INTO public.debt_assess_commands(
    request_id,org_id,xero_invoice_id,command,result
  ) VALUES (
    (claimed->>'driver_request_id')::uuid,
    org_a,
    inv_a,
    'assess',
    jsonb_build_object(
      'mode','assess','writes',false,'sends',false,'complete',true,
      'door_count',1,'picture_count',1,'provider_count',1,
      'by_class',jsonb_build_object(),
      'errors',jsonb_build_array(),'missing',jsonb_build_array(),
      'live_actions_enabled',false,'source_version',observed
    )
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
  PERFORM pg_temp.assert_debt_refresh(receipt->>'outcome'='persisted','debt receipt persistence');
  finished := public.finish_workflow_refresh(
    (claimed->>'id')::uuid,'completed',jsonb_build_object('caller_claim','ignored'),now(),
    (claimed->>'lease_token')::uuid,'debt',(claimed->>'lease_generation')::integer,observed
  );
  PERFORM pg_temp.assert_debt_refresh(finished->>'status'='completed','verified debt finish');
  readback := public.workflow_refresh_readback((claimed->>'id')::uuid,org_a);
  PERFORM pg_temp.assert_debt_refresh(
    readback->>'status'='completed' AND NOT (readback ? 'lease_token'),
    'debt readback must hide lease_token'
  );
  RESET ROLE;
END $$;
ROLLBACK;
