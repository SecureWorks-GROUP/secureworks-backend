-- Contract for 20261021150000_context_job_card_events (CTX-T22, gap G5). Proves, against the real
-- stacked schema and the live ladder triggers, on the SWP-26376 shape (three supplier emails with
-- no contact, each a candidate for two jobs): before a decision the second job's card says no
-- email is placed yet (never that there are none) and that three wait in Matching; a staff split
-- puts the three on both cards (messages, emails lane, person_placed with who and when) and
-- Matching holds none; the split line says any amount in them is unknown and money is unchanged;
-- a correct moves a row, an unrelated takes one off, an escalate and a decision whose evidence
-- moved change nothing; a job no decision touches reads byte for byte as before;
-- business_events.job_id is never written; no browser role can call the helpers. Every fixture
-- write is rolled back.
\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_function_privilege('authenticated', 'public.context_job_card_events(uuid[])', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_job_card_events(uuid[])', 'EXECUTE')
          OR has_function_privilege('authenticated', 'public.context_job_card_decisions(uuid)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_job_card_decisions(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'card events contract: a browser role holds a grant';
  END IF;
  -- The card events read must stay inlinable: plain SQL, no SET clause, not SECURITY DEFINER.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('public.context_job_card_events(uuid[])'::regprocedure,
                                                     'public.context_job_card_decisions(uuid)'::regprocedure)
             AND (p.prosecdef OR p.proconfig IS NOT NULL OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'sql'))) THEN
    RAISE EXCEPTION 'card events contract: a helper is SECURITY DEFINER, carries SET or is not SQL';
  END IF;
END $$;

BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, ghl_contact_id, created_at) VALUES
  ('7e000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-98101', 'cardev-1', '2026-09-01'),
  ('7e000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-98102', 'cardev-2', '2026-09-01'),
  ('7e000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-98103', 'cardev-3', '2026-09-01');
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('7e100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Card contract staff', 'ops_manager');
INSERT INTO public.business_events (id, channel, direction, occurred_at, payload, event_type, source) VALUES
  ('7e200000-0000-0000-0000-000000000001', 'email', 'inbound', '2026-10-08 09:10Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 & SWP-98102 confirmed","body":"Confirmed"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000002', 'email', 'inbound', '2026-10-08 09:20Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 & SWP-98102 dispatched","body":"Dispatched"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000003', 'email', 'inbound', '2026-10-08 09:30Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 & SWP-98102 invoice","body":"Invoice attached"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000004', 'email', 'inbound', '2026-10-07 09:10Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98101 placed","body":"Placed"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000005', 'email', 'inbound', '2026-10-06 09:10Z',
   '{"from":"orders@supplier.example","subject":"Delivery booked","body":"Wrong job"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000006', 'email', 'inbound', '2026-10-05 09:10Z',
   '{"from":"news@unrelated.example","subject":"Newsletter","body":"Not about a job"}', 'email.inbound', 'cardev-contract'),
  ('7e200000-0000-0000-0000-000000000007', 'email', 'inbound', '2026-10-04 09:10Z',
   '{"from":"orders@supplier.example","subject":"Order SWP-98103 placed","body":"Control"}', 'email.inbound', 'cardev-contract');
-- The SWP-26376 shape as the ladder leaves it: no identity, two candidates.
UPDATE public.business_events SET recorded_at = occurred_at, job_id = NULL, contact_id = NULL, attribution_status = 'unplaced',
  candidate_job_ids = ARRAY['7e000000-0000-0000-0000-00000000000a', '7e000000-0000-0000-0000-00000000000b']::uuid[]
WHERE id IN ('7e200000-0000-0000-0000-000000000001', '7e200000-0000-0000-0000-000000000002', '7e200000-0000-0000-0000-000000000003');
-- Rows the ladder placed on A (one stays, one a person corrects to B, one a person calls unrelated)
-- and on the control job C.
UPDATE public.business_events SET job_id = '7e000000-0000-0000-0000-00000000000a', attribution_status = 'single_open', candidate_job_ids = NULL, recorded_at = occurred_at
WHERE id IN ('7e200000-0000-0000-0000-000000000004', '7e200000-0000-0000-0000-000000000005', '7e200000-0000-0000-0000-000000000006');
UPDATE public.business_events SET job_id = '7e000000-0000-0000-0000-00000000000c', attribution_status = 'single_open', candidate_job_ids = NULL, recorded_at = occurred_at
WHERE id = '7e200000-0000-0000-0000-000000000007';

