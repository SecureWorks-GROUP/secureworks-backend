-- Persisted message work-links with correction audit + invalidation,
-- and an executable scoped workflow refresh run (manual/cloud/UI).

CREATE TABLE IF NOT EXISTS public.message_work_links (
  event_id uuid NOT NULL REFERENCES public.business_events(id),
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('job','po','invoice')),
  target_id text NOT NULL,
  certainty text NOT NULL CHECK (certainty IN ('explicit','thread','unresolved')),
  lifecycle text NOT NULL DEFAULT 'current' CHECK (lifecycle IN ('current','retracted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, kind, target_id)
);
CREATE TABLE IF NOT EXISTS public.message_work_link_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  org_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('link','unlink')),
  kind text NOT NULL,
  target_id text NOT NULL,
  actor text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS public.workflow_refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow text NOT NULL,
  scope jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','partial','failed')),
  source_cutoff timestamptz,
  requested_by text NOT NULL,
  lease_token uuid,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_refresh_runs_active
  ON public.workflow_refresh_runs (workflow, (scope::text))
  WHERE status IN ('queued','running');

ALTER TABLE public.message_work_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_work_link_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_refresh_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_work_links, public.message_work_link_audit, public.workflow_refresh_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.message_work_links, public.message_work_link_audit, public.workflow_refresh_runs TO service_role;

CREATE OR REPLACE FUNCTION public.correct_message_work_link(
  p_event_id uuid, p_org_id uuid, p_op text, p_kind text, p_target_id text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invalidated int:=0;
BEGIN
  IF p_op NOT IN ('link','unlink') OR p_kind NOT IN ('job','po','invoice') OR p_event_id IS NULL OR p_org_id IS NULL
  THEN RAISE EXCEPTION 'message_link_invalid'; END IF;
  IF p_op='unlink' THEN
    UPDATE public.message_work_links SET lifecycle='retracted'
     WHERE event_id=p_event_id AND kind=p_kind AND target_id=p_target_id AND org_id=p_org_id AND lifecycle='current';
    IF NOT FOUND THEN RAISE EXCEPTION 'message_link_missing'; END IF;
    IF p_kind='job' THEN
      UPDATE public.job_context SET lifecycle='retracted', lifecycle_reason='message_link_correction', updated_at=now()
       WHERE job_id::text=p_target_id AND lifecycle='current' AND p_event_id=ANY(source_event_ids);
      GET DIAGNOSTICS invalidated = ROW_COUNT;
    END IF;
  ELSE
    INSERT INTO public.message_work_links(event_id,org_id,kind,target_id,certainty,lifecycle)
     VALUES(p_event_id,p_org_id,p_kind,p_target_id,'explicit','current')
     ON CONFLICT (event_id,kind,target_id) DO UPDATE SET lifecycle='current', certainty='explicit';
  END IF;
  INSERT INTO public.message_work_link_audit(event_id,org_id,op,kind,target_id,actor,detail)
   VALUES(p_event_id,p_org_id,p_op,p_kind,p_target_id,p_actor,jsonb_build_object('invalidated_facts',invalidated));
  RETURN jsonb_build_object('ok',true,'invalidated_facts',invalidated,'op',p_op);
END $$;

CREATE OR REPLACE FUNCTION public.start_workflow_refresh(p_workflow text, p_scope jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing public.workflow_refresh_runs; created public.workflow_refresh_runs;
BEGIN
  IF p_workflow IS NULL OR jsonb_typeof(p_scope) IS DISTINCT FROM 'object' OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  SELECT * INTO existing FROM public.workflow_refresh_runs
   WHERE workflow=p_workflow AND scope=p_scope AND status IN ('queued','running')
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome','joined','id',existing.id,'status',existing.status);
  END IF;
  INSERT INTO public.workflow_refresh_runs(workflow,scope,status,requested_by,lease_token)
   VALUES(p_workflow,p_scope,'queued',p_actor,gen_random_uuid())
   RETURNING * INTO created;
  RETURN jsonb_build_object('outcome','started','id',created.id,'status',created.status);
END $$;

CREATE OR REPLACE FUNCTION public.finish_workflow_refresh(p_id uuid, p_status text, p_result jsonb, p_cutoff timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_status NOT IN ('completed','partial','failed') THEN RAISE EXCEPTION 'workflow_refresh_invalid'; END IF;
  UPDATE public.workflow_refresh_runs
   SET status=p_status, result=p_result, source_cutoff=p_cutoff, updated_at=now()
   WHERE id=p_id AND status IN ('queued','running');
  IF NOT FOUND THEN RAISE EXCEPTION 'workflow_refresh_not_active'; END IF;
  RETURN jsonb_build_object('ok',true,'id',p_id,'status',p_status);
END $$;

REVOKE ALL ON FUNCTION public.correct_message_work_link(uuid,uuid,text,text,text,text),
 public.start_workflow_refresh(text,jsonb,text),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.correct_message_work_link(uuid,uuid,text,text,text,text),
 public.start_workflow_refresh(text,jsonb,text),
 public.finish_workflow_refresh(uuid,text,jsonb,timestamptz) TO service_role;
