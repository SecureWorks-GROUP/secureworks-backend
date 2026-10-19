-- Outbound send claims: one hold per item a send may deliver, taken before the
-- send and kept until the outcome is known.
--
-- Why. An email whose outcome is unknown (a lost reply, a timeout, a 5xx after
-- the provider may have acted) may already have reached the client. The callers
-- (invoice email, approved sends, debt statements and reports, the make-safe
-- pack, and the plain send-outlook-email door) used to decide "may I send?" by
-- reading their own history first and then sending. Two presses that landed
-- together both read "clear" and both sent, and a history write that failed
-- left nothing to read. A claim closes both: the row is written before the
-- send, atomically, and a second claim on the same item is refused while the
-- first is unresolved.
--
-- Rules.
-- * An item is a caller-chosen key (invoice:<xero id>, debt_report:<org>,
--   debt_statement:<customer>, makesafe_pack:<id>, approved_send:<payload hash>,
--   email_content:<sha256>). One attempt may hold several keys.
-- * A claim is refused while any of its keys is held by an attempt in state
--   sending or outcome_unknown (partial unique index: two concurrent claims
--   cannot both win).
-- * settle_outbound_send moves an attempt out of sending exactly once
--   (compare and set): sent, failed (definitely not sent) or outcome_unknown.
-- * Only reconcile_outbound_send releases an unresolved attempt, and only the
--   named attempt in the named state, recording who checked, when and what
--   they found. A live sending attempt inside its lease is never released; a
--   sending attempt past its lease is treated as unknown (its outcome write
--   may have failed) and needs the same explicit reconciliation.
-- * A confirmed sent does not block a deliberate later send. A later attempt
--   can never resolve an earlier one.
-- * Every claim, refusal, extension, settlement and reconciliation writes one
--   append-only outbound_send_claim_events row.
--
-- Service role only: RLS is on with no policy, and the browser roles hold no
-- privilege on the tables or the functions. Nothing is sent and no row is
-- written when this migration applies. Re-applying is a no-op.
-- Rollback: supabase/rollbacks/20261019170000_outbound_send_claims_down.sql.

CREATE TABLE IF NOT EXISTS public.outbound_send_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id text NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 200),
  item_key text NOT NULL CHECK (length(item_key) BETWEEN 1 AND 400),
  state text NOT NULL DEFAULT 'sending' CHECK (state IN (
    'sending', 'sent', 'failed', 'outcome_unknown', 'reconciled_sent', 'reconciled_not_sent'
  )),
  actor text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL,
  settled_at timestamptz,
  settled_detail jsonb,
  reconciled_by text,
  reconciled_at timestamptz,
  reconcile_checked_at timestamptz,
  reconcile_evidence text,
  CONSTRAINT outbound_send_claims_attempt_item_key UNIQUE (attempt_id, item_key)
);

-- At most one unresolved attempt per item: this is the atomic hold.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_send_claims_one_unresolved
  ON public.outbound_send_claims (item_key)
  WHERE state IN ('sending', 'outcome_unknown');
CREATE INDEX IF NOT EXISTS outbound_send_claims_attempt
  ON public.outbound_send_claims (attempt_id);

CREATE TABLE IF NOT EXISTS public.outbound_send_claim_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  attempt_id text NOT NULL,
  item_key text,
  event text NOT NULL CHECK (event IN (
    'claimed', 'claim_refused', 'extended', 'settled', 'settle_refused',
    'reconciled', 'reconcile_refused'
  )),
  from_state text,
  to_state text,
  actor text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS outbound_send_claim_events_attempt
  ON public.outbound_send_claim_events (attempt_id);

CREATE OR REPLACE FUNCTION public.outbound_send_claim_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'outbound_send_claim_events is append-only';
END $$;
DROP TRIGGER IF EXISTS outbound_send_claim_events_append_only ON public.outbound_send_claim_events;
CREATE TRIGGER outbound_send_claim_events_append_only
  BEFORE UPDATE OR DELETE ON public.outbound_send_claim_events
  FOR EACH ROW EXECUTE FUNCTION public.outbound_send_claim_events_append_only();

ALTER TABLE public.outbound_send_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_send_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_send_claims FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.outbound_send_claim_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.outbound_send_claim_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.outbound_send_claims TO service_role;
GRANT SELECT, INSERT ON public.outbound_send_claim_events TO service_role;
GRANT USAGE ON SEQUENCE public.outbound_send_claim_events_id_seq TO service_role;

