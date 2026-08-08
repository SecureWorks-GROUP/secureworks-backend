-- Echo-code approval state. This is the one attempt-limit table authorised by
-- the ticket: request rows hold one issued code and lock rows carry the
-- sender-scoped failure window across requests.
CREATE TABLE IF NOT EXISTS public.ses_channel_approval_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type text NOT NULL CHECK (record_type IN ('request', 'lockout')),
  org_id uuid,
  job_id uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
  request_id uuid UNIQUE,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  sender_fingerprint text NOT NULL CHECK (sender_fingerprint ~ '^[0-9a-f]{64}$'),
  message_hash text CHECK (message_hash IS NULL OR message_hash ~ '^sha256:[0-9a-f]{64}$'),
  code_hash text CHECK (code_hash IS NULL OR code_hash ~ '^sha256:[0-9a-f]{64}$'),
  issued_at timestamptz,
  expires_at timestamptz,
  consumed_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((record_type = 'request' AND request_id IS NOT NULL AND org_id IS NOT NULL AND job_id IS NOT NULL AND message_hash IS NOT NULL AND code_hash IS NOT NULL AND issued_at IS NOT NULL AND expires_at IS NOT NULL)
      OR (record_type = 'lockout' AND request_id IS NULL AND org_id IS NULL AND job_id IS NULL AND message_hash IS NULL AND code_hash IS NULL AND issued_at IS NULL AND expires_at IS NULL)),
  CHECK ((record_type = 'request' AND failed_attempts = 0 AND locked_until IS NULL)
      OR record_type = 'lockout')
);

CREATE UNIQUE INDEX IF NOT EXISTS ses_channel_approval_lockout_identity
  ON public.ses_channel_approval_attempts (channel, sender_fingerprint)
  WHERE record_type = 'lockout';
CREATE INDEX IF NOT EXISTS ses_channel_approval_request_lookup
  ON public.ses_channel_approval_attempts (request_id)
  WHERE record_type = 'request';

