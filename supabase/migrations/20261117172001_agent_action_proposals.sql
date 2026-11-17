-- P4-09.1: stored requests only. This migration carries out no money action.
CREATE TABLE IF NOT EXISTS public.agent_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  auth_mode text NOT NULL,
  action text NOT NULL,
  http_method text NOT NULL DEFAULT 'POST' CHECK (http_method IN ('GET','POST')),
  params jsonb NOT NULL,
  params_sha256 text NOT NULL,
  job_id uuid,
  kind text NOT NULL CHECK (kind IN ('xero_approve','xero_void','xero_payment','customer_invoice','send','order','expense','variation','work_order_state')),
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('observed','pending','carrying_out','carried_out','declined','expired','failed')),
  decided_by uuid REFERENCES public.users(id),
  decided_at timestamptz,
  decline_reason text,
  result jsonb,
  error text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_action_proposals_one_pending
  ON public.agent_action_proposals (action, params_sha256) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agent_action_proposals_status_at
  ON public.agent_action_proposals (status, created_at DESC);
ALTER TABLE public.agent_action_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_action_proposals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_action_proposals TO service_role;

CREATE OR REPLACE FUNCTION public.agent_action_proposal_claim(p_id uuid, p_user uuid)
RETURNS public.agent_action_proposals
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE public.agent_action_proposals
  SET status = 'carrying_out', decided_by = p_user, decided_at = now()
  WHERE id = p_id AND status = 'pending' AND expires_at > now()
  RETURNING *;
$$;
REVOKE ALL ON FUNCTION public.agent_action_proposal_claim(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_action_proposal_claim(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.agent_action_proposals_expire()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  DECLARE affected integer;
  BEGIN
    UPDATE public.agent_action_proposals SET status = 'expired'
    WHERE status = 'pending' AND expires_at <= now();
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
  END;
$$;
REVOKE ALL ON FUNCTION public.agent_action_proposals_expire() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_action_proposals_expire() TO service_role;
