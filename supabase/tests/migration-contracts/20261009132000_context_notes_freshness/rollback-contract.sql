-- Rollback contract: 20261009132000_context_notes_freshness. The runner applied the stack through
-- this migration and then its down. The four bodies and their comments are the earlier ones word
-- for word (20261007010000's judge, 20261006013000's due list and sweep, 20261006040000's story
-- ledger read), the rule is gone, flags and grants stand, the earlier behaviour is back (the sweep
-- promotes a shadow with a row it has not read); the down runs again cleanly, and the migration
-- re-applies on top of its own rollback.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'notes freshness rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_restored() RETURNS void LANGUAGE plpgsql AS $$
DECLARE x record; p record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_judge(uuid[])', 'eb359d521397c8be161bfef6421a35c9', '60fc12331d4cb13a14c0c086b9b1dd09', 's'),
  ('public.context_ledger_due(integer)', 'b546910aafd7eed12660049e363cd587', '0070b9c6f52d6dc047decca79b33b6ed', 's'),
  ('public.context_ledger_promote_shadow(text,uuid[],integer)', 'b79bea76d5ee2c72670ef7d950beaeb1', '08c3f6ff6a2a8fafa61ff7f99910187b', 'v'),
  ('public.context_job_story_ledger(uuid,uuid,timestamptz)', '273c0612f9778905c18e86878402898f', 'e12001db27f9dcbb32c7405d22ba18e0', 's')
 ) v(sig, m, cm, vol) LOOP
  SELECT md5(pr.prosrc) AS m, md5(obj_description(pr.oid, 'pg_proc')) AS cm, pr.prosecdef, pr.proconfig, pr.provolatile INTO p
  FROM pg_proc pr WHERE pr.oid = to_regprocedure(x.sig);
  PERFORM pg_temp.rb_assert(p.m = x.m, x.sig || ' is not the earlier body');
  PERFORM pg_temp.rb_assert(p.cm = x.cm, x.sig || ' comment is not the earlier one word for word');
  PERFORM pg_temp.rb_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND p.provolatile = x.vol,
   x.sig || ' flags changed');
  PERFORM pg_temp.rb_assert(has_function_privilege('service_role', x.sig, 'EXECUTE') AND NOT has_function_privilege('anon', x.sig, 'EXECUTE')
   AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE'), x.sig || ' grants changed');
 END LOOP;
 PERFORM pg_temp.rb_assert(to_regprocedure('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)') IS NULL, 'the rule is left');
END $$;

SELECT pg_temp.rb_restored();

-- The earlier behaviour: the sweep promotes a passing shadow although a message landed after it.
BEGIN;
DO $c$
DECLARE j uuid := gen_random_uuid(); g uuid; v jsonb;
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live', calls_per_day = 50, reader = 'luna-ledger:v2', job_ids = NULL;
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-99601', 'Pat Example', NULL, 'ghl-SWF-99601', 'Testville', '{}',
  now() - interval '60 days');
 PERFORM set_config('session_replication_role', 'replica', true);
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, payload, metadata, occurred_at, event_at, recorded_at,
  context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 VALUES (gen_random_uuid(), j, 'client.reply', 'ledger_contract', 'sms', 'inbound', '{"body":"Can you come on Tuesday instead?"}',
  '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","sender_role":"customer","recipient_role":"staff","counterpart_role":"customer","basis":"job_customer","audience":"customer"}}',
  now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 'direct', 1, 1, now() - interval '1 day',
  'direct_job_id');
 PERFORM set_config('session_replication_role', 'origin', true);
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, evidence_until, created_at, finished_at, updated_at, checks)
 VALUES (j, 'backfill', 'shadow', 'luna-ledger:v2', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days',
  now() - interval '2 days', '{"passed": true, "store": {"pass": true}}')
 RETURNING id INTO g;
 v := public.context_ledger_promote_shadow('rule:notes-freshness-rollback', ARRAY[j]);
 PERFORM pg_temp.rb_assert((v ->> 'promoted')::int = 1 AND (SELECT status FROM public.context_ledger_generations WHERE id = g) = 'live',
  'the earlier sweep promotes it: ' || v::text);
END $c$;
ROLLBACK;

-- A second run of the down changes nothing.
\ir ../../../rollbacks/20261009132000_context_notes_freshness_down.sql
SELECT pg_temp.rb_restored();

-- The migration re-applies on top of its own rollback.
BEGIN;
\ir ../../../migrations/20261009132000_context_notes_freshness.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert(NOT EXISTS (SELECT 1 FROM (VALUES
     ('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)', 'a684b7d9c649cfa8424e4cb0a928c2ef'),
     ('public.context_ledger_judge(uuid[])', 'e0809f08f49e10d500464b2c57e60461'),
     ('public.context_ledger_due(integer)', '306bab3434fca5b6ced5f1d040f5cad1'),
     ('public.context_ledger_promote_shadow(text,uuid[],integer)', 'f3a73161410c6da869af7652235d43c5'),
     ('public.context_job_story_ledger(uuid,uuid,timestamptz)', 'b27d9f6c0abdd7174f38b0ed5e1ac5f0')) v(sig, m)
   WHERE (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.m), 'the migration re-applies over its rollback');
END $c$;
ROLLBACK;
