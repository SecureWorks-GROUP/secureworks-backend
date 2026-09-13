-- Regression capture for the old 260000 contract. The next migration must
-- make the same declaration-only finish fail.
BEGIN;
CREATE FUNCTION pg_temp.assert_refresh_regression(ok boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF;
END $$;

DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-000000000001';
  job constant uuid := '26000000-0000-4000-8000-000000000001';
  started jsonb;
  claimed jsonb;
BEGIN
  INSERT INTO public.jobs(id,org_id,status,type,job_number)
  VALUES (job,org,'new','patio','REFRESH-260-1');
  INSERT INTO public.dispatch_refresh_test_sources(org_id,job_id,revision)
  VALUES (org,job,'source-r1');

  SET LOCAL ROLE service_role;
  PERFORM public.register_workflow_refresh_driver(
    'dispatch','operations','dispatch_refresh/v1','contract-260','registered'
  );
  started := public.start_workflow_refresh(
    'dispatch',jsonb_build_object('job_id',job::text),'fixture-ui',org
  );
  claimed := public.claim_workflow_refresh(
    (started->>'id')::uuid,'dispatch',NULL,NULL
  );
  BEGIN
    PERFORM public.finish_workflow_refresh(
      (started->>'id')::uuid,'completed',
      jsonb_build_object('ok','true','declared_output','dispatch_refresh/v1'),
      now(),(claimed->>'lease_token')::uuid,'dispatch',
      (claimed->>'lease_generation')::integer,claimed->>'expected_source_revision'
    );
    RAISE EXCEPTION 'declaration-only finish unexpectedly completed';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.assert_refresh_regression(
      SQLERRM LIKE '%workflow_refresh_driver_output_missing%',
      'current stack must require a persisted receipt'
    );
  END;
  RESET ROLE;

  PERFORM pg_temp.assert_refresh_regression(
    (SELECT status='running' FROM public.workflow_refresh_runs WHERE id=(started->>'id')::uuid),
    'rejected declaration-only finish must leave the run running'
  );
  RAISE NOTICE 'Refresh regression shield: declaration-only finish is refused on the current stack';
END $$;
ROLLBACK;
