-- Contract for 20261019170000_outbound_send_claims.
-- Fixture writes run as service_role through the doors, inside a rolled-back
-- transaction; the few direct edits (a lapsed lease, a forged open dispatch)
-- run as the owner between RESET ROLE and SET LOCAL ROLE.

-- 1. No role can write either table; service_role reads and calls the doors only.
DO $$
DECLARE
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.outbound_send_claims', 'public.outbound_send_claim_events'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('anon', t, p) OR has_table_privilege('authenticated', t, p) THEN
        RAISE EXCEPTION 'contract 1: a browser role holds % on %', p, t;
      END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege('service_role', t, p) THEN
        RAISE EXCEPTION 'contract 1: service_role holds % on %', p, t;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('service_role', t, 'SELECT') THEN
      RAISE EXCEPTION 'contract 1: service_role cannot read %', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
      RAISE EXCEPTION 'contract 1: RLS is off on %', t;
    END IF;
  END LOOP;
  IF has_sequence_privilege('service_role', 'public.outbound_send_claim_events_id_seq', 'USAGE') THEN
    RAISE EXCEPTION 'contract 1: service_role can draw event ids directly';
  END IF;
  FOREACH p IN ARRAY ARRAY[
    'public.read_outbound_send_holds(text[])',
    'public.claim_outbound_send(text[], text, text, jsonb, integer)',
    'public.extend_outbound_send_claim(text, text[], text, text, jsonb)',
    'public.confirm_outbound_dispatch(text, text)',
    'public.settle_outbound_send(text, text, jsonb, text)',
    'public.reconcile_outbound_send(text, text, text, text, timestamptz, text)'
  ] LOOP
    IF has_function_privilege('anon', p, 'EXECUTE') OR has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract 1: a browser role can call %', p;
    END IF;
    IF NOT has_function_privilege('service_role', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract 1: service_role cannot call %', p;
    END IF;
    IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid = p::regprocedure) THEN
      RAISE EXCEPTION 'contract 1: % is not SECURITY DEFINER with a pinned search_path', p;
    END IF;
  END LOOP;
  FOREACH p IN ARRAY ARRAY[
    'public.outbound_send_claim_insert(text[], text, text, jsonb, timestamptz, uuid, text, text)',
    'public.outbound_send_claim_lock(text, text)',
    'public.outbound_send_claim_keys(text[])'
  ] LOOP
    IF has_function_privilege('service_role', p, 'EXECUTE') OR has_function_privilege('anon', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'contract 1: internal helper % is callable', p;
    END IF;
  END LOOP;
  IF to_regprocedure('public.extend_outbound_send_claim(text, text[], text, jsonb)') IS NOT NULL
     OR to_regprocedure('public.settle_outbound_send(text, text, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'contract 1: an old door signature survived';
  END IF;
  IF (SELECT pg_get_function_arguments('public.claim_outbound_send(text[], text, text, jsonb, integer)'::regprocedure))
       NOT LIKE '%p_lease_seconds integer DEFAULT 900%' THEN
    RAISE EXCEPTION 'contract 1: the default lease is not 900 seconds';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  r jsonb;
  t1 text;
  te text;
BEGIN
  -- 1b. service_role cannot write a claim row around the doors.
  BEGIN
    INSERT INTO public.outbound_send_claims (attempt_id, item_key, lease_until) VALUES ('x', 'x', now());
    RAISE EXCEPTION 'contract 1b: service_role inserted a claim row directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.outbound_send_claim_events (attempt_id, event) VALUES ('x', 'claimed');
    RAISE EXCEPTION 'contract 1b: service_role inserted an event directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 2. A claim holds its key; a second claim on any shared key is refused whole.
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a1', 'office@x', '{}'::jsonb);
  IF NOT coalesce((r->>'ok')::boolean, false) OR r->>'dispatch_token' IS NULL THEN RAISE EXCEPTION 'contract 2: first claim refused: %', r; END IF;
  t1 := r->>'dispatch_token';
  IF NOT EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a1'
                  AND dispatch_token::text = t1 AND dispatch_started_at IS NOT NULL AND dispatch_via = 'claim'
                  AND lease_until > now() + interval '890 seconds') THEN
    RAISE EXCEPTION 'contract 2: the claim did not record its dispatch and 900 second lease';
  END IF;
  r := public.claim_outbound_send(ARRAY['email_content:abc', 'invoice:inv-1'], 'a2', 'office@x', '{}'::jsonb, 600);
  IF (r->>'ok')::boolean OR r->>'code' IS DISTINCT FROM 'send_claim_held' THEN
    RAISE EXCEPTION 'contract 2: overlapping claim not refused: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a2') THEN
    RAISE EXCEPTION 'contract 2: a refused claim left a row behind';
  END IF;
  IF (r->'held'->0->>'attempt_id') IS DISTINCT FROM 'a1' THEN RAISE EXCEPTION 'contract 2: refusal does not name the holder: %', r; END IF;
  r := public.claim_outbound_send(ARRAY['invoice:inv-9'], 'a1', NULL, '{}'::jsonb, 600);
  IF r->>'code' IS DISTINCT FROM 'send_claim_attempt_exists' THEN RAISE EXCEPTION 'contract 2: attempt id reused: %', r; END IF;

  -- 3. The pre-send fence answers the current token only.
  r := public.confirm_outbound_dispatch('a1', t1);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'contract 3: the claim token did not confirm: %', r; END IF;
  r := public.confirm_outbound_dispatch('a1', gen_random_uuid()::text);
  IF r->>'code' IS DISTINCT FROM 'send_dispatch_fenced' THEN RAISE EXCEPTION 'contract 3: a stranger token confirmed: %', r; END IF;
  r := public.confirm_outbound_dispatch('a1', 'not-a-uuid');
  IF r->>'code' IS DISTINCT FROM 'send_dispatch_fenced' THEN RAISE EXCEPTION 'contract 3: a malformed token confirmed: %', r; END IF;

  -- 4. Extend is single-use and must name one of the attempt's own keys.
  r := public.extend_outbound_send_claim('a1', ARRAY['email_content:abc'], 'invoice:other', NULL, '{}'::jsonb);
  IF r->>'code' IS DISTINCT FROM 'send_claim_item_mismatch' THEN RAISE EXCEPTION 'contract 4: item mismatch not refused: %', r; END IF;
  r := public.extend_outbound_send_claim('a1', ARRAY['invoice:inv-1'], 'invoice:inv-1', NULL, '{}'::jsonb);
  IF r->>'code' IS DISTINCT FROM 'send_claim_dispatch_taken' THEN RAISE EXCEPTION 'contract 4: re-claiming an own key not refused: %', r; END IF;
  r := public.extend_outbound_send_claim('a1', ARRAY['email_content:abc'], 'invoice:inv-1', NULL, '{}'::jsonb);
  IF NOT coalesce((r->>'ok')::boolean, false) OR r->>'dispatch_token' IS NULL OR r->>'dispatch_token' = t1 THEN
    RAISE EXCEPTION 'contract 4: extend refused or reused the token: %', r;
  END IF;
  te := r->>'dispatch_token';
  r := public.extend_outbound_send_claim('a1', ARRAY['email_content:abc'], 'invoice:inv-1', NULL, '{}'::jsonb);
  IF r->>'code' IS DISTINCT FROM 'send_claim_dispatch_taken' THEN RAISE EXCEPTION 'contract 4: a repeat extend succeeded: %', r; END IF;
  r := public.extend_outbound_send_claim('a1', ARRAY['email_content:def'], 'invoice:inv-1', NULL, '{}'::jsonb);
  IF r->>'code' IS DISTINCT FROM 'send_claim_dispatch_taken' THEN RAISE EXCEPTION 'contract 4: a second extend with new keys succeeded: %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE item_key = 'email_content:def') THEN
    RAISE EXCEPTION 'contract 4: a refused extend left a row behind';
  END IF;
  r := public.confirm_outbound_dispatch('a1', t1);
  IF r->>'code' IS DISTINCT FROM 'send_dispatch_fenced' THEN RAISE EXCEPTION 'contract 4: the caller token still confirms after extend: %', r; END IF;
  r := public.confirm_outbound_dispatch('a1', te);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'contract 4: the door token did not confirm: %', r; END IF;

  -- 5. A caller settle while the door's dispatch is open is deferred; the door settles once.
  r := public.settle_outbound_send('a1', 'failed', '{}'::jsonb, 'caller');
  IF NOT coalesce((r->>'ok')::boolean, false) OR NOT coalesce((r->>'deferred')::boolean, false) OR r->>'state' IS DISTINCT FROM 'sending' THEN
    RAISE EXCEPTION 'contract 5: caller settle not deferred: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a1' AND state <> 'sending') THEN
    RAISE EXCEPTION 'contract 5: a deferred caller settle changed state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outbound_send_claim_events WHERE attempt_id = 'a1' AND event = 'caller_settle_deferred') THEN
    RAISE EXCEPTION 'contract 5: the deferral was not recorded';
  END IF;
  r := public.settle_outbound_send('a1', 'sent', '{}'::jsonb, 'nobody');
  IF r->>'code' IS DISTINCT FROM 'send_settle_invalid_settler' THEN RAISE EXCEPTION 'contract 5: unknown settler accepted: %', r; END IF;
  r := public.settle_outbound_send('a1', 'outcome_unknown', '{"why":"timeout"}'::jsonb);
  IF NOT coalesce((r->>'ok')::boolean, false) OR (r->>'rows')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'contract 5: dispatcher settle: %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a1' AND dispatch_ended_at IS NULL) THEN
    RAISE EXCEPTION 'contract 5: the dispatcher settle did not end the dispatch';
  END IF;
  r := public.settle_outbound_send('a1', 'sent', '{}'::jsonb);
  IF r->>'code' IS DISTINCT FROM 'send_claim_not_sending' THEN RAISE EXCEPTION 'contract 5: a second settle overwrote: %', r; END IF;
  r := public.settle_outbound_send('a1', 'sent', '{}'::jsonb, 'caller');
  IF r->>'code' IS DISTINCT FROM 'send_claim_not_sending' THEN RAISE EXCEPTION 'contract 5: a late caller settle overwrote: %', r; END IF;
  r := public.extend_outbound_send_claim('a1', ARRAY['x:y'], NULL, NULL, '{}'::jsonb);
  IF r->>'code' IS DISTINCT FROM 'send_claim_not_sending' THEN RAISE EXCEPTION 'contract 5: extended a settled attempt: %', r; END IF;
  r := public.confirm_outbound_dispatch('a1', te);
  IF r->>'code' IS DISTINCT FROM 'send_dispatch_fenced' THEN RAISE EXCEPTION 'contract 5: a settled attempt still confirms: %', r; END IF;

  -- 5b. A caller settle with no open extension settles as today.
  r := public.claim_outbound_send(ARRAY['invoice:inv-c'], 'ac', NULL, '{}'::jsonb);
  r := public.settle_outbound_send('ac', 'sent', '{}'::jsonb, 'caller');
  IF NOT coalesce((r->>'ok')::boolean, false) OR r ? 'deferred' THEN RAISE EXCEPTION 'contract 5b: plain caller settle: %', r; END IF;

  -- 6. An unknown outcome keeps holding, and a later attempt cannot clear it.
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a3', NULL, '{}'::jsonb, 600);
  IF r->>'code' IS DISTINCT FROM 'send_claim_held' THEN RAISE EXCEPTION 'contract 6: unknown did not hold: %', r; END IF;
  r := public.settle_outbound_send('a3', 'sent', '{}'::jsonb);
  IF r->>'code' IS DISTINCT FROM 'send_claim_not_sending' THEN RAISE EXCEPTION 'contract 6: a stranger settled: %', r; END IF;

  -- 7. Reconcile is a compare and set on the named attempt and needs who and when.
  r := public.reconcile_outbound_send('a1', 'outcome_unknown', 'not_sent', '', now(), NULL);
  IF r->>'code' IS DISTINCT FROM 'send_reconcile_actor_required' THEN RAISE EXCEPTION 'contract 7: anonymous reconcile: %', r; END IF;
  r := public.reconcile_outbound_send('a1', 'sending', 'not_sent', 'office@x', now(), NULL);
  IF r->>'code' IS DISTINCT FROM 'send_reconcile_state_changed' THEN RAISE EXCEPTION 'contract 7: wrong expected state: %', r; END IF;
  r := public.reconcile_outbound_send('a1', 'outcome_unknown', 'not_sent', 'office@x', now(), 'Sent Items checked');
  IF NOT coalesce((r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'contract 7: reconcile refused: %', r; END IF;
  r := public.reconcile_outbound_send('a1', 'outcome_unknown', 'not_sent', 'office@y', now(), NULL);
  IF r->>'code' IS DISTINCT FROM 'send_reconcile_state_changed' THEN RAISE EXCEPTION 'contract 7: second reconcile also won: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a1'
                  AND state = 'reconciled_not_sent' AND reconciled_by = 'office@x' AND dispatch_token IS NULL
                  AND reconcile_checked_at IS NOT NULL AND reconcile_evidence = 'Sent Items checked') THEN
    RAISE EXCEPTION 'contract 7: who, when and what were not recorded, or the token survived';
  END IF;
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a4', NULL, '{}'::jsonb, 600);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'contract 7: reconciled key still held: %', r; END IF;
  r := public.reconcile_outbound_send('a4', 'sending', 'not_sent', 'office@x', now(), NULL);
  IF r->>'code' IS DISTINCT FROM 'send_reconcile_live_send' THEN RAISE EXCEPTION 'contract 7: released a live send: %', r; END IF;
  r := public.reconcile_outbound_send('a4', 'outcome_unknown', 'not_sent', 'office@x', now(), NULL);
  IF r->>'code' IS DISTINCT FROM 'send_reconcile_live_send' THEN RAISE EXCEPTION 'contract 7: a live send released by naming another state: %', r; END IF;

  -- 8 (setup). An attempt settled unknown whose dispatch is then forged open below.
  r := public.claim_outbound_send(ARRAY['invoice:inv-8'], 'a8', NULL, '{}'::jsonb);
  r := public.settle_outbound_send('a8', 'outcome_unknown', '{}'::jsonb);
END $$;

-- The owner lapses a4's lease (its settle was lost) and reopens a8's dispatch.
RESET ROLE;
UPDATE public.outbound_send_claims SET lease_until = now() - interval '1 minute' WHERE attempt_id = 'a4';
UPDATE public.outbound_send_claims SET dispatch_ended_at = NULL, dispatch_token = gen_random_uuid() WHERE attempt_id = 'a8';
SET LOCAL ROLE service_role;

DO $$
DECLARE
  r jsonb;
  h jsonb;
  t4 text := (SELECT dispatch_token::text FROM public.outbound_send_claims WHERE attempt_id = 'a4' LIMIT 1);
  t8 text := (SELECT dispatch_token::text FROM public.outbound_send_claims WHERE attempt_id = 'a8' LIMIT 1);
BEGIN
  -- 8. An open dispatch inside its lease blocks reconcile even in outcome_unknown.
  r := public.reconcile_outbound_send('a8', 'outcome_unknown', 'not_sent', 'office@x', now(), NULL);
  IF r->>'code' IS DISTINCT FROM 'send_reconcile_live_send' THEN RAISE EXCEPTION 'contract 8: released an open live dispatch: %', r; END IF;

  -- 9. A lapsed send reads stale, still holds, stops confirming, and a named checker may release it.
  h := public.read_outbound_send_holds(ARRAY['invoice:inv-1']);
  IF jsonb_array_length(h) <> 1 OR NOT coalesce((h->0->>'stale')::boolean, false) THEN RAISE EXCEPTION 'contract 9: lapsed send not stale: %', h; END IF;
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a5', NULL, '{}'::jsonb, 600);
  IF r->>'code' IS DISTINCT FROM 'send_claim_held' THEN RAISE EXCEPTION 'contract 9: a lapsed send stopped holding: %', r; END IF;
  r := public.confirm_outbound_dispatch('a4', t4);
  IF r->>'code' IS DISTINCT FROM 'send_dispatch_fenced' THEN RAISE EXCEPTION 'contract 9: a lapsed lease still confirms: %', r; END IF;
  PERFORM set_config('outbound_claims_contract.t4', t4, true);
  r := public.reconcile_outbound_send('a4', 'sending', 'sent', 'office@x', now(), NULL);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'contract 9: lapsed send not reconcilable: %', r; END IF;

  -- 10. A confirmed send does not block a deliberate later send.
  r := public.claim_outbound_send(ARRAY['debt_report:org'], 'a6', NULL, '{}'::jsonb, 600);
  PERFORM public.settle_outbound_send('a6', 'sent', '{}'::jsonb);
  r := public.claim_outbound_send(ARRAY['debt_report:org'], 'a7', NULL, '{}'::jsonb, 600);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'contract 10: a sent attempt blocked the next: %', r; END IF;

  -- 11. Every step left an event.
  IF (SELECT count(*) FROM public.outbound_send_claim_events WHERE event = 'claim_refused') < 4
     OR (SELECT count(*) FROM public.outbound_send_claim_events WHERE event = 'extend_refused') < 3
     OR NOT EXISTS (SELECT 1 FROM public.outbound_send_claim_events WHERE event = 'reconcile_refused')
     OR NOT EXISTS (SELECT 1 FROM public.outbound_send_claim_events WHERE event = 'settle_refused')
     OR NOT EXISTS (SELECT 1 FROM public.outbound_send_claim_events WHERE event = 'dispatch_fenced')
     OR NOT EXISTS (SELECT 1 FROM public.outbound_send_claim_events WHERE event = 'dispatch_confirmed') THEN
    RAISE EXCEPTION 'contract 11: refusals were not recorded';
  END IF;
END $$;

-- 12. A reconcile clears the token, so the late worker's confirm is fenced even
-- if its row were forged back to a live sending lease.
RESET ROLE;
UPDATE public.outbound_send_claims SET state = 'sending', lease_until = now() + interval '1 hour' WHERE attempt_id = 'a4';
SET LOCAL ROLE service_role;
DO $$
DECLARE
  r jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a4' AND dispatch_token IS NOT NULL) THEN
    RAISE EXCEPTION 'contract 12: reconcile left a dispatch token';
  END IF;
  r := public.confirm_outbound_dispatch('a4', current_setting('outbound_claims_contract.t4'));
  IF r->>'code' IS DISTINCT FROM 'send_dispatch_fenced' THEN RAISE EXCEPTION 'contract 12: a late confirm after reconcile was not fenced: %', r; END IF;
END $$;
RESET ROLE;

-- 13. The trail cannot be edited and neither table can be truncated, even by the owner.
DO $$
BEGIN
  BEGIN
    UPDATE public.outbound_send_claim_events SET actor = 'edited';
    RAISE EXCEPTION 'contract 13: the event trail was editable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.outbound_send_claim_events;
    RAISE EXCEPTION 'contract 13: the event trail was deletable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE public.outbound_send_claims CASCADE;
    RAISE EXCEPTION 'contract 13: the claims were truncatable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%cannot be truncated%' THEN RAISE; END IF;
  END;
  BEGIN
    TRUNCATE public.outbound_send_claim_events;
    RAISE EXCEPTION 'contract 13: the event trail was truncatable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%cannot be truncated%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

-- 14. Re-applying the migration is a no-op.
\ir ../../../migrations/20261019170000_outbound_send_claims.sql