CREATE TEMP TABLE card_before AS
SELECT j.id AS job_id, public.context_job_story(j.id, '2026-10-20 05:00Z') AS story,
       (SELECT array_agg(m.source_id ORDER BY m.source_id) FROM public.context_job_record_messages(ARRAY[j.id], '2026-10-20 05:00Z') m) AS msgs,
       (SELECT array_agg(e.job_id::text || ':' || e.id::text ORDER BY e.id) FROM public.business_events e WHERE e.source = 'cardev-contract') AS placed
FROM public.jobs j WHERE j.id IN ('7e000000-0000-0000-0000-00000000000a', '7e000000-0000-0000-0000-00000000000b', '7e000000-0000-0000-0000-00000000000c');

DO $$
DECLARE a uuid := '7e000000-0000-0000-0000-00000000000a'; b uuid := '7e000000-0000-0000-0000-00000000000b';
  c uuid := '7e000000-0000-0000-0000-00000000000c'; staff uuid := '7e100000-0000-0000-0000-000000000001';
  s1 uuid := '7e200000-0000-0000-0000-000000000001'; s2 uuid := '7e200000-0000-0000-0000-000000000002';
  s3 uuid := '7e200000-0000-0000-0000-000000000003'; keep uuid := '7e200000-0000-0000-0000-000000000004';
  moved uuid := '7e200000-0000-0000-0000-000000000005'; unrel uuid := '7e200000-0000-0000-0000-000000000006';
  t timestamptz := '2026-10-20 05:00Z'; st jsonb; nk text[]; ev uuid;