-- The unresolved holds on any of p_keys (a stale sending row reads as stale).
CREATE OR REPLACE FUNCTION public.read_outbound_send_holds(p_keys text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'attempt_id', c.attempt_id,
      'item_key', c.item_key,
      'state', c.state,
      'stale', c.state = 'sending' AND c.lease_until < now(),
      'claimed_at', c.claimed_at,
      'lease_until', c.lease_until,
      'actor', c.actor
    ) ORDER BY c.claimed_at, c.item_key), '[]'::jsonb)
  FROM public.outbound_send_claims c
  WHERE c.item_key = ANY (p_keys)
    AND c.state IN ('sending', 'outcome_unknown')
$$;

-- Internal: insert claim rows for p_keys under p_attempt_id, all or none.
CREATE OR REPLACE FUNCTION public.outbound_send_claim_insert(
  p_keys text[], p_attempt_id text, p_actor text, p_detail jsonb, p_lease_seconds integer, p_event text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_keys text[];
  v_key text;
  v_held jsonb;
BEGIN
  SELECT array_agg(DISTINCT k ORDER BY k) INTO v_keys
    FROM unnest(p_keys) AS k WHERE k IS NOT NULL AND length(k) > 0;
  IF v_keys IS NULL OR p_attempt_id IS NULL OR length(p_attempt_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_invalid');
  END IF;
  BEGIN
    FOREACH v_key IN ARRAY v_keys LOOP
      IF EXISTS (SELECT 1 FROM public.outbound_send_claims
                  WHERE attempt_id = p_attempt_id AND item_key = v_key) THEN
        CONTINUE;
      END IF;
      INSERT INTO public.outbound_send_claims (attempt_id, item_key, state, actor, detail, lease_until)
      VALUES (p_attempt_id, v_key, 'sending', p_actor, coalesce(p_detail, '{}'::jsonb),
              now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 30)));
      INSERT INTO public.outbound_send_claim_events (attempt_id, item_key, event, to_state, actor, detail)
      VALUES (p_attempt_id, v_key, p_event, 'sending', p_actor, coalesce(p_detail, '{}'::jsonb));
    END LOOP;
  EXCEPTION WHEN unique_violation THEN
    -- Another attempt holds one of the keys: nothing of this claim is kept.
    v_held := public.read_outbound_send_holds(v_keys);
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, actor, detail)
    VALUES (p_attempt_id, 'claim_refused', p_actor,
            jsonb_build_object('keys', to_jsonb(v_keys), 'held', v_held));
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_held', 'held', v_held);
  END;
  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'keys', to_jsonb(v_keys));
END $$;

