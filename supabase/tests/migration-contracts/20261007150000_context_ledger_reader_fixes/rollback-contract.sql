-- Rollback contract: 20261007150000_context_ledger_reader_fixes. The runner applied the stack
-- through this migration and then its down. The four ledger store bodies and their comments are
-- 20261006013000's word for word, the five helpers are gone, grants stand, the earlier behaviour
-- is back; the down runs again cleanly, and the migration re-applies on top of its own rollback.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger reader fixes rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_restored() RETURNS void LANGUAGE plpgsql AS $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_ledger_call_customer(public.business_events)', '23f31463321396e3e5fde6329e32c60e', false),
  ('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)', '52bd1db9fb4b75fedd6cbfc755e806b3', true),
  ('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)', '7afbf2bbe6d5688219e743fda88b5eb2', true),
  ('public.context_ledger_packet(uuid,timestamptz,timestamptz)', '86bed4277fb61ce4679e5cd476001555', true)) v(sig, m, definer) LOOP
  PERFORM pg_temp.rb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(x.sig)) = x.m, x.sig || ' is not the 20261006013000 body');
  PERFORM pg_temp.rb_assert(obj_description(to_regprocedure(x.sig), 'pg_proc') LIKE 'Context ledger store (20261006013000): %'
   AND obj_description(to_regprocedure(x.sig), 'pg_proc') NOT LIKE '%ledger reader fixes%', x.sig || ' comment is not 20261006013000''s');
  PERFORM pg_temp.rb_assert((SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(x.sig)) = x.definer, x.sig || ' security changed');
  PERFORM pg_temp.rb_assert(has_function_privilege('service_role', x.sig, 'EXECUTE') AND NOT has_function_privilege('anon', x.sig, 'EXECUTE')
   AND NOT has_function_privilege('authenticated', x.sig, 'EXECUTE'), x.sig || ' grants changed');
 END LOOP;
 PERFORM pg_temp.rb_assert(NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
   ('context_ledger_elsewhere_claim', 'context_ledger_paid_close_at', 'context_ledger_work_order_key', 'context_ledger_row_elsewhere',
    'context_ledger_siblings')), 'a helper of this migration is left');
END $$;

SELECT pg_temp.rb_restored();

-- The earlier behaviour: a customer's transcribe-call transcript with no call row on the job is no
-- one's (a bare null), the packet has no siblings section, and a request made the day its invoice
-- was paid is refused on that payment.
BEGIN;
DO $c$
DECLARE j uuid := 'f1500000-0000-4000-8000-0000000000b1'; t uuid := 'f15b0000-0000-4000-8000-0000000000b1';
 r uuid := 'f15b0000-0000-4000-8000-0000000000b2'; x uuid := 'f15c0000-0000-4000-8000-0000000000b1'; pk jsonb; chk jsonb;
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'scheduled', 'patio', 'SWP-97501', 'Pat Example', 'rb@example.test', 'rb-ct', 'Testville', '{}',
  '2026-05-01 00:00Z');
 PERFORM set_config('session_replication_role', 'replica', true);
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id, payload, metadata,
  occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 VALUES (t, j, 'call.transcript_completed', 'transcribe-call', 'call', 'inbound', 'rb-ct', NULL,
   '{"body":"Yes we are happy to go ahead with the patio","ghl_call_id":"rb-ct:2026-05-08T01:37:38.842Z"}',
   '{"written_as":"service_role","party_roles":{"version":"party_roles_v1","basis":"job_customer","counterpart_role":"customer","sender_role":"customer","recipient_role":"staff","audience":"customer"}}',
   '2026-05-08 01:37:38Z', '2026-05-08 01:37:38Z', '2026-05-08 01:37:38Z', '2026-05-08 01:37:38Z', 'direct', 1, 1, '2026-05-08 01:37:38Z', 'direct_job_id'),
  (r, j, 'client.sms_out', 'ghl', 'sms', 'outbound', 'rb-ct', NULL, '{"body":"Once the upfront payment is received I will come out to measure up."}',
   '{"written_as":"service_role","party_roles":{"version":"party_roles_v2","basis":"job_customer","counterpart_role":"customer","sender_role":"staff","recipient_role":"customer","audience":"customer"}}',
   '2026-09-08 04:16:12Z', '2026-09-08 04:16:12Z', '2026-09-08 04:16:12Z', '2026-09-08 04:16:12Z', 'direct', 1, 1, '2026-09-08 04:16:12Z', 'direct_job_id');
 PERFORM set_config('session_replication_role', 'origin', true);
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_type, job_id, invoice_number, status, invoice_date, total, amount_due,
  fully_paid_on, created_at, updated_at)
 VALUES (x, '00000000-0000-0000-0000-000000000001', 'xi-rb-1', 'ACCREC', j, 'INV-97501', 'PAID', '2026-09-29', 100, 0, '2026-09-08',
  '2026-09-29 04:17Z', '2026-09-29 04:17Z');
 pk := public.context_ledger_packet(j, NULL, '2026-10-07 02:00Z');
 PERFORM pg_temp.rb_assert(NOT pk ? 'siblings' AND pk -> 'evidence' -> 0 -> 'call_customer' = 'null'::jsonb AND NOT (pk -> 'evidence' -> 0) ? 'elsewhere',
  'the earlier packet: ' || pk::text);
 chk := public.context_ledger_check_item(j, jsonb_build_object('ref', 'p', 'item_type', 'request', 'status', 'closed', 'from_role', 'us', 'to_role', 'customer',
  'what', 'We asked for the upfront payment.', 'closes_on', 'payment',
  'opened_by', jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', r::text, 'excerpt', 'the upfront payment is received')),
  'closed_by', jsonb_build_array(jsonb_build_object('table', 'xero_invoices', 'id', x::text, 'excerpt', NULL))), 'model');
 PERFORM pg_temp.rb_assert(chk ->> 'code' = 'closing_before_opening', 'the earlier paid-day rule: ' || chk::text);
END $c$;
ROLLBACK;

-- The down runs again cleanly (it accepts the bodies it restored).
BEGIN;
\ir ../../../rollbacks/20261007150000_context_ledger_reader_fixes_down.sql
SELECT pg_temp.rb_restored();
ROLLBACK;

-- The migration re-applies on top of its own rollback.
BEGIN;
\ir ../../../migrations/20261007150000_context_ledger_reader_fixes.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert((SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN
   ('context_ledger_elsewhere_claim', 'context_ledger_paid_close_at', 'context_ledger_work_order_key', 'context_ledger_row_elsewhere',
    'context_ledger_siblings')) = 5
  AND obj_description('public.context_ledger_packet(uuid,timestamptz,timestamptz)'::regprocedure, 'pg_proc')
   LIKE 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): %', 'the migration re-applies over its rollback');
END $c$;
ROLLBACK;
