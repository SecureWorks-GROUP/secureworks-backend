-- Approved sends: a stored record of the owner's approval for one exact email
-- or SMS, and an append-only audit of everything that happened to it.
--
-- Additive only. Two new tables, their guard functions and triggers. No
-- existing table, column, function or policy is touched, so no deployed
-- function reads or writes anything this migration changes. Rollback:
-- supabase/rollbacks/20260929100000_approved_send_approvals_down.sql.
--
-- Contract (owned by supabase/functions/_shared/approved_send.ts):
--   * approved_send_approvals holds one row per approval. Everything that
--     defines WHAT may be sent (channel, payload, payload_hash, seal, the
--     owner's words, who recorded it, expiry) is immutable once written.
--   * status moves one way only: approved -> sending -> sent | failed |
--     outcome_unknown. An approval can never return to approved, so it can
--     be consumed by exactly one send.
--   * Rows are never deleted.
--   * approved_send_audit is append-only: no update, no delete.
--   * Both tables are closed to anon and authenticated (RLS on, no policy,
--     privileges revoked). Only the service role reaches them.

CREATE TABLE IF NOT EXISTS public.approved_send_approvals (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  schema_version text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  approved_by text NOT NULL CHECK (length(btrim(approved_by)) > 0),
  approved_at timestamptz NOT NULL,
  approval_words text NOT NULL CHECK (length(btrim(approval_words)) > 0),
  approval_source text NOT NULL CHECK (length(btrim(approval_source)) > 0),
  recorded_by_actor text NOT NULL CHECK (length(btrim(recorded_by_actor)) > 0),
  recorded_via text NOT NULL CHECK (length(btrim(recorded_via)) > 0),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  seal text NOT NULL CHECK (seal ~ '^hmac-sha256:[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'sending', 'sent', 'failed', 'outcome_unknown')),
  claimed_at timestamptz,
  claim_token uuid,
  outcome_at timestamptz,
  outcome_code text,
  provider_message_id text,
  provider_detail jsonb,
  CHECK (expires_at > approved_at)
);

CREATE INDEX IF NOT EXISTS approved_send_approvals_status_idx
  ON public.approved_send_approvals (status, expires_at);

CREATE TABLE IF NOT EXISTS public.approved_send_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Deliberately no foreign key: a refused send for an unknown approval id is
  -- still audited, under the id that was asked for.
  approval_id uuid,
  event text NOT NULL CHECK (event IN (
    'recorded', 'record_refused', 'send_refused', 'claimed', 'sent',
    'failed', 'outcome_unknown'
  )),
  channel text,
  actor text,
  credential_class text,
  code text,
  payload_hash text,
  provider_message_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS approved_send_audit_approval_idx
  ON public.approved_send_audit (approval_id, occurred_at);

-- Immutability and one-way status for approvals.
CREATE OR REPLACE FUNCTION public.approved_send_approvals_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approved_send_approvals rows are never deleted'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.approval_words IS DISTINCT FROM OLD.approval_words
    OR NEW.approval_source IS DISTINCT FROM OLD.approval_source
    OR NEW.recorded_by_actor IS DISTINCT FROM OLD.recorded_by_actor
    OR NEW.recorded_via IS DISTINCT FROM OLD.recorded_via
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.seal IS DISTINCT FROM OLD.seal
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'approved_send_approvals: the approved content is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'approved' AND NEW.status = 'sending' THEN
      IF NEW.claimed_at IS NULL OR NEW.claim_token IS NULL THEN
        RAISE EXCEPTION 'approved_send_approvals: a claim needs claimed_at and claim_token'
          USING ERRCODE = '23514';
      END IF;
      IF OLD.expires_at <= now() THEN
        RAISE EXCEPTION 'approved_send_approvals: the approval has expired'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'sending'
      AND NEW.status IN ('sent', 'failed', 'outcome_unknown') THEN
      IF NEW.claim_token IS DISTINCT FROM OLD.claim_token
        OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
        RAISE EXCEPTION 'approved_send_approvals: the claim is immutable'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'approved_send_approvals: status % -> % is not allowed',
        OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
    OR NEW.outcome_at IS DISTINCT FROM OLD.outcome_at
    OR NEW.outcome_code IS DISTINCT FROM OLD.outcome_code
    OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
    OR NEW.provider_detail IS DISTINCT FROM OLD.provider_detail
  THEN
    RAISE EXCEPTION 'approved_send_approvals: claim and outcome change only with status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approved_send_approvals_guard ON public.approved_send_approvals;
CREATE TRIGGER approved_send_approvals_guard
  BEFORE UPDATE OR DELETE ON public.approved_send_approvals
  FOR EACH ROW EXECUTE FUNCTION public.approved_send_approvals_guard();

-- A new approval always starts unclaimed.
CREATE OR REPLACE FUNCTION public.approved_send_approvals_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved'
    OR NEW.claimed_at IS NOT NULL OR NEW.claim_token IS NOT NULL
    OR NEW.outcome_at IS NOT NULL OR NEW.outcome_code IS NOT NULL
    OR NEW.provider_message_id IS NOT NULL OR NEW.provider_detail IS NOT NULL
  THEN
    RAISE EXCEPTION 'approved_send_approvals: a new approval must start unclaimed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS approved_send_approvals_insert_guard ON public.approved_send_approvals;
CREATE TRIGGER approved_send_approvals_insert_guard
  BEFORE INSERT ON public.approved_send_approvals
  FOR EACH ROW EXECUTE FUNCTION public.approved_send_approvals_insert_guard();

-- The audit is append-only.
CREATE OR REPLACE FUNCTION public.approved_send_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'approved_send_audit is append-only'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS approved_send_audit_append_only ON public.approved_send_audit;
CREATE TRIGGER approved_send_audit_append_only
  BEFORE UPDATE OR DELETE ON public.approved_send_audit
  FOR EACH ROW EXECUTE FUNCTION public.approved_send_audit_append_only();

ALTER TABLE public.approved_send_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approved_send_audit ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.approved_send_approvals FROM anon';
    EXECUTE 'REVOKE ALL ON public.approved_send_audit FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.approved_send_approvals FROM authenticated';
    EXECUTE 'REVOKE ALL ON public.approved_send_audit FROM authenticated';
  END IF;
END;
$$;

COMMENT ON TABLE public.approved_send_approvals IS
  'One stored owner approval for one exact email or SMS. Content immutable; status one-way; single use. Owner: supabase/functions/_shared/approved_send.ts.';
COMMENT ON TABLE public.approved_send_audit IS
  'Append-only audit of approved sends: recorded, refused, claimed, sent, failed, outcome_unknown.';
