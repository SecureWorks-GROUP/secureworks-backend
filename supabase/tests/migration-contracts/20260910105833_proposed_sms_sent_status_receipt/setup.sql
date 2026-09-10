-- Synthetic subset of the schema verified read-only in production.
CREATE TABLE public.ai_proposed_actions (
  proposal_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  action_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  job_id uuid,
  contact_id text,
  contact_phone text,
  drafted_message text,
  sent_at timestamptz,
  CONSTRAINT ai_proposed_actions_status_check CHECK (
    status IN ('pending', 'auto_approved', 'approved', 'rejected', 'expired')
  )
);
INSERT INTO public.ai_proposed_actions (proposal_id, status, action_payload)
VALUES ('11111111-1111-4111-8111-111111111111', 'approved', '{"fixture":"unchanged"}');
DO $$
BEGIN
  BEGIN
    UPDATE public.ai_proposed_actions SET status = 'sent';
    RAISE EXCEPTION 'legacy_fixture_should_refuse_sent';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$$;