-- Claim p_keys for a new send attempt. Refused (nothing written but the refusal
-- event) while any key is held by an unresolved attempt.
CREATE OR REPLACE FUNCTION public.claim_outbound_send(
  p_keys text[], p_attempt_id text, p_actor text DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb, p_lease_seconds integer DEFAULT 600
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = p_attempt_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_attempt_exists');
  END IF;
  RETURN public.outbound_send_claim_insert(p_keys, p_attempt_id, p_actor, p_detail, p_lease_seconds, 'claimed');
END $$;

-- Add keys to an attempt that is still sending (send-outlook-email adds its
-- content key to the caller's item claim). Refused like a claim.
CREATE OR REPLACE FUNCTION public.extend_outbound_send_claim(
  p_attempt_id text, p_keys text[], p_actor text DEFAULT NULL, p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_lease timestamptz;
BEGIN
  SELECT min(lease_until) INTO v_lease FROM public.outbound_send_claims
   WHERE attempt_id = p_attempt_id AND state = 'sending';
  IF v_lease IS NULL OR EXISTS (SELECT 1 FROM public.outbound_send_claims
       WHERE attempt_id = p_attempt_id AND state <> 'sending') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_not_sending');
  END IF;
  RETURN public.outbound_send_claim_insert(
    p_keys, p_attempt_id, p_actor, p_detail,
    greatest(extract(epoch FROM v_lease - now())::integer, 30), 'extended');
END $$;

-- Record the outcome of a sending attempt, once. p_state: sent, failed (the
-- send definitely did not happen) or outcome_unknown.
CREATE OR REPLACE FUNCTION public.settle_outbound_send(
  p_attempt_id text, p_state text, p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_state NOT IN ('sent', 'failed', 'outcome_unknown') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_settle_invalid_state');
  END IF;
  WITH moved AS (
    UPDATE public.outbound_send_claims
       SET state = p_state, settled_at = now(), settled_detail = coalesce(p_detail, '{}'::jsonb)
     WHERE attempt_id = p_attempt_id AND state = 'sending'
     RETURNING item_key
  ), logged AS (
    INSERT INTO public.outbound_send_claim_events (attempt_id, item_key, event, from_state, to_state, detail)
    SELECT p_attempt_id, item_key, 'settled', 'sending', p_state, coalesce(p_detail, '{}'::jsonb) FROM moved
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;
  IF v_count = 0 THEN
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, to_state, detail)
    VALUES (p_attempt_id, 'settle_refused', p_state, coalesce(p_detail, '{}'::jsonb));
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_not_sending');
  END IF;
  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'state', p_state, 'rows', v_count);
END $$;

-- Release an unresolved attempt after someone checked the mailbox (or Xero
-- History). Compare and set on (attempt, expected state). A sending attempt is
-- reconcilable only once its lease has passed. p_result: sent | not_sent.
CREATE OR REPLACE FUNCTION public.reconcile_outbound_send(
  p_attempt_id text, p_expected_state text, p_result text, p_actor text,
  p_checked_at timestamptz, p_evidence text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_to text;
  v_count integer;
  v_refusal text;
BEGIN
  v_to := CASE p_result WHEN 'sent' THEN 'reconciled_sent' WHEN 'not_sent' THEN 'reconciled_not_sent' END;
  IF v_to IS NULL OR p_expected_state NOT IN ('sending', 'outcome_unknown') THEN
    v_refusal := 'send_reconcile_invalid';
  ELSIF p_actor IS NULL OR length(btrim(p_actor)) = 0 OR p_checked_at IS NULL THEN
    v_refusal := 'send_reconcile_actor_required';
  ELSIF p_expected_state = 'sending' AND EXISTS (
      SELECT 1 FROM public.outbound_send_claims
       WHERE attempt_id = p_attempt_id AND state = 'sending' AND lease_until >= now()) THEN
    v_refusal := 'send_reconcile_live_send';
  END IF;
  IF v_refusal IS NULL THEN
    WITH moved AS (
      UPDATE public.outbound_send_claims
         SET state = v_to, reconciled_by = p_actor, reconciled_at = now(),
             reconcile_checked_at = p_checked_at, reconcile_evidence = p_evidence
       WHERE attempt_id = p_attempt_id AND state = p_expected_state
       RETURNING item_key
    ), logged AS (
      INSERT INTO public.outbound_send_claim_events (attempt_id, item_key, event, from_state, to_state, actor, detail)
      SELECT p_attempt_id, item_key, 'reconciled', p_expected_state, v_to, p_actor,
             jsonb_build_object('checked_at', p_checked_at, 'evidence', p_evidence) FROM moved
      RETURNING 1
    )
    SELECT count(*) INTO v_count FROM logged;
    IF v_count = 0 THEN
      v_refusal := 'send_reconcile_state_changed';
    END IF;
  END IF;
  IF v_refusal IS NOT NULL THEN
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, from_state, actor, detail)
    VALUES (p_attempt_id, 'reconcile_refused', p_expected_state, p_actor,
            jsonb_build_object('code', v_refusal, 'result', p_result));
    RETURN jsonb_build_object('ok', false, 'code', v_refusal);
  END IF;
  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'state', v_to, 'rows', v_count);
END $$;

REVOKE ALL ON FUNCTION public.read_outbound_send_holds(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbound_send_claim_insert(text[], text, text, jsonb, integer, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_outbound_send(text[], text, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.extend_outbound_send_claim(text, text[], text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_outbound_send(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_outbound_send(text, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.outbound_send_claim_events_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_outbound_send_holds(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_outbound_send(text[], text, text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.extend_outbound_send_claim(text, text[], text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_outbound_send(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_outbound_send(text, text, text, text, timestamptz, text) TO service_role;

COMMENT ON TABLE public.outbound_send_claims IS
  'One hold per item a send may deliver (20261019170000). A key held by a sending or outcome_unknown attempt refuses every new claim until reconcile_outbound_send releases it.';
COMMENT ON TABLE public.outbound_send_claim_events IS
  'Append-only trail of every claim, refusal, settlement and reconciliation of outbound_send_claims.';
