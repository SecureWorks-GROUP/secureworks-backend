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
--   debt_statement:<org>:<customer>, makesafe_pack:<job>:<kind>,
--   approved_send:<payload hash>, email_content:<sha256>). One attempt may
--   hold several keys.
-- * A claim is refused while any of its keys is held by an attempt in state
--   sending or outcome_unknown (partial unique index: two concurrent claims
--   cannot both win).
-- * Dispatch is single-use. A claim, and the one extension a door may add to
--   it, each hand out a fresh dispatch_token. A second extension of the same
--   attempt is refused (send_claim_dispatch_taken), whatever keys it names,
--   so two requests carrying one caller attempt cannot both dispatch. The
--   extension must name one of the attempt's own keys as its caller
--   (send_claim_item_mismatch otherwise). An extension replaces the token: the
--   caller's token stops confirming and only the door dispatches.
-- * confirm_outbound_dispatch is the pre-send fence: the holder of the current
--   token calls it immediately before the provider call, and it answers ok
--   only while the attempt is still sending, the token is current and the
--   lease is live. A reconciled or settled attempt, a replaced token or a
--   lapsed lease is send_dispatch_fenced.
-- * settle_outbound_send moves an attempt out of sending exactly once
--   (compare and set): sent, failed (definitely not sent) or outcome_unknown.
--   A caller settle (p_settler = 'caller') while the door's extended dispatch
--   is still open changes nothing and is recorded as caller_settle_deferred:
--   the door that dispatched settles the attempt, and if it never does the
--   attempt lapses and needs reconciliation.
-- * Only reconcile_outbound_send releases an unresolved attempt, and only the
--   named attempt in the named state, recording who checked, when and what
--   they found. It is refused (send_reconcile_live_send) while any row is
--   sending, or has an open dispatch, inside its lease, whatever state the
--   caller expected. Reconciling clears the dispatch token, so a late confirm
--   is fenced.
-- * Lease expiry is recovery, not proof the worker stopped. The default lease
--   is 900 seconds. Releasing an attempt after its lease rests on two things:
--   the edge-function wall-clock limit (a worker cannot outlive it) and the
--   pre-send fence above (a worker that is still alive cannot dispatch after
--   its lease or after a reconcile). Neither proves a provider call already in
--   flight has not landed, which is why release still needs a named checker.
-- * A confirmed sent does not block a deliberate later send. A later attempt
--   can never resolve an earlier one.
-- * Every function takes a transaction-scoped advisory lock on the attempt
--   id; claim and extend then lock each key in sorted order. Attempt locks are
--   always taken before key locks, so the locks cannot deadlock.
-- * Every claim, refusal, extension, confirmation, settlement and
--   reconciliation writes one append-only outbound_send_claim_events row.
--
-- Privileges: RLS is on with no policy. No role holds a write privilege on
-- either table: every write goes through the SECURITY DEFINER functions
-- below. service_role may read both tables and call the public functions; the
-- browser roles hold nothing. TRUNCATE is refused on both tables, and the
-- event trail refuses UPDATE and DELETE. Nothing is sent and no row is
-- written when this migration applies. Re-applying is a no-op.
-- Rollback: supabase/rollbacks/20261019170000_outbound_send_claims_down.sql
-- (refuses while any attempt is unresolved; keeps both tables and their rows).

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
-- The current dispatch of the attempt: who may send (the token), when that
-- dispatch began and ended, and whether the claim or a door's extension owns it.
ALTER TABLE public.outbound_send_claims ADD COLUMN IF NOT EXISTS dispatch_token uuid;
ALTER TABLE public.outbound_send_claims ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;
ALTER TABLE public.outbound_send_claims ADD COLUMN IF NOT EXISTS dispatch_ended_at timestamptz;
ALTER TABLE public.outbound_send_claims ADD COLUMN IF NOT EXISTS dispatch_via text;
ALTER TABLE public.outbound_send_claims DROP CONSTRAINT IF EXISTS outbound_send_claims_dispatch_via;
ALTER TABLE public.outbound_send_claims ADD CONSTRAINT outbound_send_claims_dispatch_via
  CHECK (dispatch_via IS NULL OR dispatch_via IN ('claim', 'extend'));

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
  event text NOT NULL,
  from_state text,
  to_state text,
  actor text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.outbound_send_claim_events DROP CONSTRAINT IF EXISTS outbound_send_claim_events_event_check;
