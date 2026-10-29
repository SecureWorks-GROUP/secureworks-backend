-- Contract for 20261029220000_context_job_picture_for_event.
--
-- Synthetic jobs, people and messages, no customer data. Everything rolls back.
--
--   TP-E1    fencing, scheduled. Client phone 0400 911 001, email evt.one@.
--   TP-E2    patio, accepted. Client phone 0400 922 002, email evt.two@, and a
--            party whose email is evt.party@.
--   TP-EHOLD a holding job (do_not_schedule true) carrying TP-E1's phone: the
--            picture never describes it, so it never matches.
--
-- Messages (business_events):
--   ev-sms     inbound text from TP-E1's phone             -> phone key only
--   ev-party   inbound email from TP-E2's party            -> email key only
--   ev-both    inbound email from TP-E1, naming TP-E2's    -> both keys
--              phone as customer_phone
--   ev-ours    inbound email from our own domain, carrying TP-E1's phone
--   ev-line    inbound text from one of our five SMS lines, carrying TP-E1's phone
--   ev-supp    a supplier's email (supplier.*) naming TP-E1's email
--   ev-council a council's email naming TP-E1's phone
--   ev-out     our outbound email to our own office, payload naming TP-E1's
--              phone and email
--   an unknown event id, and a null one
--
-- Expected: the answer is context_job_picture(job_ids) asked with exactly the
-- keys context_event_identity(e) gives for that row; a match is claimed only
-- for a key the rule gives (true on the right job, false on the others); the
-- rows the rule gives no key for, and an unknown or null event, claim no match
-- at all and equal the keyless picture; no phone or email string leaves it;
-- service role only, STABLE SECURITY DEFINER; a re-apply is a no-op; a drifted
-- body is refused by both the up and the down and left as it was.
--
-- The registered stack carries B0's context_event_identity (20260924183000);
-- unplaced stage 1's widening (20261014170000) is not a registered case. Every
-- row here reads the same under both bodies, and check 1 proves the function
-- follows whichever body is live.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, created_at,
                         client_name, client_phone, client_email, site_address, site_suburb, scope_json) VALUES
  ('e5000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'TP-E1', false, '{}', '{}',
   '2026-07-01T00:00:00Z', 'Evt Client One', '0400 911 001', 'evt.one@example.test', '3 Fixture Lane', 'Testville', '{}'),
  ('e5000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'accepted', 'patio', 'TP-E2', false, '{}', '{}',
   '2026-07-01T00:00:00Z', 'Evt Client Two', '0400 922 002', 'evt.two@example.test', '9 Fixture Way', 'Sampleton', '{}'),
  ('e5000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'TP-EHOLD', false,
   '{"do_not_schedule": "true"}', '{}', '2026-07-01T00:00:00Z', 'Holding', '0400 911 001', 'evt.one@example.test', NULL, NULL, '{}');

INSERT INTO public.job_contacts (job_id, client_name, client_phone, client_email, contact_label, status, removed_at) VALUES
  ('e5000000-0000-4000-8000-000000000002', 'Evt Party', NULL, 'Evt.Party@example.test', 'B', 'active', NULL);

INSERT INTO public.business_events (id, event_type, source, channel, direction, payload, occurred_at) VALUES
  ('e5000000-0000-4000-8000-0000000000e1', 'client.sms_in', 'contract_fixture', 'sms', 'inbound',
   '{"phone": "+61 400 911 001", "body": "fixture: is the fence still booked"}', '2026-08-12T01:00:00Z'),
  ('e5000000-0000-4000-8000-0000000000e2', 'client.email_in', 'contract_fixture', 'email', 'inbound',
   '{"from": "Evt Party <EVT.PARTY@example.test>", "body": "fixture: our half of the fence"}', '2026-08-12T01:00:00Z'),
  ('e5000000-0000-4000-8000-0000000000e3', 'client.email_in', 'contract_fixture', 'email', 'inbound',
   '{"from": "Evt One <evt.one@example.test>", "customer_phone": "0400 922 002", "body": "fixture: both"}', '2026-08-12T01:00:00Z'),
  ('e5000000-0000-4000-8000-0000000000e4', 'client.email_in', 'contract_fixture', 'email', 'inbound',
   '{"from": "Office <office@secureworkswa.com.au>", "phone": "+61 400 911 001", "body": "fixture: our own words"}', '2026-08-12T01:00:00Z'),
  ('e5000000-0000-4000-8000-0000000000e5', 'client.sms_in', 'contract_fixture', 'sms', 'inbound',
   '{"from_number": "+61 489 267 771", "phone": "+61 400 911 001", "body": "fixture: sent from our line"}', '2026-08-12T01:00:00Z'),
  ('e5000000-0000-4000-8000-0000000000e6', 'supplier.email_in', 'contract_fixture', 'email', 'inbound',
   '{"from": "accounts@pic-steel.example", "customer_email": "evt.one@example.test", "body": "fixture: invoice"}', '2026-08-12T01:00:00Z'),
  ('e5000000-0000-4000-8000-0000000000e7', 'client.email_in', 'contract_fixture', 'email', 'inbound',
   '{"from": "planning@city.wa.gov.au", "customer_phone": "0400 911 001", "body": "fixture: approval"}', '2026-08-12T01:00:00Z'),
  ('e5000000-0000-4000-8000-0000000000e8', 'client.email_out', 'contract_fixture', 'email', 'outbound',
   '{"to": ["office@secureworkswa.com.au"], "phone": "+61 400 911 001", "customer_email": "evt.one@example.test", "body": "fixture: note to the office"}',
   '2026-08-12T01:00:00Z');

