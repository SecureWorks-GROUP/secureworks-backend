-- Debt follow-up exact-approval ledger (debt review PR 5).
-- Contract: docs/debt-followup-approval.md; code:
-- supabase/functions/ops-api/debt_followup_approval.ts.
--
-- debt_followup_approvals   one row per captain approval of ONE exact debtor
--                           text or invoice email: body hash, destination,
--                           selected invoice ids, subject/attachment, Xero
--                           snapshot, hold state and expiry. Insert only.
-- debt_followup_executions  every press. Dry-run and refused rows append
--                           freely. A live row is claimed (outcome sending)
--                           before the provider call; at most ONE live row per
--                           approval, ever; it settles once to sent, failed or
--                           unknown. A sent row carries provider proof.
--
-- Adds two tables, two trigger functions and their triggers. Writes no row,
-- changes no switch, touches no Xero, invoice or payment data. service_role
-- only. Rollback: supabase/rollbacks/20260924213000_debt_followup_approvals_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Pre-image guard: absent, or already exactly this shape (a re-apply).
DO $$
DECLARE
  col record;
  tbl text;
  expected jsonb;
  shapes constant jsonb := jsonb_build_object(
    'debt_followup_approvals', jsonb_build_object(
      'approval_id', 'text|NO', 'binding_hash', 'text|NO', 'contract', 'text|NO',
      'kind', 'text|NO', 'channel', 'text|NO', 'xero_invoice_ids', 'ARRAY|NO',
      'request', 'jsonb|NO', 'proposal', 'jsonb|NO', 'body_sha256', 'text|NO',
      'approved_by_email', 'text|NO',
      'approved_at', 'timestamp with time zone|NO',
      'expires_at', 'timestamp with time zone|NO',
      'created_at', 'timestamp with time zone|NO'
    ),
    'debt_followup_executions', jsonb_build_object(
      'id', 'uuid|NO', 'approval_id', 'text|YES', 'binding_hash', 'text|YES',
      'kind', 'text|NO', 'channel', 'text|NO', 'mode', 'text|NO',
      'outcome', 'text|NO', 'reason', 'text|YES', 'press_token', 'uuid|YES',
      'pressed_by', 'text|NO', 'source_action', 'text|NO', 'proposal', 'jsonb|YES',
      'provider', 'text|YES', 'provider_message_id', 'text|YES',
      'provider_proof', 'jsonb|YES',
      'created_at', 'timestamp with time zone|NO',
      'finished_at', 'timestamp with time zone|YES'
    )
  );
BEGIN
  FOR tbl IN SELECT jsonb_object_keys(shapes) LOOP
    CONTINUE WHEN to_regclass('public.' || tbl) IS NULL;
    expected := shapes -> tbl;
    FOR col IN
      SELECT column_name, data_type || '|' || is_nullable AS shape
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl
    LOOP
      IF NOT expected ? col.column_name THEN
        RAISE EXCEPTION '%: unexpected column %', tbl, col.column_name;
      END IF;
      IF expected ->> col.column_name IS DISTINCT FROM col.shape THEN
        RAISE EXCEPTION '%: column % type drift', tbl, col.column_name;
      END IF;
    END LOOP;
    FOR col IN SELECT jsonb_object_keys(expected) AS column_name LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = tbl
          AND column_name = col.column_name
      ) THEN
        RAISE EXCEPTION '%: missing column %', tbl, col.column_name;
      END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.debt_followup_approvals (
  approval_id text PRIMARY KEY CHECK (approval_id ~ '^[a-f0-9]{64}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  contract text NOT NULL CHECK (contract = 'debt-followup-approval/v1'),
  kind text NOT NULL CHECK (
    kind IN ('chase_sms', 'payment_link_sms', 'thank_you_sms', 'invoice_email')
  ),
  channel text NOT NULL CHECK (
    (channel = 'email') = (kind = 'invoice_email') AND channel IN ('sms', 'email')
  ),
  xero_invoice_ids text[] NOT NULL CHECK (
    cardinality(xero_invoice_ids) BETWEEN 1 AND 20
  ),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal) = 'object'),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  approved_by_email text NOT NULL CHECK (length(approved_by_email) BETWEEN 3 AND 320),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > approved_at),
  CHECK ((proposal ->> 'body_sha256') IS NOT DISTINCT FROM body_sha256)
);

CREATE INDEX IF NOT EXISTS idx_debt_followup_approvals_binding
  ON public.debt_followup_approvals (binding_hash, expires_at DESC);