ALTER TABLE public.outbound_send_claim_events ADD CONSTRAINT outbound_send_claim_events_event_check
  CHECK (event IN (
    'claimed', 'claim_refused', 'extended', 'extend_refused', 'dispatch_confirmed', 'dispatch_fenced',
    'settled', 'settle_refused', 'caller_settle_deferred', 'reconciled', 'reconcile_refused'
  ));
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

CREATE OR REPLACE FUNCTION public.outbound_send_claims_no_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated: send claims and their trail are kept', TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS outbound_send_claims_no_truncate ON public.outbound_send_claims;
CREATE TRIGGER outbound_send_claims_no_truncate
  BEFORE TRUNCATE ON public.outbound_send_claims
  FOR EACH STATEMENT EXECUTE FUNCTION public.outbound_send_claims_no_truncate();
DROP TRIGGER IF EXISTS outbound_send_claim_events_no_truncate ON public.outbound_send_claim_events;
CREATE TRIGGER outbound_send_claim_events_no_truncate
  BEFORE TRUNCATE ON public.outbound_send_claim_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.outbound_send_claims_no_truncate();

ALTER TABLE public.outbound_send_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_send_claim_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_send_claims FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.outbound_send_claim_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.outbound_send_claim_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.outbound_send_claims TO service_role;
GRANT SELECT ON public.outbound_send_claim_events TO service_role;

-- Earlier drafts of this migration had other signatures; drop them so no
-- overload of a door survives a re-apply.
DROP FUNCTION IF EXISTS public.extend_outbound_send_claim(text, text[], text, jsonb);
DROP FUNCTION IF EXISTS public.settle_outbound_send(text, text, jsonb);

-- Internal: the transaction-scoped advisory lock for one attempt or one key.
CREATE OR REPLACE FUNCTION public.outbound_send_claim_lock(p_kind text, p_name text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('outbound_send_claims:' || p_kind || ':' || coalesce(p_name, ''), 0))
$$;

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

-- Internal: insert claim rows for p_keys under p_attempt_id, all or none. The
-- caller holds the attempt lock and has validated p_keys (distinct, sorted).
CREATE OR REPLACE FUNCTION public.outbound_send_claim_insert(
  p_keys text[], p_attempt_id text, p_actor text, p_detail jsonb, p_lease_until timestamptz,
  p_token uuid, p_via text, p_event text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_key text;
  v_held jsonb;
BEGIN
  FOREACH v_key IN ARRAY p_keys LOOP
    PERFORM public.outbound_send_claim_lock('key', v_key);
  END LOOP;
  BEGIN
    FOREACH v_key IN ARRAY p_keys LOOP
      INSERT INTO public.outbound_send_claims (
        attempt_id, item_key, state, actor, detail, lease_until,
        dispatch_token, dispatch_started_at, dispatch_via)
      VALUES (p_attempt_id, v_key, 'sending', p_actor, coalesce(p_detail, '{}'::jsonb), p_lease_until,
              p_token, now(), p_via);
      INSERT INTO public.outbound_send_claim_events (attempt_id, item_key, event, to_state, actor, detail)
      VALUES (p_attempt_id, v_key, p_event, 'sending', p_actor, coalesce(p_detail, '{}'::jsonb));
    END LOOP;
  EXCEPTION WHEN unique_violation THEN
    -- Another attempt holds one of the keys: nothing of this claim is kept.
    v_held := public.read_outbound_send_holds(p_keys);
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, actor, detail)
    VALUES (p_attempt_id, CASE p_event WHEN 'claimed' THEN 'claim_refused' ELSE 'extend_refused' END, p_actor,
            jsonb_build_object('code', 'send_claim_held', 'keys', to_jsonb(p_keys), 'held', v_held));
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_held', 'held', v_held);
  END;
  RETURN NULL;
