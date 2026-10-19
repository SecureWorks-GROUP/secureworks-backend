-- Contract for 20261019170000_outbound_send_claims.
-- Fixture writes run as service_role inside a rolled-back transaction.

-- 1. Browser roles hold nothing; service_role holds only the public doors.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.outbound_send_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.outbound_send_claims', 'SELECT')
     OR has_table_privilege('authenticated', 'public.outbound_send_claim_events', 'SELECT')
     OR has_table_privilege('anon', 'public.outbound_send_claims', 'TRUNCATE') THEN
    RAISE EXCEPTION 'contract: a browser role can read or truncate the claim tables';
  END IF;
  IF has_function_privilege('authenticated', 'public.claim_outbound_send(text[], text, text, jsonb, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reconcile_outbound_send(text, text, text, text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: a browser role can call a claim function';
  END IF;
  IF has_function_privilege('service_role', 'public.outbound_send_claim_insert(text[], text, text, jsonb, integer, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: the internal insert helper is callable by service_role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_outbound_send(text[], text, text, jsonb, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.settle_outbound_send(text, text, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reconcile_outbound_send(text, text, text, text, timestamptz, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.read_outbound_send_holds(text[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.extend_outbound_send_claim(text, text[], text, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'contract: service_role cannot call a claim door';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.outbound_send_claims'::regclass) THEN
    RAISE EXCEPTION 'contract: RLS is off on outbound_send_claims';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  r jsonb;
  h jsonb;
BEGIN
  -- 2. A claim holds its key; a second claim on any shared key is refused whole.
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a1', 'office@x', '{}'::jsonb, 600);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'contract 2: first claim refused: %', r; END IF;
  r := public.claim_outbound_send(ARRAY['email_content:abc', 'invoice:inv-1'], 'a2', 'office@x', '{}'::jsonb, 600);
  IF (r->>'ok')::boolean OR r->>'code' <> 'send_claim_held' THEN
    RAISE EXCEPTION 'contract 2: overlapping claim not refused: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a2') THEN
    RAISE EXCEPTION 'contract 2: a refused claim left a row behind';
  END IF;
  IF (r->'held'->0->>'attempt_id') <> 'a1' THEN RAISE EXCEPTION 'contract 2: refusal does not name the holder: %', r; END IF;
  r := public.claim_outbound_send(ARRAY['invoice:inv-9'], 'a1', NULL, '{}'::jsonb, 600);
  IF r->>'code' <> 'send_claim_attempt_exists' THEN RAISE EXCEPTION 'contract 2: attempt id reused: %', r; END IF;

  -- 3. Extend adds a content key to a sending attempt; settle moves it once.
  r := public.extend_outbound_send_claim('a1', ARRAY['email_content:abc'], NULL, '{}'::jsonb);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'contract 3: extend refused: %', r; END IF;
  r := public.settle_outbound_send('a1', 'outcome_unknown', '{"why":"timeout"}'::jsonb);
  IF NOT (r->>'ok')::boolean OR (r->>'rows')::int <> 2 THEN RAISE EXCEPTION 'contract 3: settle: %', r; END IF;
  r := public.settle_outbound_send('a1', 'sent', '{}'::jsonb);
  IF r->>'code' <> 'send_claim_not_sending' THEN RAISE EXCEPTION 'contract 3: a second settle overwrote: %', r; END IF;
  r := public.extend_outbound_send_claim('a1', ARRAY['x:y'], NULL, '{}'::jsonb);
  IF r->>'code' <> 'send_claim_not_sending' THEN RAISE EXCEPTION 'contract 3: extended a settled attempt: %', r; END IF;

  -- 4. An unknown outcome keeps holding, and a later attempt cannot clear it.
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a3', NULL, '{}'::jsonb, 600);
  IF r->>'code' <> 'send_claim_held' THEN RAISE EXCEPTION 'contract 4: unknown did not hold: %', r; END IF;
  r := public.settle_outbound_send('a3', 'sent', '{}'::jsonb);
  IF r->>'code' <> 'send_claim_not_sending' THEN RAISE EXCEPTION 'contract 4: a stranger settled: %', r; END IF;

  -- 5. Reconcile is a compare and set on the named attempt and needs who and when.
  r := public.reconcile_outbound_send('a1', 'outcome_unknown', 'not_sent', '', now(), NULL);
  IF r->>'code' <> 'send_reconcile_actor_required' THEN RAISE EXCEPTION 'contract 5: anonymous reconcile: %', r; END IF;
  r := public.reconcile_outbound_send('a1', 'sending', 'not_sent', 'office@x', now(), NULL);
  IF r->>'code' <> 'send_reconcile_state_changed' THEN RAISE EXCEPTION 'contract 5: wrong expected state: %', r; END IF;
  r := public.reconcile_outbound_send('a1', 'outcome_unknown', 'not_sent', 'office@x', now(), 'Sent Items checked');
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'contract 5: reconcile refused: %', r; END IF;
  r := public.reconcile_outbound_send('a1', 'outcome_unknown', 'not_sent', 'office@y', now(), NULL);
  IF r->>'code' <> 'send_reconcile_state_changed' THEN RAISE EXCEPTION 'contract 5: second reconcile also won: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.outbound_send_claims WHERE attempt_id = 'a1'
                  AND state = 'reconciled_not_sent' AND reconciled_by = 'office@x'
                  AND reconcile_checked_at IS NOT NULL AND reconcile_evidence = 'Sent Items checked') THEN
    RAISE EXCEPTION 'contract 5: who, when and what were not recorded';
  END IF;
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a4', NULL, '{}'::jsonb, 600);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'contract 5: reconciled key still held: %', r; END IF;

  -- 6. A live sending attempt is never released; a lapsed one reads stale and can be.
  r := public.reconcile_outbound_send('a4', 'sending', 'not_sent', 'office@x', now(), NULL);
  IF r->>'code' <> 'send_reconcile_live_send' THEN RAISE EXCEPTION 'contract 6: released a live send: %', r; END IF;
  UPDATE public.outbound_send_claims SET lease_until = now() - interval '1 minute' WHERE attempt_id = 'a4';
  h := public.read_outbound_send_holds(ARRAY['invoice:inv-1']);
  IF jsonb_array_length(h) <> 1 OR NOT (h->0->>'stale')::boolean THEN RAISE EXCEPTION 'contract 6: lapsed send not stale: %', h; END IF;
  r := public.claim_outbound_send(ARRAY['invoice:inv-1'], 'a5', NULL, '{}'::jsonb, 600);
  IF r->>'code' <> 'send_claim_held' THEN RAISE EXCEPTION 'contract 6: a lapsed send stopped holding: %', r; END IF;
  r := public.reconcile_outbound_send('a4', 'sending', 'sent', 'office@x', now(), NULL);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'contract 6: lapsed send not reconcilable: %', r; END IF;

  -- 7. A confirmed send does not block a deliberate later send.
  r := public.claim_outbound_send(ARRAY['debt_report:org'], 'a6', NULL, '{}'::jsonb, 600);
  PERFORM public.settle_outbound_send('a6', 'sent', '{}'::jsonb);
  r := public.claim_outbound_send(ARRAY['debt_report:org'], 'a7', NULL, '{}'::jsonb, 600);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'contract 7: a sent attempt blocked the next: %', r; END IF;

  -- 8. Every step left an event, and the trail cannot be edited.
  IF (SELECT count(*) FROM public.outbound_send_claim_events WHERE event = 'claim_refused') < 3
     OR NOT EXISTS (SELECT 1 FROM public.outbound_send_claim_events WHERE event = 'reconcile_refused')
     OR NOT EXISTS (SELECT 1 FROM public.outbound_send_claim_events WHERE event = 'settle_refused') THEN
    RAISE EXCEPTION 'contract 8: refusals were not recorded';
  END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  BEGIN
    UPDATE public.outbound_send_claim_events SET actor = 'edited';
    RAISE EXCEPTION 'contract 8: the event trail was editable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

-- 9. Re-applying the migration is a no-op.
\ir ../../../migrations/20261019170000_outbound_send_claims.sql