BEGIN
  -- 1. Before a decision, B has no email on it but three wait in Matching: the card says none is
  --    placed yet and that three wait, never "No emails are on record".
  st := public.context_job_story(b, t);
  nk := ARRAY(SELECT x->>'what' FROM jsonb_array_elements(st->'not_known') x);
  IF 'No emails are on record for this job.' = ANY (nk) OR NOT 'No emails are placed on this job yet.' = ANY (nk)
     OR NOT '3 messages wait in Matching for a person to say which job they belong to; they may be this job''s.' = ANY (nk) THEN
    RAISE EXCEPTION 'card events contract: before, B''s not-known lines wrong: %', nk;
  END IF;
  IF st->'meta'->'matching' IS DISTINCT FROM '{"waiting":3,"more":false,"emails":3,"texts":0,"calls":0}'::jsonb
     OR (st->'meta'->'person_placed'->>'on')::int <> 0 THEN
    RAISE EXCEPTION 'card events contract: before, B''s meta wrong: % %', st->'meta'->'matching', st->'meta'->'person_placed';
  END IF;
  -- A job with nothing waiting and no email still says there are none (the old line, unchanged).
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.context_job_story(c, '2026-10-01')->'not_known') x
                 WHERE x->>'what' = 'No emails are on record for this job.'
                   AND x->>'why' = 'Emails reach a job by thread, sender or job reference.') THEN
    RAISE EXCEPTION 'card events contract: the plain no-email line changed';
  END IF;

  -- 2. A staff split of the three with the shown hashes: on both cards, and Matching holds none.
  FOREACH ev IN ARRAY ARRAY[s1, s2, s3] LOOP
    PERFORM public.context_recon_record_decision(ev, public.context_recon_evidence_hash(ev), 'split', ARRAY[a, b], 'defect:no_identity', staff);
  END LOOP;
  IF (SELECT count(*) FROM public.context_job_record_messages(ARRAY[b], t) m WHERE m.source_id IN (s1::text, s2::text, s3::text)) <> 3
     OR (SELECT count(*) FROM public.context_job_record_messages(ARRAY[a], t) m WHERE m.source_id IN (s1::text, s2::text, s3::text)) <> 3 THEN
    RAISE EXCEPTION 'card events contract: split rows not on both job records';
  END IF;
  st := public.context_job_story(b, t);
  nk := ARRAY(SELECT x->>'what' FROM jsonb_array_elements(st->'not_known') x);
  IF (st->'meta'->'sources'->>'emails') IS NULL
     OR EXISTS (SELECT 1 FROM unnest(nk) w WHERE w LIKE 'No emails %' OR w LIKE '%wait in Matching%' OR w LIKE '%waits in Matching%')
     OR NOT '3 messages on this job were also put on another job by a person; any amount in them is unknown for this job.' = ANY (nk) THEN
    RAISE EXCEPTION 'card events contract: after, B''s card wrong: % %', nk, st->'meta'->'sources';
  END IF;
  IF (st->'meta'->'matching'->>'waiting')::int <> 0
     OR st->'meta'->'person_placed'->'on' <> '3' OR st->'meta'->'person_placed'->'split' <> '3' OR st->'meta'->'person_placed'->'off' <> '0'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(st->'meta'->'person_placed'->'items') i
                    WHERE (i->>'event_id')::uuid = s3 AND i->>'placement' = 'on' AND i->>'action' = 'split'
                      AND i->>'decided_by_name' = 'Card contract staff' AND (i->>'decided_by')::uuid = staff
                      AND i->'other_job_numbers' = '["SWP-98101"]'::jsonb AND i->>'decided_at' IS NOT NULL) THEN
    RAISE EXCEPTION 'card events contract: after, B''s person_placed wrong: %', st->'meta'->'person_placed';
  END IF;
  -- The split line names its reason: money is Xero's, and sharing a bill is on hold.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(st->'not_known') x WHERE x->>'what' LIKE '3 messages on this job were also put%'
                 AND x->>'why' LIKE '%read from Xero only%' AND x->>'why' LIKE '%on hold for Finance''s allocation rule.') THEN
    RAISE EXCEPTION 'card events contract: the split line lost its reason';
  END IF;
  -- Money is unchanged on both jobs, and nothing wrote business_events.job_id.
  IF (SELECT b0.story->'money' FROM card_before b0 WHERE b0.job_id = b) IS DISTINCT FROM st->'money'
     OR (SELECT b0.story->'money' FROM card_before b0 WHERE b0.job_id = a) IS DISTINCT FROM public.context_job_story(a, t)->'money'
     OR (SELECT b0.placed FROM card_before b0 LIMIT 1) IS DISTINCT FROM
        (SELECT array_agg(e.job_id::text || ':' || e.id::text ORDER BY e.id) FROM public.business_events e WHERE e.source = 'cardev-contract') THEN
    RAISE EXCEPTION 'card events contract: money moved, or business_events.job_id was written';
  END IF;

  -- 3. A correct moves a row from A to B; an unrelated takes a row off A; an escalate changes nothing.
  PERFORM public.context_recon_record_decision(moved, public.context_recon_evidence_hash(moved), 'correct', ARRAY[b], 'ambiguity:wrong_job', staff);
  PERFORM public.context_recon_record_decision(unrel, public.context_recon_evidence_hash(unrel), 'unrelated', '{}'::uuid[], 'ambiguity:not_a_job', staff);
  PERFORM public.context_recon_record_decision(keep, public.context_recon_evidence_hash(keep), 'escalate', '{}'::uuid[], 'ambiguity:no_candidate', staff, 'finance');
  IF EXISTS (SELECT 1 FROM public.context_job_record_messages(ARRAY[a], t) m WHERE m.source_id IN (moved::text, unrel::text))
     OR NOT EXISTS (SELECT 1 FROM public.context_job_record_messages(ARRAY[b], t) m WHERE m.source_id = moved::text)
     OR NOT EXISTS (SELECT 1 FROM public.context_job_record_messages(ARRAY[a], t) m WHERE m.source_id = keep::text) THEN
    RAISE EXCEPTION 'card events contract: correct, unrelated or escalate read wrong';
  END IF;
  IF (SELECT array_agg(d.placement || ':' || d.action ORDER BY d.placement, d.action) FROM public.context_job_card_decisions(a) d
      WHERE d.event_id IN (moved, unrel)) IS DISTINCT FROM ARRAY['off:correct', 'off:unrelated']
     OR (SELECT d.other_job_numbers FROM public.context_job_card_decisions(a) d WHERE d.event_id = moved) IS DISTINCT FROM ARRAY['SWP-98102']
     OR EXISTS (SELECT 1 FROM public.context_job_card_decisions(a) d WHERE d.event_id = keep) THEN
    RAISE EXCEPTION 'card events contract: A''s decisions list wrong';
  END IF;

  -- 4. A decision whose evidence moved since changes nothing: the row is back where the ladder put it.
  UPDATE public.business_events SET payload = payload || '{"subject":"Delivery booked again"}' WHERE id = moved;
  IF EXISTS (SELECT 1 FROM public.context_job_record_messages(ARRAY[b], t) m WHERE m.source_id = moved::text)
     OR NOT EXISTS (SELECT 1 FROM public.context_job_record_messages(ARRAY[a], t) m WHERE m.source_id = moved::text) THEN
    RAISE EXCEPTION 'card events contract: a decision with moved evidence still placed the row';
  END IF;

  -- 5. A job no decision touches reads byte for byte as before.
  IF (SELECT b0.story FROM card_before b0 WHERE b0.job_id = c) IS DISTINCT FROM public.context_job_story(c, t)
     OR (SELECT b0.msgs FROM card_before b0 WHERE b0.job_id = c) IS DISTINCT FROM
        (SELECT array_agg(m.source_id ORDER BY m.source_id) FROM public.context_job_record_messages(ARRAY[c], t) m) THEN
    RAISE EXCEPTION 'card events contract: an untouched job''s card changed';
  END IF;
END $$;
ROLLBACK;