END $$;

-- Internal: p_keys trimmed, non-empty, distinct and sorted; NULL when none.
CREATE OR REPLACE FUNCTION public.outbound_send_claim_keys(p_keys text[])
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT array_agg(DISTINCT btrim(k) ORDER BY btrim(k))
    FROM unnest(p_keys) AS k WHERE k IS NOT NULL AND length(btrim(k)) > 0
$$;

-- Claim p_keys for a new send attempt. Refused (nothing written but the refusal
-- event) while any key is held by an unresolved attempt. The returned
-- dispatch_token is what confirm_outbound_dispatch checks before the send.
CREATE OR REPLACE FUNCTION public.claim_outbound_send(
  p_keys text[], p_attempt_id text, p_actor text DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb, p_lease_seconds integer DEFAULT 900
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_keys text[] := public.outbound_send_claim_keys(p_keys);
  v_token uuid := gen_random_uuid();
  v_refused jsonb;
BEGIN
  IF v_keys IS NULL OR p_attempt_id IS NULL OR length(p_attempt_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_invalid');
  END IF;
  PERFORM public.outbound_send_claim_lock('attempt', p_attempt_id);
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = p_attempt_id) THEN
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, actor, detail)
    VALUES (p_attempt_id, 'claim_refused', p_actor,
            jsonb_build_object('code', 'send_claim_attempt_exists', 'keys', to_jsonb(v_keys)));
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_attempt_exists');
  END IF;
  v_refused := public.outbound_send_claim_insert(
    v_keys, p_attempt_id, p_actor, p_detail,
    now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 900), 30)),
    v_token, 'claim', 'claimed');
  IF v_refused IS NOT NULL THEN
    RETURN v_refused;
  END IF;
  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'keys', to_jsonb(v_keys),
                            'dispatch_token', v_token);
END $$;

-- A door joins the claim its caller already holds (send-outlook-email adds its
-- content key to the caller's item claim) and takes over the dispatch. Once per
-- attempt: a second extension is send_claim_dispatch_taken, never success.
-- p_caller_item_key, when given, must be one of the attempt's keys.
CREATE OR REPLACE FUNCTION public.extend_outbound_send_claim(
  p_attempt_id text, p_keys text[], p_caller_item_key text DEFAULT NULL,
  p_actor text DEFAULT NULL, p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_keys text[] := public.outbound_send_claim_keys(p_keys);
  v_token uuid := gen_random_uuid();
  v_lease timestamptz := now() + make_interval(secs => 900);
  v_code text;
  v_refused jsonb;
BEGIN
  IF v_keys IS NULL OR p_attempt_id IS NULL OR length(p_attempt_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_invalid');
  END IF;
  PERFORM public.outbound_send_claim_lock('attempt', p_attempt_id);
  IF NOT EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = p_attempt_id)
     OR EXISTS (SELECT 1 FROM public.outbound_send_claims
                 WHERE attempt_id = p_attempt_id AND state <> 'sending') THEN
    v_code := 'send_claim_not_sending';
  ELSIF p_caller_item_key IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.outbound_send_claims
       WHERE attempt_id = p_attempt_id AND item_key = btrim(p_caller_item_key)) THEN
    v_code := 'send_claim_item_mismatch';
  ELSIF EXISTS (SELECT 1 FROM public.outbound_send_claims
                 WHERE attempt_id = p_attempt_id
                   AND (item_key = ANY (v_keys) OR dispatch_via = 'extend')) THEN
    v_code := 'send_claim_dispatch_taken';
  END IF;
  IF v_code IS NOT NULL THEN
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, actor, detail)
    VALUES (p_attempt_id, 'extend_refused', p_actor,
            jsonb_build_object('code', v_code, 'keys', to_jsonb(v_keys), 'caller_item_key', p_caller_item_key));
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT greatest(max(lease_until), v_lease) INTO v_lease
    FROM public.outbound_send_claims WHERE attempt_id = p_attempt_id;
  v_refused := public.outbound_send_claim_insert(
    v_keys, p_attempt_id, p_actor, p_detail, v_lease, v_token, 'extend', 'extended');
  IF v_refused IS NOT NULL THEN
    RETURN v_refused;
  END IF;
  UPDATE public.outbound_send_claims
     SET dispatch_token = v_token, dispatch_started_at = now(), dispatch_ended_at = NULL,
         dispatch_via = 'extend', lease_until = v_lease
   WHERE attempt_id = p_attempt_id;
  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'keys', to_jsonb(v_keys),
                            'dispatch_token', v_token);
