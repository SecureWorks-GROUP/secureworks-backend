\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.organisations (id, name)
VALUES ('00000000-0000-4000-8000-000000000409', 'ZZTEST organisation') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, org_id, name, role)
VALUES ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000409', 'admin', 'admin') ON CONFLICT (id) DO NOTHING;
DO $$
DECLARE
  proposal uuid;
  expired uuid;
  expired_count integer;
  claimed public.agent_action_proposals;
  operator_id uuid := '00000000-0000-4000-8000-000000000401';
BEGIN
  INSERT INTO public.agent_action_proposals(actor, auth_mode, action, params, params_sha256, kind, summary)
  VALUES ('agent:test', 'api_key', 'reconcile_payment', '{}', 'pending-fixture', 'xero_payment', 'Record the requested payment.') RETURNING id INTO proposal;
  BEGIN
    INSERT INTO public.agent_action_proposals(actor, auth_mode, action, params, params_sha256, kind, summary)
    VALUES ('agent:test', 'api_key', 'reconcile_payment', '{}', 'pending-fixture', 'xero_payment', 'Record the requested payment.');
    RAISE EXCEPTION 'proposal contract: duplicate pending accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  SELECT * INTO claimed FROM public.agent_action_proposal_claim(proposal, operator_id);
  IF claimed.id IS DISTINCT FROM proposal OR claimed.status <> 'carrying_out' OR claimed.decided_by IS DISTINCT FROM operator_id OR claimed.decided_at IS NULL THEN
    RAISE EXCEPTION 'proposal contract: first claim failed';
  END IF;
  SELECT * INTO claimed FROM public.agent_action_proposal_claim(proposal, operator_id);
  IF claimed.id IS NOT NULL THEN RAISE EXCEPTION 'proposal contract: second claim accepted'; END IF;
  INSERT INTO public.agent_action_proposals(actor, auth_mode, action, params, params_sha256, kind, summary, expires_at)
  VALUES ('agent:test', 'api_key', 'reconcile_payment', '{}', 'expired-fixture', 'xero_payment', 'Record the requested payment.', now() - interval '1 day') RETURNING id INTO expired;
  SELECT * INTO claimed FROM public.agent_action_proposal_claim(expired, operator_id);
  IF claimed.id IS NOT NULL THEN RAISE EXCEPTION 'proposal contract: expired claim accepted'; END IF;
  expired_count := public.agent_action_proposals_expire();
  IF expired_count <> 1 OR (SELECT status FROM public.agent_action_proposals WHERE id = expired) <> 'expired' THEN
    RAISE EXCEPTION 'proposal contract: expiry failed';
  END IF;
  BEGIN
    INSERT INTO public.agent_action_proposals(actor, auth_mode, action, params, params_sha256, kind, summary)
    VALUES ('agent:test', 'api_key', 'unknown', '{}', 'invalid-fixture', 'other', 'Unknown action.');
    RAISE EXCEPTION 'proposal contract: unknown kind accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.agent_action_proposals'::regclass)
     OR has_table_privilege('anon', 'public.agent_action_proposals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.agent_action_proposals', 'UPDATE')
     OR has_function_privilege('authenticated', 'public.agent_action_proposal_claim(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.agent_action_proposal_claim(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'proposal contract: access boundary failed';
  END IF;
END $$;
ROLLBACK;