CREATE TABLE IF NOT EXISTS public.debt_followup_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id text REFERENCES public.debt_followup_approvals (approval_id),
  binding_hash text CHECK (binding_hash IS NULL OR binding_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (
    kind IN ('chase_sms', 'payment_link_sms', 'thank_you_sms', 'invoice_email')
  ),
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  mode text NOT NULL CHECK (mode IN ('dry_run', 'live')),
  outcome text NOT NULL CHECK (
    (mode = 'dry_run' AND outcome IN ('dry_run', 'refused')) OR
    (mode = 'live' AND outcome IN ('sending', 'sent', 'failed', 'unknown'))
  ),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  press_token uuid,
  pressed_by text NOT NULL CHECK (length(pressed_by) BETWEEN 1 AND 320),
  source_action text NOT NULL CHECK (length(source_action) BETWEEN 1 AND 100),
  proposal jsonb CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object'),
  provider text CHECK (provider IS NULL OR provider IN ('ghl', 'outlook')),
  provider_message_id text,
  provider_proof jsonb CHECK (
    provider_proof IS NULL OR jsonb_typeof(provider_proof) = 'object'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- A live row is always a press of a recorded approval.
  CHECK (mode <> 'live' OR (approval_id IS NOT NULL AND binding_hash IS NOT NULL AND press_token IS NOT NULL)),
  -- Only a live row is ever open; everything else is finished when written.
  CHECK ((outcome = 'sending') = (finished_at IS NULL)),
  -- A confirmed send carries provider proof; an SMS also its provider message id.
  CHECK (outcome <> 'sent' OR (provider IS NOT NULL AND provider_proof IS NOT NULL)),
  CHECK (outcome <> 'sent' OR channel <> 'sms' OR coalesce(length(provider_message_id), 0) > 0),
  CHECK (outcome = 'sent' OR provider_message_id IS NULL)
);

-- One approval sends at most once: at most one live row per approval, ever.
CREATE UNIQUE INDEX IF NOT EXISTS debt_followup_executions_one_live
  ON public.debt_followup_executions (approval_id) WHERE mode = 'live';
CREATE INDEX IF NOT EXISTS idx_debt_followup_executions_binding
  ON public.debt_followup_executions (binding_hash, created_at DESC);

CREATE OR REPLACE FUNCTION public.debt_followup_approvals_insert_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'debt_followup_approvals: an approval is never changed or deleted';
END $$;

CREATE OR REPLACE FUNCTION public.debt_followup_executions_settle_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'debt_followup_executions: a press record is never deleted';
  END IF;
  IF OLD.mode <> 'live' OR OLD.outcome <> 'sending' OR
     NEW.outcome NOT IN ('sent', 'failed', 'unknown') OR
     NEW.id <> OLD.id OR
     NEW.approval_id IS DISTINCT FROM OLD.approval_id OR
     NEW.binding_hash IS DISTINCT FROM OLD.binding_hash OR
     NEW.kind <> OLD.kind OR NEW.channel <> OLD.channel OR NEW.mode <> OLD.mode OR
     NEW.press_token IS DISTINCT FROM OLD.press_token OR
     NEW.pressed_by <> OLD.pressed_by OR
     NEW.source_action <> OLD.source_action OR
     NEW.proposal IS DISTINCT FROM OLD.proposal OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'debt_followup_executions: a send outcome settles once';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'debt_followup_approvals'
      AND t.tgname = 'debt_followup_approvals_insert_only' AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER debt_followup_approvals_insert_only
      BEFORE UPDATE OR DELETE ON public.debt_followup_approvals
      FOR EACH ROW EXECUTE FUNCTION public.debt_followup_approvals_insert_only();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'debt_followup_executions'
      AND t.tgname = 'debt_followup_executions_settle_once' AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER debt_followup_executions_settle_once
      BEFORE UPDATE OR DELETE ON public.debt_followup_executions
      FOR EACH ROW EXECUTE FUNCTION public.debt_followup_executions_settle_once();
  END IF;
END $$;

ALTER TABLE public.debt_followup_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_followup_executions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.debt_followup_approvals FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.debt_followup_executions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.debt_followup_approvals TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.debt_followup_executions TO service_role;
REVOKE ALL ON FUNCTION public.debt_followup_approvals_insert_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.debt_followup_executions_settle_once() FROM PUBLIC;

COMMENT ON TABLE public.debt_followup_approvals IS
  'Captain approvals of one exact debtor text or invoice email (body hash, destination, invoice ids, subject/attachment, Xero snapshot, hold state, expiry). Insert only. Contract: docs/debt-followup-approval.md.';
COMMENT ON TABLE public.debt_followup_executions IS
  'Every debt follow-up press. Dry-run/refused rows append; at most one live row per approval, claimed before the provider call and settled once; a sent row carries provider proof. Never deleted.';