CREATE OR REPLACE FUNCTION public.issue_ses_channel_approval_request(
  p_org_id uuid,
  p_job_id uuid,
  p_channel text,
  p_sender_fingerprint text,
  p_request_id uuid,
  p_message_hash text,
  p_code_hash text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
) RETURNS TABLE(request_id uuid, expires_at timestamptz, locked_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  lock_row public.ses_channel_approval_attempts;
BEGIN
  INSERT INTO public.ses_channel_approval_attempts (record_type, channel, sender_fingerprint)
  VALUES ('lockout', p_channel, p_sender_fingerprint)
  ON CONFLICT (channel, sender_fingerprint) WHERE record_type = 'lockout' DO NOTHING;

  SELECT * INTO lock_row
  FROM public.ses_channel_approval_attempts
  WHERE record_type = 'lockout'
    AND channel = p_channel
    AND sender_fingerprint = p_sender_fingerprint
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ses_channel_approval_lockout_row_missing';
  END IF;
  IF lock_row.locked_until IS NOT NULL AND lock_row.locked_until > p_issued_at THEN
    RETURN QUERY SELECT NULL::uuid, p_expires_at, lock_row.locked_until;
    RETURN;
  END IF;
  IF lock_row.locked_until IS NOT NULL AND lock_row.locked_until <= p_issued_at THEN
    UPDATE public.ses_channel_approval_attempts
    SET failed_attempts = 0, locked_until = NULL
    WHERE id = lock_row.id;
  END IF;

  INSERT INTO public.ses_channel_approval_attempts (
    record_type, org_id, job_id, request_id, channel, sender_fingerprint,
    message_hash, code_hash, issued_at, expires_at
  ) VALUES (
    'request', p_org_id, p_job_id, p_request_id, p_channel, p_sender_fingerprint,
    p_message_hash, p_code_hash, p_issued_at, p_expires_at
  );
  RETURN QUERY SELECT p_request_id, p_expires_at, NULL::timestamptz;
END;
$$;

DROP FUNCTION IF EXISTS public.consume_ses_channel_approval_code(uuid, text, text, text, text, timestamptz, integer, interval);

-- The issued org and job are returned so the caller approves what was ISSUED.
-- The relay supplies its own org on the transport body; it must never be the
-- org persisted on the money-approval ledger row.
CREATE OR REPLACE FUNCTION public.consume_ses_channel_approval_code(
  p_request_id uuid,
  p_channel text,
  p_sender_fingerprint text,
  p_message_hash text,
  p_code_hash text,
  p_now timestamptz,
  p_lockout_threshold integer DEFAULT 3,
  p_lockout_window interval DEFAULT interval '15 minutes'
) RETURNS TABLE(accepted boolean, reason text, failed_attempts integer, locked_until timestamptz, org_id uuid, job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  request_row public.ses_channel_approval_attempts;
  lock_row public.ses_channel_approval_attempts;
  is_match boolean;
BEGIN
  SELECT * INTO request_row
  FROM public.ses_channel_approval_attempts
  WHERE record_type = 'request' AND request_id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'invalid'::text, 0, NULL::timestamptz, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  -- The presenting sender must BE the enrolled sender this request was issued
  -- to. Anybody else's attempt is somebody else's act: it must neither consume
  -- the captain's pending request nor move any failure counter, or holding the
  -- relay key alone would be a denial-of-approval instrument.
  IF request_row.channel IS DISTINCT FROM p_channel
     OR request_row.sender_fingerprint IS DISTINCT FROM p_sender_fingerprint THEN
    RETURN QUERY SELECT false, 'sender_mismatch'::text, 0, NULL::timestamptz, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT * INTO lock_row
  FROM public.ses_channel_approval_attempts
  WHERE record_type = 'lockout'
    AND channel = request_row.channel
    AND sender_fingerprint = request_row.sender_fingerprint
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ses_channel_approval_lockout_row_missing';
  END IF;

  IF request_row.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'already_used'::text, lock_row.failed_attempts, lock_row.locked_until, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  UPDATE public.ses_channel_approval_attempts SET consumed_at = p_now WHERE id = request_row.id;

  IF lock_row.locked_until IS NOT NULL AND lock_row.locked_until > p_now THEN
    RETURN QUERY SELECT false, 'locked'::text, lock_row.failed_attempts, lock_row.locked_until, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF request_row.expires_at <= p_now THEN
    RETURN QUERY SELECT false, 'expired'::text, lock_row.failed_attempts, lock_row.locked_until, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  is_match := request_row.message_hash = p_message_hash
    AND request_row.code_hash = p_code_hash;
  IF NOT is_match THEN
    -- Qualified through the alias because failed_attempts and locked_until are
    -- also RETURNS TABLE output variables: an unqualified read of either raises
    -- "column reference is ambiguous" and would roll back the consume above,
    -- leaving the request neither spent nor counted.
    UPDATE public.ses_channel_approval_attempts AS a
    SET failed_attempts = a.failed_attempts + 1,
        locked_until = CASE WHEN a.failed_attempts + 1 >= p_lockout_threshold
          THEN p_now + p_lockout_window ELSE a.locked_until END
    WHERE a.id = lock_row.id;
    SELECT * INTO lock_row FROM public.ses_channel_approval_attempts WHERE id = lock_row.id;
    RETURN QUERY SELECT false,
      CASE WHEN lock_row.locked_until IS NOT NULL AND lock_row.locked_until > p_now THEN 'locked' ELSE 'invalid' END,
      lock_row.failed_attempts, lock_row.locked_until, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  UPDATE public.ses_channel_approval_attempts
  SET failed_attempts = 0, locked_until = NULL
  WHERE id = lock_row.id;
  RETURN QUERY SELECT true, 'accepted'::text, 0, NULL::timestamptz, request_row.org_id, request_row.job_id;
END;
$$;

-- Single-use lives in consumed_at and lockout lives in the lockout row, so the
-- table itself is the invariant. Nothing outside service_role may read or write
-- it: an anon UPDATE clearing consumed_at would make an observed approval
-- message replayable, and deleting a lockout row would restore unlimited
-- guessing.
ALTER TABLE public.ses_channel_approval_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ses_channel_approval_attempts_service_role_only
  ON public.ses_channel_approval_attempts;
CREATE POLICY ses_channel_approval_attempts_service_role_only
  ON public.ses_channel_approval_attempts
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.ses_channel_approval_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ses_channel_approval_attempts TO service_role;
REVOKE ALL ON FUNCTION public.issue_ses_channel_approval_request(uuid, uuid, text, text, uuid, text, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_ses_channel_approval_code(uuid, text, text, text, text, timestamptz, integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_ses_channel_approval_request(uuid, uuid, text, text, uuid, text, text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_ses_channel_approval_code(uuid, text, text, text, text, timestamptz, integer, interval) TO service_role;