END $$;

-- The pre-send fence: ok only while the attempt is sending, p_dispatch_token is
-- its current token and the lease is live. Called immediately before the
-- provider call; anything else is send_dispatch_fenced and nothing is sent.
CREATE OR REPLACE FUNCTION public.confirm_outbound_dispatch(p_attempt_id text, p_dispatch_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF p_attempt_id IS NULL OR length(p_attempt_id) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_dispatch_fenced');
  END IF;
  PERFORM public.outbound_send_claim_lock('attempt', p_attempt_id);
  SELECT count(*) > 0 AND bool_and(
           state = 'sending' AND dispatch_ended_at IS NULL AND lease_until > now()
           AND dispatch_token IS NOT NULL AND dispatch_token::text = lower(btrim(coalesce(p_dispatch_token, ''))))
    INTO v_ok
    FROM public.outbound_send_claims WHERE attempt_id = p_attempt_id;
  INSERT INTO public.outbound_send_claim_events (attempt_id, event, detail)
  VALUES (p_attempt_id, CASE WHEN v_ok THEN 'dispatch_confirmed' ELSE 'dispatch_fenced' END, '{}'::jsonb);
  IF NOT v_ok THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_dispatch_fenced');
  END IF;
  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id);
END $$;

-- Record the outcome of a sending attempt, once. p_state: sent, failed (the
-- send definitely did not happen) or outcome_unknown. p_settler: 'dispatcher'
-- (whoever made the provider call) or 'caller' (a caller whose door may have
-- extended the attempt). A caller settle while the door's dispatch is open is
-- deferred: nothing changes and the door settles.
CREATE OR REPLACE FUNCTION public.settle_outbound_send(
  p_attempt_id text, p_state text, p_detail jsonb DEFAULT '{}'::jsonb, p_settler text DEFAULT 'dispatcher'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('sent', 'failed', 'outcome_unknown') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_settle_invalid_state');
  END IF;
  IF p_settler IS NULL OR p_settler NOT IN ('dispatcher', 'caller') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'send_settle_invalid_settler');
  END IF;
  PERFORM public.outbound_send_claim_lock('attempt', p_attempt_id);
  IF p_settler = 'caller' AND EXISTS (
      SELECT 1 FROM public.outbound_send_claims
       WHERE attempt_id = p_attempt_id AND state = 'sending'
         AND dispatch_via = 'extend' AND dispatch_ended_at IS NULL) THEN
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, from_state, to_state, actor, detail)
    VALUES (p_attempt_id, 'caller_settle_deferred', 'sending', 'sending', 'caller',
            jsonb_build_object('requested_state', p_state, 'detail', coalesce(p_detail, '{}'::jsonb)));
    RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'deferred', true, 'state', 'sending');
  END IF;
  WITH moved AS (
    UPDATE public.outbound_send_claims
       SET state = p_state, settled_at = now(), settled_detail = coalesce(p_detail, '{}'::jsonb),
           dispatch_ended_at = coalesce(dispatch_ended_at, now())
     WHERE attempt_id = p_attempt_id AND state = 'sending'
     RETURNING item_key
  ), logged AS (
    INSERT INTO public.outbound_send_claim_events (attempt_id, item_key, event, from_state, to_state, actor, detail)
    SELECT p_attempt_id, item_key, 'settled', 'sending', p_state, p_settler, coalesce(p_detail, '{}'::jsonb) FROM moved
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;
  IF v_count = 0 THEN
    INSERT INTO public.outbound_send_claim_events (attempt_id, event, to_state, actor, detail)
    VALUES (p_attempt_id, 'settle_refused', p_state, p_settler, coalesce(p_detail, '{}'::jsonb));
    RETURN jsonb_build_object('ok', false, 'code', 'send_claim_not_sending');
  END IF;
  RETURN jsonb_build_object('ok', true, 'attempt_id', p_attempt_id, 'state', p_state, 'rows', v_count);
END $$;

-- Release an unresolved attempt after someone checked the mailbox (or Xero
-- History). Compare and set on (attempt, expected state). Refused while any
-- row is sending or has an open dispatch inside its lease, whatever state was
-- expected. Clears the dispatch token. p_result: sent | not_sent.
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
  IF v_to IS NULL OR p_expected_state IS NULL OR p_expected_state NOT IN ('sending', 'outcome_unknown') THEN
    v_refusal := 'send_reconcile_invalid';
  ELSIF p_actor IS NULL OR length(btrim(p_actor)) = 0 OR p_checked_at IS NULL THEN
    v_refusal := 'send_reconcile_actor_required';
  ELSE
    PERFORM public.outbound_send_claim_lock('attempt', p_attempt_id);
    IF EXISTS (
        SELECT 1 FROM public.outbound_send_claims
         WHERE attempt_id = p_attempt_id AND lease_until >= now()
           AND (state = 'sending' OR (dispatch_started_at IS NOT NULL AND dispatch_ended_at IS NULL))) THEN
      v_refusal := 'send_reconcile_live_send';
    END IF;
  END IF;
  IF v_refusal IS NULL THEN
    WITH moved AS (
      UPDATE public.outbound_send_claims
         SET state = v_to, reconciled_by = p_actor, reconciled_at = now(),
             reconcile_checked_at = p_checked_at, reconcile_evidence = p_evidence,
             dispatch_token = NULL, dispatch_ended_at = coalesce(dispatch_ended_at, now())
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

REVOKE ALL ON FUNCTION public.outbound_send_claim_lock(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.outbound_send_claim_keys(text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.outbound_send_claim_insert(text[], text, text, jsonb, timestamptz, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.outbound_send_claim_events_append_only() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.outbound_send_claims_no_truncate() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.read_outbound_send_holds(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_outbound_send(text[], text, text, jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.extend_outbound_send_claim(text, text[], text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_outbound_dispatch(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_outbound_send(text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_outbound_send(text, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_outbound_send_holds(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_outbound_send(text[], text, text, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.extend_outbound_send_claim(text, text[], text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_outbound_dispatch(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_outbound_send(text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_outbound_send(text, text, text, text, timestamptz, text) TO service_role;

COMMENT ON TABLE public.outbound_send_claims IS
  'One hold per item a send may deliver (20261019170000). A key held by a sending or outcome_unknown attempt refuses every new claim until reconcile_outbound_send releases it. Written only through the claim functions; dispatch is single-use and fenced by confirm_outbound_dispatch.';
COMMENT ON TABLE public.outbound_send_claim_events IS
  'Append-only trail of every claim, refusal, extension, dispatch confirmation, settlement and reconciliation of outbound_send_claims.';