DO $$
DECLARE
  ids uuid[] := ARRAY['e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002',
                      'e5000000-0000-4000-8000-000000000003']::uuid[];
  keyless jsonb := public.context_job_picture(ARRAY['e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002',
                                                    'e5000000-0000-4000-8000-000000000003']::uuid[]);
  ev uuid;
  got jsonb;
  want jsonb;
  k record;
  all_out text := '';
  bad text;
  m record;
BEGIN
  IF jsonb_array_length(keyless) <> 2 THEN RAISE EXCEPTION 'job picture for event: fixture picture %', keyless; END IF;

  -- 1. The answer is the picture asked with exactly the sender rule's keys, for
  --    every fixture row: whichever body of context_event_identity is live.
  FOR ev IN SELECT id FROM public.business_events WHERE source = 'contract_fixture' ORDER BY id LOOP
    SELECT i.phone_key, i.email_key INTO k FROM public.business_events e, LATERAL public.context_event_identity(e) i WHERE e.id = ev;
    got := public.context_job_picture_for_event(ev, ids);
    want := public.context_job_picture(ids, CASE WHEN k.phone_key IS NOT NULL THEN ARRAY[k.phone_key] END,
                                            CASE WHEN k.email_key IS NOT NULL THEN ARRAY[k.email_key] END);
    IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'job picture for event: % is not the picture with its sender keys: % vs %', ev, got, want; END IF;
    all_out := all_out || got::text;
  END LOOP;

  -- 2. The customer's own rows claim a match, true only on the right job, and
  --    only for the key the rule gave.
  FOR m IN SELECT * FROM (VALUES
      ('e5000000-0000-4000-8000-0000000000e1'::uuid, 'TP-E1', '{"phones": 1, "emails": 1, "phone_match": true}'::jsonb),
      ('e5000000-0000-4000-8000-0000000000e1'::uuid, 'TP-E2', '{"phones": 1, "emails": 2, "phone_match": false}'::jsonb),
      ('e5000000-0000-4000-8000-0000000000e2'::uuid, 'TP-E1', '{"phones": 1, "emails": 1, "email_match": false}'::jsonb),
      ('e5000000-0000-4000-8000-0000000000e2'::uuid, 'TP-E2', '{"phones": 1, "emails": 2, "email_match": true}'::jsonb),
      ('e5000000-0000-4000-8000-0000000000e3'::uuid, 'TP-E1', '{"phones": 1, "emails": 1, "phone_match": false, "email_match": true}'::jsonb),
      ('e5000000-0000-4000-8000-0000000000e3'::uuid, 'TP-E2', '{"phones": 1, "emails": 2, "phone_match": true, "email_match": false}'::jsonb)
    ) v(ev, job, contacts) LOOP
    SELECT e -> 'contacts' INTO got FROM jsonb_array_elements(public.context_job_picture_for_event(m.ev, ids)) e WHERE e ->> 'job_number' = m.job;
    IF got IS DISTINCT FROM m.contacts THEN
      RAISE EXCEPTION 'job picture for event: % on % contacts % (want %)', m.ev, m.job, got, m.contacts;
    END IF;
  END LOOP;
  -- The holding job carries TP-E1's phone and is never in the picture.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.context_job_picture_for_event('e5000000-0000-4000-8000-0000000000e1', ids)) e
              WHERE e ->> 'job_number' = 'TP-EHOLD') THEN
    RAISE EXCEPTION 'job picture for event: a holding job is in the picture';
  END IF;

  -- 3. Our own rows (our domain, our SMS line, our outbound note), a
  --    supplier's and a council's give no key, so no match is claimed even
  --    though each payload names the customer's phone or email; an unknown or
  --    null event likewise. Each answer is the keyless picture exactly.
  FOR ev IN SELECT unnest(ARRAY['e5000000-0000-4000-8000-0000000000e4', 'e5000000-0000-4000-8000-0000000000e5',
                                'e5000000-0000-4000-8000-0000000000e6', 'e5000000-0000-4000-8000-0000000000e7',
                                'e5000000-0000-4000-8000-0000000000e8', 'e5000000-0000-4000-8000-0000000000ff', NULL]::uuid[]) LOOP
    got := public.context_job_picture_for_event(ev, ids);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(got) e WHERE e -> 'contacts' ?| ARRAY['phone_match', 'email_match']) THEN
      RAISE EXCEPTION 'job picture for event: a row the sender rule gives no key claims a match (%): %', coalesce(ev::text, 'null'), got;
    END IF;
    IF got IS DISTINCT FROM keyless THEN
      RAISE EXCEPTION 'job picture for event: % is not the keyless picture: %', coalesce(ev::text, 'null'), got;
    END IF;
    all_out := all_out || got::text;
  END LOOP;

  -- 4. No ids, no jobs.
  IF public.context_job_picture_for_event('e5000000-0000-4000-8000-0000000000e1', NULL) IS DISTINCT FROM '[]'::jsonb
     OR public.context_job_picture_for_event('e5000000-0000-4000-8000-0000000000e1', '{}') IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'job picture for event: no ids must give an empty picture';
  END IF;

  -- 5. No phone or email, and no key, leaves it.
  FOREACH bad IN ARRAY ARRAY['400911001', '400 911 001', '0400 911', '400922002', '400 922 002', 'example.test', 'evt.one',
    'evt.party', 'EVT.PARTY', 'secureworkswa', 'gov.au', 'pic-steel', '489267771', '489 267 771', '"phone_key"', '"email_key"',
    'fixture:'] LOOP
    IF strpos(all_out, bad) > 0 THEN RAISE EXCEPTION 'job picture for event: leaks %', bad; END IF;
  END LOOP;
