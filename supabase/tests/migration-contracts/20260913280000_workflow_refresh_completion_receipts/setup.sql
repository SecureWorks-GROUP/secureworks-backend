-- The 260000 contract setup creates the pre-migration Refresh schema and
-- source fixture. Keep this setup additive so the runner applies both cases
-- in timestamp order.
SELECT 1;

-- Minimal shape of the existing Dispatch output seam. The contract calls this
-- fixture's assess writer, rather than inserting a command row by hand, so a
-- receipt must resolve to a persisted versioned domain result.
CREATE TABLE IF NOT EXISTS public.dispatch_plans (
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  version bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_version text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, job_id)
);

CREATE TABLE IF NOT EXISTS public.dispatch_commands (
  org_id uuid NOT NULL,
  request_id uuid NOT NULL,
  job_id uuid NOT NULL,
  request_hash text NOT NULL,
  actor text NOT NULL,
  command text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, request_id)
);

ALTER TABLE public.dispatch_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY dispatch_refresh_test_plans_service ON public.dispatch_plans
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY dispatch_refresh_test_commands_service ON public.dispatch_commands
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.dispatch_plans,public.dispatch_commands FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.dispatch_plans,public.dispatch_commands TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_commit(
  p_org uuid,p_job uuid,p_expected bigint,p_request uuid,p_hash text,p_actor text,
  p_command text,p_source text,p_state jsonb,p_lots jsonb DEFAULT '[]'::jsonb,
  p_task jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE current_plan public.dispatch_plans; result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id=p_job AND org_id=p_org)
  THEN RAISE EXCEPTION 'job_not_found'; END IF;
  IF public.dispatch_source_version(p_org,p_job) IS DISTINCT FROM p_source
  THEN RAISE EXCEPTION 'source_conflict'; END IF;
  INSERT INTO public.dispatch_plans(org_id,job_id) VALUES(p_org,p_job)
    ON CONFLICT (org_id,job_id) DO NOTHING;
  SELECT * INTO current_plan FROM public.dispatch_plans
   WHERE org_id=p_org AND job_id=p_job FOR UPDATE;
  IF current_plan.version IS DISTINCT FROM p_expected
  THEN RAISE EXCEPTION 'version_conflict'; END IF;
  UPDATE public.dispatch_plans
     SET version=version+1,state=p_state,source_version=p_source,updated_at=now()
   WHERE org_id=p_org AND job_id=p_job
   RETURNING * INTO current_plan;
  result := jsonb_build_object(
    'version',current_plan.version,'source_version',current_plan.source_version,
    'state',current_plan.state,'live_actions_enabled',false
  );
  INSERT INTO public.dispatch_commands(
    org_id,request_id,job_id,request_hash,actor,command,result
  ) VALUES(p_org,p_request,p_job,p_hash,p_actor,p_command,result);
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.dispatch_commit(uuid,uuid,bigint,uuid,text,text,text,text,jsonb,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_commit(uuid,uuid,bigint,uuid,text,text,text,text,jsonb,jsonb,jsonb)
  TO service_role;