END $$;

-- 6. Service role only; read only.
DO $$
DECLARE f text := 'public.context_job_picture_for_event(uuid,uuid[])';
BEGIN
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('public', f, 'EXECUTE') OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'job picture for event: grants';
  END IF;
  IF NOT (SELECT prosecdef AND provolatile = 's' AND 'search_path=public, pg_temp' = ANY (proconfig)
            FROM pg_proc WHERE oid = f::regprocedure) THEN
    RAISE EXCEPTION 'job picture for event: must be STABLE SECURITY DEFINER with its search_path';
  END IF;
END $$;

-- 7. A re-apply changes nothing.
\ir ../../../migrations/20261029220000_context_job_picture_for_event.sql
DO $$
DECLARE f text := 'public.context_job_picture_for_event(uuid,uuid[])';
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(f)) IS DISTINCT FROM '449f66a1cf7885f3cc5aea94beac36cb'
     OR has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('service_role', f, 'EXECUTE')
     OR coalesce(obj_description(f::regprocedure, 'pg_proc'), '') NOT LIKE 'Job picture for an event (20261029220000)%'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_job_picture(uuid[],text[],text[])'))
        IS DISTINCT FROM '1f3bea8abb27ea2d27b7e710185c738c' THEN
    RAISE EXCEPTION 'job picture for event: a re-apply moved something';
  END IF;
END $$;

-- 8. A later body is never overwritten or dropped on its comment alone. The
-- drifted body keeps this migration's comment, as a later migration that
-- changes only the body would. A re-apply of this migration and its rollback
-- must both refuse it, and leave it as it was.
SAVEPOINT drift_up;
CREATE OR REPLACE FUNCTION public.context_job_picture_for_event(p_event_id uuid, p_job_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $f$ SELECT '[]'::jsonb $f$;
DO $$ BEGIN
  IF coalesce(obj_description('public.context_job_picture_for_event(uuid,uuid[])'::regprocedure, 'pg_proc'), '')
     NOT LIKE 'Job picture for an event (20261029220000)%' THEN
    RAISE EXCEPTION 'job picture for event: the drifted function must keep this migration''s comment';
  END IF;
END $$;
\set ON_ERROR_STOP off
\ir ../../../migrations/20261029220000_context_job_picture_for_event.sql
\set ON_ERROR_STOP on
\if :ERROR
ROLLBACK TO SAVEPOINT drift_up;
\else
DO $$ BEGIN RAISE EXCEPTION 'job picture for event: the up migration overwrote a drifted body whose comment was kept'; END $$;
\endif

SAVEPOINT drift_down;
CREATE OR REPLACE FUNCTION public.context_job_picture_for_event(p_event_id uuid, p_job_ids uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $f$ SELECT '[]'::jsonb $f$;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261029220000_context_job_picture_for_event_down.sql
\set ON_ERROR_STOP on
\if :ERROR
ROLLBACK TO SAVEPOINT drift_down;
\else
DO $$ BEGIN RAISE EXCEPTION 'job picture for event: the down migration dropped a drifted body'; END $$;
\endif

-- Both refusals changed nothing: this migration's body is still there.
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.context_job_picture_for_event(uuid,uuid[])'))
     IS DISTINCT FROM '449f66a1cf7885f3cc5aea94beac36cb' THEN
    RAISE EXCEPTION 'job picture for event: a refused drift check left the function changed';
  END IF;
END $$;

ROLLBACK;
