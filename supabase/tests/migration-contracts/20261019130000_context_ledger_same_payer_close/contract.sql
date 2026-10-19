-- Contract: 20261019130000_context_ledger_same_payer_close (context T16 fix 2). Every fixture write is
-- rolled back. Job numbers (SWF-9xxxx, SWP-9xxxx, SWMS-9xxxx), parties, Xero contacts (XC-*), CRM
-- contacts (G-*) and words are synthetic: the 38 trap cases of context-system/t16-fix2/fixtures.md,
-- nothing from production. Every fixture is dated at a fixed instant in July to September 2026.
-- Evidence rows are written with session_replication_role replica, so each states exactly the
-- columns the store reads.
--
--  1. Shape: the ten new functions (per-row helpers carry no SET clause and are not definers; the
--     switch reader is), service role only, this migration's comment marker on every new function and
--     on the three replaced bodies (after the earlier slices' text), the three columns and their
--     check, the builder contact table (RLS on, service role only, empty) and the switch row, off.
--  2. The invoice kind: context_ledger_invoice_kind_of answers the one fixture table the Debt tab's
--     invoiceKindOf is proved on (ops-api/invoice_kind_fixtures.ts; the FIXTURES block below must be
--     exactly that table: ops-api/invoice_kind_contract_rows_test.ts), and the obligation kind.
--  3. Off is today, byte for byte: the 38 fixtures run through the item check (path A: closed_by on an
--     insert) and through the write (path B: an open item, then a closing transition), once on the
--     bodies before this migration (its down, inside a savepoint) and once on this migration's bodies
--     with the switch off. Every check answer, write answer and stored row is identical (the three
--     new columns null).
--  4. On: every fixture answers its expected outcome (C closed, O open and certain, O? open and payer
--     not certain or settled job needs person) on both paths, the two paths agree on the outcome and
--     the reason, a closed answer on is a closed answer off (it only lowers or holds the closes), and
--     citation_off_job, closing_before_opening and closing_not_issued still refuse first.
--  5. The builder mapping: with no builder contact listed, a builder's own paid invoice no longer
--     closes its payment item (O?, builder_contact_unmapped).
--  6. Re-applying the migration changes nothing.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.sp_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'same payer close contract: %', p_msg; END IF; END $$;
-- Fixture ids: kind 0 job, 1 party, 2 business event, 3 invoice, 4 app event, 5 system email, 6 company.
CREATE FUNCTION pg_temp.sp_id(p_kind integer, p_n integer, p_k integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT format('a16%s0000-0000-4000-8000-%s', p_kind, lpad((p_n * 100 + p_k)::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.sp_job(p_n integer, p_k integer, p_number text, p_type text DEFAULT 'fencing',
 p_status text DEFAULT 'scheduled', p_xero text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := pg_temp.sp_id(0, p_n, p_k);
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, xero_contact_id, site_suburb, metadata, created_at)
 VALUES (v, '00000000-0000-0000-0000-000000000001', p_status, p_type, p_number, 'Pat Example', p_xero, 'Testville', '{}', '2026-07-01 00:00Z');
 IF p_type = 'makesafe' THEN
  INSERT INTO public.makesafe_job_details (job_id, requesting_company_slug, requesting_company_name, external_ref, requesting_company_id)
  VALUES (v, 'spc-b1', 'Builder One Test', 'MLB-77' || lpad(p_n::text, 3, '0'), pg_temp.sp_id(6, 0, 1));
 END IF;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.sp_party(p_n integer, p_k integer, p_job uuid, p_key text, p_role text, p_primary boolean, p_ghl text,
 p_xero text, p_share numeric DEFAULT 50, p_removed boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := pg_temp.sp_id(1, p_n, p_k);
BEGIN
 INSERT INTO public.job_contacts (id, job_id, is_primary, ghl_contact_id, xero_contact_id, share_percentage, party_role, source_party_key,
  status, removed_at, client_name, contact_type, created_at)
 VALUES (v, p_job, p_primary, p_ghl, p_xero, p_share, p_role, p_key, CASE WHEN p_removed THEN 'removed' ELSE 'active' END,
  CASE WHEN p_removed THEN '2026-08-15 00:00Z'::timestamptz END, 'Party ' || p_k, CASE WHEN p_primary THEN 'primary' ELSE 'neighbour' END,
  '2026-07-01 00:00Z'::timestamptz + p_k * interval '1 day');
 RETURN v;
END $$;
-- A placed evidence row, every column the store reads stated.
CREATE FUNCTION pg_temp.sp_ev(p_n integer, p_k integer, p_job uuid, p_type text, p_channel text, p_direction text, p_body text,
 p_at timestamptz, p_contact text, p_payload jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := pg_temp.sp_id(2, p_n, p_k);
BEGIN
 INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, provider_message_id, payload, metadata,
  occurred_at, event_at, recorded_at, context_captured_at, attribution_status, attribution_step, attribution_confidence, attributed_at, match_method)
 VALUES (v, p_job, p_type, 'ledger_contract', p_channel, p_direction, p_contact, NULL, jsonb_build_object('body', p_body) || p_payload,
  jsonb_build_object('written_as', 'service_role'), p_at, p_at, p_at, p_at, 'direct', 1, 1, p_at, 'direct_job_id');
 RETURN v;
END $$;
-- A customer's (or a party's) text in, and our staff's note.
CREATE FUNCTION pg_temp.sp_text(p_n integer, p_k integer, p_job uuid, p_body text, p_at timestamptz, p_contact text) RETURNS uuid
LANGUAGE sql AS $$ SELECT pg_temp.sp_ev(p_n, p_k, p_job, 'client.sms_in', 'sms', 'inbound', p_body, p_at, p_contact) $$;
CREATE FUNCTION pg_temp.sp_note(p_n integer, p_k integer, p_job uuid, p_body text, p_at timestamptz, p_user text DEFAULT 'ghl-s1') RETURNS uuid
LANGUAGE sql AS $$ SELECT pg_temp.sp_ev(p_n, p_k, p_job, 'note.added', 'note', 'outbound', p_body, p_at, NULL, jsonb_build_object('sent_by_user', p_user)) $$;
CREATE FUNCTION pg_temp.sp_inv(p_n integer, p_k integer, p_job uuid, p_type text, p_status text, p_ref text, p_desc text, p_total numeric,
 p_due numeric, p_paid numeric, p_paid_on date, p_party uuid, p_xero text, p_raw jsonb DEFAULT NULL, p_date date DEFAULT '2026-08-25')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := pg_temp.sp_id(3, p_n, p_k);
BEGIN
 INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_type, job_id, invoice_number, reference, status, invoice_date, due_date,
  total, amount_due, amount_paid, fully_paid_on, job_contact_id, xero_contact_id, line_items, raw_json, created_at, updated_at)
 VALUES (v, '00000000-0000-0000-0000-000000000001', 'xi-sp-' || v, p_type, p_job, 'INV-9' || lpad((p_n * 10 + p_k)::text, 4, '0'), p_ref, p_status,
  p_date, p_date + 14, p_total, p_due, p_paid, p_paid_on, p_party, p_xero, jsonb_build_array(jsonb_build_object('Description', p_desc)),
  p_raw, p_date::timestamptz, p_date::timestamptz);
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.sp_je(p_n integer, p_k integer, p_job uuid, p_type text, p_at timestamptz, p_detail jsonb DEFAULT '{}') RETURNS uuid
LANGUAGE plpgsql SET session_replication_role = replica AS $$
DECLARE v uuid := pg_temp.sp_id(4, p_n, p_k);
BEGIN
 INSERT INTO public.job_events (id, job_id, event_type, detail_json, created_at) VALUES (v, p_job, p_type, p_detail, p_at);
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.sp_ee(p_n integer, p_k integer, p_job uuid, p_type text, p_at timestamptz) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := pg_temp.sp_id(5, p_n, p_k);
BEGIN
 INSERT INTO public.email_events (id, job_id, email_type, recipient, subject, status, sent_at, created_at, metadata)
 VALUES (v, p_job, p_type, 'customer@example.test', 'Payment reminder', 'sent', p_at, p_at, '{}');
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.sp_c(p_table text, p_id uuid, p_excerpt text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('table', p_table, 'id', p_id::text, 'excerpt', p_excerpt) $$;
CREATE FUNCTION pg_temp.sp_cb(p_id uuid, p_excerpt text) RETURNS jsonb LANGUAGE sql AS $$ SELECT pg_temp.sp_c('business_events', p_id, p_excerpt) $$;
CREATE FUNCTION pg_temp.sp_cx(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT pg_temp.sp_c('xero_invoices', p_id) $$;

-- The fixtures: one row each, the item in its closed form (open when it has no closing citation).
CREATE TEMP TABLE sp_fx (n integer PRIMARY KEY, job uuid NOT NULL, item jsonb NOT NULL, expected text NOT NULL, reason text);
CREATE TEMP TABLE sp_gen (job uuid PRIMARY KEY, run_id uuid, lease uuid, gen uuid);
CREATE FUNCTION pg_temp.sp_fx_add(p_n integer, p_job uuid, p_type text, p_closes_on text, p_blocks text, p_from text, p_what text,
 p_open jsonb, p_close jsonb, p_expected text, p_reason text, p_about text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
 INSERT INTO sp_fx VALUES (p_n, p_job, jsonb_build_object('ref', 'f' || p_n, 'item_type', p_type,
  'status', CASE WHEN p_close IS NULL THEN 'open' ELSE 'closed' END, 'from_role', p_from, 'to_role', 'us', 'what', p_what,
  'opened_by', p_open, 'closes_on', p_closes_on, 'blocks', p_blocks, 'about_key', p_about)
  || CASE WHEN p_close IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('closed_by', p_close) END, p_expected, p_reason) $$;

-- An outcome: C closed, O open (certain, or never judged), O? open and not certain.
CREATE FUNCTION pg_temp.sp_out(p_status text, p_certainty text) RETURNS text LANGUAGE sql AS $$
 SELECT CASE WHEN p_status = 'closed' THEN 'C' WHEN p_status = 'open' AND p_certainty IN ('payer_not_certain', 'settled_job_needs_person') THEN 'O?'
             WHEN p_status = 'open' THEN 'O' ELSE 'status:' || coalesce(p_status, 'none') END $$;
-- Path A: the item check on the closed item; a close an existing rule refuses (citation_off_job,
-- closing_before_opening, closing_not_issued) is written open, so its open form is checked too.
CREATE FUNCTION pg_temp.sp_a(p_job uuid, p_item jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; r2 jsonb; it jsonb; c text;
BEGIN
 r := public.context_ledger_check_item(p_job, p_item, 'model');
 IF (r ->> 'ok')::boolean THEN it := r -> 'item';
 ELSE
  c := r ->> 'code';
  IF c IN ('citation_off_job', 'closing_before_opening', 'closing_not_issued') THEN
   r2 := public.context_ledger_check_item(p_job, (p_item - 'closed_by') || '{"status":"open"}', 'model');
   IF (r2 ->> 'ok')::boolean THEN it := r2 -> 'item'; END IF;
  END IF;
 END IF;
 RETURN jsonb_build_object('outcome', CASE WHEN it IS NULL THEN 'refused' ELSE pg_temp.sp_out(it ->> 'status', it ->> 'obligation_certainty') END,
  'code', c, 'reason', it #>> '{obligation_ref,reason}', 'check', r, 'check_open', r2);
END $$;
-- Path B: the write, an open item first, then the closing transition with the closed item's citations.
CREATE FUNCTION pg_temp.sp_b(p_job uuid, p_item jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE g sp_gen; res jsonb; tres jsonb; k text; rw jsonb; c text;
BEGIN
 SELECT * INTO g FROM sp_gen WHERE job = p_job;
 IF g.job IS NULL THEN
  g.job := p_job;
  INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq)
  VALUES (p_job, (now() AT TIME ZONE 'Australia/Perth')::date, 'ledger', 'running', gen_random_uuid(), now() + interval '1 hour', 1)
  RETURNING id, lease_token INTO g.run_id, g.lease;
  INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, run_id) VALUES (p_job, 'backfill', 'building', 'luna-ledger:v1', g.run_id)
  RETURNING id INTO g.gen;
  INSERT INTO sp_gen SELECT g.*;
 END IF;
 res := public.context_ledger_write(g.run_id, g.lease, g.gen, jsonb_build_array((p_item - 'closed_by') || '{"status":"open"}'), '[]', 'luna-ledger:v1');
 k := res #>> '{accepted,0,item_key}';
 IF k IS NULL THEN
  RETURN jsonb_build_object('outcome', 'refused', 'code', res #>> '{refused,0,code}', 'write', res - 'generation_id');
 END IF;
 IF p_item ? 'closed_by' THEN
  tres := public.context_ledger_write(g.run_id, g.lease, g.gen, '[]',
   jsonb_build_array(jsonb_build_object('item_key', k, 'to_status', 'closed', 'evidence', p_item -> 'closed_by')), 'luna-ledger:v1');
  c := tres #>> '{transitions_refused,0,code}';
 END IF;
 SELECT to_jsonb(i) INTO rw FROM public.context_ledger_items i WHERE i.generation_id = g.gen AND i.item_key = k;
 RETURN jsonb_build_object('outcome', pg_temp.sp_out(rw ->> 'status', rw ->> 'certainty'), 'code', c, 'reason', rw #>> '{obligation_ref,reason}',
  'write', res - 'generation_id', 'transition', tres - 'generation_id',
  'row', rw - 'id' - 'generation_id' - 'created_at' - 'updated_at' - 'obligated_party' - 'obligation_ref' - 'certainty',
  'new_columns_null', coalesce(rw -> 'obligated_party', 'null') = 'null' AND coalesce(rw -> 'obligation_ref', 'null') = 'null'
   AND coalesce(rw -> 'certainty', 'null') = 'null');
END $$;
-- Both paths over the fixtures, every write undone (the answers leave in the error message).
CREATE FUNCTION pg_temp.sp_run(p_only integer[] DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb := '{}'; f record;
BEGIN
 BEGIN
  FOR f IN SELECT * FROM sp_fx WHERE p_only IS NULL OR n = ANY(p_only) ORDER BY n LOOP
   v := v || jsonb_build_object(f.n::text, jsonb_build_object('a', pg_temp.sp_a(f.job, f.item), 'b', pg_temp.sp_b(f.job, f.item)));
  END LOOP;
  RAISE EXCEPTION USING ERRCODE = 'P0S16', MESSAGE = v::text;
 EXCEPTION WHEN SQLSTATE 'P0S16' THEN
  RETURN SQLERRM::jsonb;
 END;
END $$;
-- The expected outcomes on: both paths, the same reason, a close on is a close off, the earlier
-- refusals first; the off answers equal today's.
CREATE FUNCTION pg_temp.sp_verify(p_base jsonb, p_off jsonb, p_on jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE f record; a jsonb; b jsonb; o jsonb; want_b text; n_on integer := 0; n_base integer := 0; summary text := '';
BEGIN
 PERFORM pg_temp.sp_assert(p_off = p_base, 'switch off is not today''s answer byte for byte');
 FOR f IN SELECT * FROM sp_fx ORDER BY n LOOP
  a := p_on #> ARRAY[f.n::text, 'a']; b := p_on #> ARRAY[f.n::text, 'b']; o := p_base -> f.n::text;
  PERFORM pg_temp.sp_assert((o #>> '{b,new_columns_null}')::boolean, format('fixture %s: off, the new columns are written', f.n));
  PERFORM pg_temp.sp_assert(a ->> 'outcome' = f.expected, format('fixture %s path A (item check): %s, want %s: %s', f.n, a ->> 'outcome', f.expected, a));
  PERFORM pg_temp.sp_assert(b ->> 'outcome' = f.expected, format('fixture %s path B (write): %s, want %s: %s', f.n, b ->> 'outcome', f.expected, b));
  PERFORM pg_temp.sp_assert(a ->> 'reason' IS NOT DISTINCT FROM b ->> 'reason',
   format('fixture %s: the two paths give different reasons: %s, %s', f.n, a ->> 'reason', b ->> 'reason'));
  PERFORM pg_temp.sp_assert(f.reason IS NULL OR a ->> 'reason' = f.reason, format('fixture %s: reason %s, want %s', f.n, a ->> 'reason', f.reason));
  want_b := CASE WHEN a ->> 'code' = 'closing_before_opening' THEN 'evidence_older_than_item' WHEN a ->> 'code' IS NOT NULL THEN a ->> 'code'
                 WHEN f.item ? 'closed_by' AND f.expected <> 'C' THEN 'obligation_not_closed' END;
  PERFORM pg_temp.sp_assert(b ->> 'code' IS NOT DISTINCT FROM want_b, format('fixture %s: the transition answered %s, want %s', f.n, b ->> 'code', want_b));
  -- the earlier refusals still come first, as they did off
  PERFORM pg_temp.sp_assert(a ->> 'code' IS NOT DISTINCT FROM o #>> '{a,code}', format('fixture %s: an earlier refusal moved: %s, off %s', f.n, a ->> 'code', o #>> '{a,code}'));
  -- it only lowers or holds the closes
  PERFORM pg_temp.sp_assert(f.expected <> 'C' OR (o #>> '{a,outcome}' = 'C' AND o #>> '{b,outcome}' = 'C'), format('fixture %s closes on but not off', f.n));
  IF a ->> 'outcome' = 'C' THEN n_on := n_on + 1; END IF;
  IF o #>> '{a,outcome}' = 'C' THEN n_base := n_base + 1; END IF;
  summary := summary || format('%s:%s/%s ', f.n, o #>> '{a,outcome}', a ->> 'outcome');
 END LOOP;
 PERFORM pg_temp.sp_assert(n_on <= n_base, format('more closes on (%s) than off (%s)', n_on, n_base));
 RETURN format('closes off %s, on %s; %s', n_base, n_on, summary);
END $$;

-- 1. Shape.
DO $c$
DECLARE f text; p record;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_ledger_same_payer_close_on()', 'public.context_ledger_invoice_kind_of(text,text)',
  'public.context_ledger_obligation_kind(text,text)', 'public.context_ledger_obligation_class(text,text)',
  'public.context_ledger_invoice_payer(uuid,uuid,text)', 'public.context_ledger_invoice_facts(public.xero_invoices)',
  'public.context_ledger_obligation_job_facts(uuid)', 'public.context_ledger_obligation_payer_match(jsonb,jsonb,jsonb)',
  'public.context_ledger_obligated_party(jsonb,jsonb,jsonb)', 'public.context_ledger_obligation_closes(jsonb,jsonb)',
  'public.context_ledger_cite(uuid,jsonb)', 'public.context_ledger_check_item(uuid,jsonb,text,uuid,text)',
  'public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'] LOOP
  PERFORM pg_temp.sp_assert(to_regprocedure(f) IS NOT NULL, f || ' missing');
  PERFORM pg_temp.sp_assert(has_function_privilege('service_role', f, 'EXECUTE'), f || ' not executable by service_role');
  PERFORM pg_temp.sp_assert(NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
   f || ' executable by anon or authenticated');
  PERFORM pg_temp.sp_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), f || ' executable by PUBLIC');
 END LOOP;
 FOR p IN SELECT pp.oid::regprocedure::text AS sig, pp.proname, pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c
  FROM pg_proc pp WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname IN ('context_ledger_same_payer_close_on',
   'context_ledger_invoice_kind_of', 'context_ledger_obligation_kind', 'context_ledger_obligation_class', 'context_ledger_invoice_payer',
   'context_ledger_invoice_facts', 'context_ledger_obligation_job_facts', 'context_ledger_obligation_payer_match',
   'context_ledger_obligated_party', 'context_ledger_obligation_closes') LOOP
  PERFORM pg_temp.sp_assert(p.c LIKE 'Same payer close (20261019130000): %', p.sig || ' comment is not this migration''s');
  IF p.proname = 'context_ledger_same_payer_close_on' THEN
   PERFORM pg_temp.sp_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], p.sig || ' must be definer with search_path public, pg_temp');
  ELSE
   -- per-row helpers: no SET clause (it would block inlining), not definers
   PERFORM pg_temp.sp_assert(NOT p.prosecdef AND p.proconfig IS NULL, p.sig || ' must be a plain helper with no SET clause');
  END IF;
 END LOOP;
 PERFORM pg_temp.sp_assert((SELECT count(*) FROM pg_proc pp WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname IN ('context_ledger_same_payer_close_on',
   'context_ledger_invoice_kind_of', 'context_ledger_obligation_kind', 'context_ledger_obligation_class', 'context_ledger_invoice_payer',
   'context_ledger_invoice_facts', 'context_ledger_obligation_job_facts', 'context_ledger_obligation_payer_match',
   'context_ledger_obligated_party', 'context_ledger_obligation_closes')) = 10, 'ten new functions, one signature each');
 FOR p IN SELECT pp.oid::regprocedure::text AS sig, pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c
  FROM pg_proc pp WHERE pp.oid IN (to_regprocedure('public.context_ledger_cite(uuid,jsonb)'),
   to_regprocedure('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)'), to_regprocedure('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)')) LOOP
  PERFORM pg_temp.sp_assert(p.c LIKE 'Context ledger store (20261006013000)%' AND p.c LIKE '% Same payer close (20261019130000): %',
   p.sig || ' keeps the store''s comment first and names this slice');
  PERFORM pg_temp.sp_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], p.sig || ' must stay definer');
 END LOOP;
 PERFORM pg_temp.sp_assert((SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_items'
   AND ((column_name IN ('obligated_party', 'obligation_ref') AND data_type = 'jsonb') OR (column_name = 'certainty' AND data_type = 'text'))
   AND is_nullable = 'YES') = 3, 'the three nullable columns');
 PERFORM pg_temp.sp_assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_items'::regclass
   AND conname = 'context_ledger_items_certainty_check'), 'the certainty check');
 PERFORM pg_temp.sp_assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_ledger_builder_contacts'::regclass),
  'the builder contact table has row security');
 PERFORM pg_temp.sp_assert(NOT has_table_privilege('anon', 'public.context_ledger_builder_contacts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.context_ledger_builder_contacts', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.context_ledger_builder_contacts', 'INSERT')
  AND has_table_privilege('service_role', 'public.context_ledger_builder_contacts', 'SELECT'), 'the builder contact table is the service role''s only');
 PERFORM pg_temp.sp_assert(obj_description('public.context_ledger_builder_contacts'::regclass, 'pg_class') LIKE 'Same payer close (20261019130000): %',
  'the builder contact table comment');
 PERFORM pg_temp.sp_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_builder_contacts), 'the builder contact table is created empty: no mapping by name');
 PERFORM pg_temp.sp_assert(EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_ledger_same_payer_close_v1' AND enabled IS FALSE)
  AND NOT public.context_ledger_same_payer_close_on(), 'the switch row exists, off');
END $c$;

-- 2. The invoice kind (the Debt tab's one reader and its SQL twin, on one fixture table).
DO $c$
DECLARE x record; got jsonb; n integer := 0;
BEGIN
 FOR x IN SELECT * FROM (VALUES
-- FIXTURES BEGIN
 ('final FIN','SWF-90037-FIN','Balance of the fence','{"kind":"final","stage":null}'::jsonb),
 ('final FINBAL50','SWF-90037-FINBAL50','Balance owing','{"kind":"final","stage":null}'::jsonb),
 ('final BAL with digits','SWF-90037-BAL25','Remaining 25%','{"kind":"final","stage":null}'::jsonb),
 ('final FINAL','SWF-90037-FINAL','Remainder of the job','{"kind":"final","stage":null}'::jsonb),
 ('final PRIVATE','SWM-90037-PRIVATE','Balance','{"kind":"final","stage":null}'::jsonb),
 ('neighbour letter before the ending','SWF-90037-A-FINBAL','Balance owing','{"kind":"final","stage":null}'::jsonb),
 ('neighbour letter after the ending','SWF-90037-FINBAL-B','Balance owing','{"kind":"final","stage":null}'::jsonb),
 ('lower case and spaces',' swf - 90037 - fin ','  BALANCE of fence ','{"kind":"final","stage":null}'::jsonb),
 ('ending with a trailing word','SWF-90037-FIN 2nd','Balance','{"kind":"final","stage":null}'::jsonb),
 ('punctuation stripped','SWF-90037-FIN.','Balance','{"kind":"final","stage":null}'::jsonb),
 ('final ending, other description','SWF-90037-FIN','Deposit','{"kind":null,"stage":null}'::jsonb),
 ('four digits is not a final ending','SWF-90037-FIN1234','Balance','{"kind":null,"stage":null}'::jsonb),
 ('deposit','SWF-90037-DEP','Deposit 30%','{"kind":"not_final","stage":"deposit"}'::jsonb),
 ('deposit with digits','SWF-90037-DEP50','deposit of half','{"kind":"not_final","stage":"deposit"}'::jsonb),
 ('deposit ending, other description','SWF-90037-DEP','Balance','{"kind":null,"stage":null}'::jsonb),
 ('materials','SWP-90037-MAT','Materials order','{"kind":"not_final","stage":"materials"}'::jsonb),
 ('progress','SWP-90037-PROG2','Progress claim 2','{"kind":"not_final","stage":"progress"}'::jsonb),
 ('planning fee','SWP-90037-PLAN','Planning fee for council','{"kind":"not_final","stage":"planning fee"}'::jsonb),
 ('planning ending with digits','SWP-90037-PLAN1','Planning fee','{"kind":null,"stage":null}'::jsonb),
 ('variation','SWF-90038-VAR','Extra labour for rock','{"kind":"not_final","stage":"extra labour"}'::jsonb),
 ('variation ending, other description','SWF-90038-VAR','Variation','{"kind":null,"stage":null}'::jsonb),
 ('builder reference','MLB-77003PO-60001','Make safe','{"kind":null,"stage":null}'::jsonb),
 ('only a letter','A','Balance','{"kind":null,"stage":null}'::jsonb),
 ('letter as the first segment is the ending','A-FIN','Balance','{"kind":"final","stage":null}'::jsonb),
 ('no reference',NULL,'Balance','{"kind":null,"stage":null}'::jsonb),
 ('empty reference','','Balance','{"kind":null,"stage":null}'::jsonb),
 ('no description','SWF-90037-FIN',NULL,'{"kind":null,"stage":null}'::jsonb),
 ('blank description','SWF-90037-FIN','   ','{"kind":null,"stage":null}'::jsonb),
 ('only dashes','---','Balance','{"kind":null,"stage":null}'::jsonb)
-- FIXTURES END
 ) v(label, ref, descr, want) LOOP
  n := n + 1;
  got := public.context_ledger_invoice_kind_of(x.ref, x.descr);
  PERFORM pg_temp.sp_assert(got = x.want, format('invoice kind of %s: %s, want %s', x.label, got, x.want));
 END LOOP;
 PERFORM pg_temp.sp_assert(n >= 25, 'the fixture table is there');
 FOR x IN SELECT * FROM (VALUES ('SWF-90037-FIN', 'Balance', 'final'), ('SWF-90037-DEP', 'Deposit', 'deposit'),
   ('SWF-90038-VAR', 'Extra labour', 'variation'), ('SWP-90037-MAT', 'Materials', 'materials'), ('SWF-90037-FIN', 'Deposit', NULL),
   (NULL, NULL, NULL)) v(ref, descr, want) LOOP
  PERFORM pg_temp.sp_assert(public.context_ledger_obligation_kind(x.ref, x.descr) IS NOT DISTINCT FROM x.want,
   format('obligation kind of %s / %s', x.ref, x.descr));
 END LOOP;
 FOR x IN SELECT * FROM (VALUES ('payment', NULL, 'payment'), ('none', 'payment', 'payment'), (NULL, 'deposit', 'payment'),
   ('invoice_issued', NULL, 'invoice'), ('person', 'payment', 'person'), ('reply', NULL, 'reply'), ('call', NULL, 'reply'),
   ('work_done', 'payment', 'work'), ('visit', NULL, 'work'), ('record', NULL, 'other'), ('none', 'install', 'other'), (NULL, NULL, 'other')) v(c, b, want) LOOP
  PERFORM pg_temp.sp_assert(public.context_ledger_obligation_class(x.c, x.b) = x.want, format('obligation class of %s / %s', x.c, x.b));
 END LOOP;
END $c$;

-- 3 to 5. The 38 fixtures, four review r2 traps (39 to 42), seven review r3 traps (43 to 49), five
-- review r4 traps (50 to 54) and nine review r5 traps (55 to 63).
BEGIN;
DO $c$
DECLARE j uuid; j2 uuid; j3 uuid; own uuid; nb uuid; nb2 uuid; e1 uuid; e2 uuid; e3 uuid; x1 uuid; x2 uuid; x3 uuid; t1 timestamptz := '2026-09-01 02:00Z';
 tn timestamptz := '2026-09-01 03:00Z'; paid date := '2026-09-05';
BEGIN
 UPDATE public.automation_switches SET capture = true, attribution = true, extraction = true, all_stop = false WHERE id = 1;
 UPDATE public.context_ledger_settings SET mode = 'shadow', calls_per_day = 50, reader = 'luna-ledger:v1', job_ids = NULL;
 -- B-1, a builder company, and its one listed Xero contact (a person's mapping, never by name)
 INSERT INTO public.makesafe_companies (id, slug, name) VALUES (pg_temp.sp_id(6, 0, 1), 'spc-b1', 'Builder One Test');
 INSERT INTO public.context_ledger_builder_contacts (company_id, xero_contact_id, added_by, note)
 VALUES (pg_temp.sp_id(6, 0, 1), 'XC-B1', 'contract', 'synthetic');

 -- 1. Two make-safes on one work order: the sister's payment is a lead; this job's own invoice is owed.
 j := pg_temp.sp_job(1, 1, 'SWMS-90001', 'makesafe'); j2 := pg_temp.sp_job(1, 2, 'SWMS-90002', 'makesafe');
 e1 := pg_temp.sp_note(1, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(1, 1, j2, 'ACCREC', 'PAID', 'MLB-77001PO-60002', 'Make safe works', 800, 0, 800, paid, NULL, 'XC-B1');
 x2 := pg_temp.sp_inv(1, 2, j, 'ACCREC', 'AUTHORISED', 'MLB-77001PO-60001', 'Make safe works', 800, 800, 0, NULL, NULL, 'XC-B1');
 PERFORM pg_temp.sp_fx_add(1, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid');
 -- 2. As 1, this job with no invoice at all.
 j := pg_temp.sp_job(2, 1, 'SWMS-90102', 'makesafe'); j2 := pg_temp.sp_job(2, 2, 'SWMS-90103', 'makesafe');
 e1 := pg_temp.sp_note(2, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(2, 1, j2, 'ACCREC', 'PAID', 'MLB-77002PO-60003', 'Make safe works', 800, 0, 800, paid, NULL, 'XC-B1');
 PERFORM pg_temp.sp_fx_add(2, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'no_own_invoice');
 -- 3. A neighbour paid their share; the owner's own invoice is unpaid (today this closes).
 j := pg_temp.sp_job(3, 1, 'SWF-90003');
 own := pg_temp.sp_party(3, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(3, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(3, 1, j, 'I will pay my half of the fence on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(3, 1, j, 'ACCREC', 'PAID', 'SWF-90003-B-FIN', 'Balance of the fence', 1500, 0, 1500, paid, nb, 'XC-NB1');
 x2 := pg_temp.sp_inv(3, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90003-FIN', 'Balance of the fence', 1500, 1500, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(3, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay their half of the fence on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my half of the fence on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid');
 -- 4. As 3: the neighbour's own item, closed by the neighbour's own paid invoice.
 j := pg_temp.sp_job(4, 1, 'SWF-90004');
 own := pg_temp.sp_party(4, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(4, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(4, 1, j, 'Will pay my half Friday.', t1, 'G-NB1');
 x1 := pg_temp.sp_inv(4, 1, j, 'ACCREC', 'PAID', 'SWF-90004-B-FIN', 'Balance of the fence', 1500, 0, 1500, paid, nb, 'XC-NB1');
 x2 := pg_temp.sp_inv(4, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90004-FIN', 'Balance of the fence', 1500, 1500, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(4, j, 'commitment', 'payment', 'payment', 'unknown', 'The neighbour will pay their half on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'Will pay my half Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 5. A payment_recorded app event naming no invoice or party.
 j := pg_temp.sp_job(5, 1, 'SWF-90005');
 own := pg_temp.sp_party(5, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(5, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_je(5, 1, j, 'payment_recorded', '2026-09-05 03:00Z');
 PERFORM pg_temp.sp_fx_add(5, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_c('job_events', x1)), 'O?', 'payer_unknown');
 -- 6. No party link; its Xero contact is the owner's alone.
 j := pg_temp.sp_job(6, 1, 'SWF-90006');
 own := pg_temp.sp_party(6, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(6, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(6, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(6, 1, j, 'ACCREC', 'PAID', 'SWF-90006-FIN', 'Balance of the fence', 1500, 0, 1500, paid, NULL, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(6, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 7. As 6, the neighbour on the same Xero contact (today this closes).
 j := pg_temp.sp_job(7, 1, 'SWF-90007');
 own := pg_temp.sp_party(7, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(7, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-OWN');
 e1 := pg_temp.sp_text(7, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(7, 1, j, 'ACCREC', 'PAID', 'SWF-90007-FIN', 'Balance of the fence', 1500, 0, 1500, paid, NULL, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(7, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'payer_ambiguous_contact');
 -- 8. Part paid: PAID in a stale mirror with no paid day and an amount still due.
 j := pg_temp.sp_job(8, 1, 'SWP-90008', 'patio');
 own := pg_temp.sp_party(8, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(8, 1, j, 'I will pay the patio invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(8, 1, j, 'ACCREC', 'PAID', 'SWP-90008-FIN', 'Balance of the patio', 1200, 700, 500, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(8, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the patio invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the patio invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'partially_paid');
 -- 9. A voided invoice that once looked paid.
 j := pg_temp.sp_job(9, 1, 'SWF-90009');
 own := pg_temp.sp_party(9, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(9, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(9, 1, j, 'ACCREC', 'VOIDED', 'SWF-90009-FIN', 'Balance of the fence', 1000, 0, 1000, paid, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(9, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'voided_only');
 -- 10. A credit note for the full amount; the invoice reads AUTHORISED with nothing due.
 j := pg_temp.sp_job(10, 1, 'SWF-90010');
 own := pg_temp.sp_party(10, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(10, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(10, 1, j, 'ACCREC', 'AUTHORISED', 'SWF-90010-FIN', 'Balance of the fence', 1000, 0, 0, NULL, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(10, 2, j, 'ACCRECCREDIT', 'PAID', 'SWF-90010-CN', 'Credit for the fence', 1000, 0, 1000, paid, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(10, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x2)), 'O?', 'credit_note');
 -- 11. A trade's ACCPAY bill paid on the job (today this closes).
 j := pg_temp.sp_job(11, 1, 'SWF-90011');
 own := pg_temp.sp_party(11, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(11, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(11, 1, j, 'ACCPAY', 'PAID', 'SWF-90011-TRADE', 'Install labour', 600, 0, 600, paid, NULL, 'XC-TRADE');
 PERFORM pg_temp.sp_fx_add(11, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'not_customer_invoice');
 -- 12 and 13. The install clocked off on 1 Sep: an issue raised after it stays open, the install it finished closes.
 j := pg_temp.sp_job(12, 1, 'SWF-90012');
 own := pg_temp.sp_party(12, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 x1 := pg_temp.sp_je(12, 1, j, 'clock.clock_off', '2026-09-01 08:00Z');
 e1 := pg_temp.sp_text(12, 1, j, 'The gate latch sticks when it is closed.', '2026-09-11 02:00Z', 'G-OWN');
 e2 := pg_temp.sp_note(12, 2, j, 'We will finish the install next week.', '2026-08-20 02:00Z');
 PERFORM pg_temp.sp_fx_add(12, j, 'issue', 'work_done', 'completion', 'customer', 'The gate latch sticks when it is closed.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The gate latch sticks when it is closed.')), jsonb_build_array(pg_temp.sp_c('job_events', x1)), 'O', NULL);
 PERFORM pg_temp.sp_fx_add(13, j, 'commitment', 'work_done', 'completion', 'us', 'We will finish the install next week.',
  jsonb_build_array(pg_temp.sp_cb(e2, 'We will finish the install next week.')), jsonb_build_array(pg_temp.sp_c('job_events', x1)), 'C', NULL);
 -- 14 to 16. A staff member's own note on a job done and paid (the stored close-out outcome). 16: the
 -- customer's own reply is never certain (review r5, M10), so the settled job decides.
 j := pg_temp.sp_job(14, 1, 'SWF-90014', 'fencing', 'complete');
 INSERT INTO public.job_closeout_state (job_id, outcome) VALUES (j, 'paid');
 own := pg_temp.sp_party(14, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_note(14, 1, j, 'I will confirm the colour with the supplier.', '2026-07-28 02:00Z');
 e2 := pg_temp.sp_note(14, 2, j, 'The supplier confirmed the Monument colour.', '2026-07-30 02:00Z');
 e3 := pg_temp.sp_text(14, 3, j, 'The colour is fine thanks.', '2026-07-29 02:00Z', 'G-OWN');
 PERFORM pg_temp.sp_fx_add(14, j, 'commitment', 'person', NULL, 'us', 'Confirm the colour with the supplier.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will confirm the colour with the supplier.')), NULL, 'O?', 'job_finished_and_paid');
 PERFORM pg_temp.sp_fx_add(15, j, 'commitment', 'person', NULL, 'us', 'Confirm the fence colour with the supplier.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will confirm the colour with the supplier.')),
  jsonb_build_array(pg_temp.sp_cb(e2, 'The supplier confirmed the Monument colour.')), 'C', 'closes');
 PERFORM pg_temp.sp_fx_add(16, j, 'commitment', 'person', NULL, 'us', 'Confirm the colour choice with the supplier.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will confirm the colour with the supplier.')),
  jsonb_build_array(pg_temp.sp_cb(e3, 'The colour is fine thanks.')), 'O?', 'job_finished_and_paid');
 -- 17. The deposit was paid before the automated reminder that raised the request.
 j := pg_temp.sp_job(17, 1, 'SWF-90017');
 own := pg_temp.sp_party(17, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_ee(17, 1, j, 'payment_reminder', '2026-08-03 02:00Z');
 x1 := pg_temp.sp_inv(17, 1, j, 'ACCREC', 'PAID', 'SWF-90017-DEP', 'Deposit 30%', 900, 0, 900, '2026-08-01', own, 'XC-OWN', NULL, '2026-07-28');
 PERFORM pg_temp.sp_fx_add(17, j, 'request', 'payment', 'deposit', 'us', 'Pay the deposit invoice.',
  jsonb_build_array(pg_temp.sp_c('email_events', e1)), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'paid_before_raised');
 -- 18 and 19. Two payers, 60 and 40: both paid closes the job-level item, one paid does not.
 j := pg_temp.sp_job(18, 1, 'SWF-90018');
 own := pg_temp.sp_party(18, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN', 60); nb := pg_temp.sp_party(18, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1', 40);
 e1 := pg_temp.sp_note(18, 1, j, 'Both parties are to pay their shares of the fence.', tn);
 x1 := pg_temp.sp_inv(18, 1, j, 'ACCREC', 'PAID', 'SWF-90018-FIN', 'Balance of the fence', 1800, 0, 1800, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(18, 2, j, 'ACCREC', 'PAID', 'SWF-90018-B-FIN', 'Balance of the fence', 1200, 0, 1200, paid, nb, 'XC-NB1');
 PERFORM pg_temp.sp_fx_add(18, j, 'commitment', 'payment', 'payment', 'us', 'Both parties are to pay their shares of the fence.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'Both parties are to pay their shares of the fence.')),
  jsonb_build_array(pg_temp.sp_cx(x1), pg_temp.sp_cx(x2)), 'C', 'closes');
 j := pg_temp.sp_job(19, 1, 'SWF-90019');
 own := pg_temp.sp_party(19, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN', 60); nb := pg_temp.sp_party(19, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1', 40);
 e1 := pg_temp.sp_note(19, 1, j, 'Both parties are to pay their shares of the fence.', tn);
 x1 := pg_temp.sp_inv(19, 1, j, 'ACCREC', 'PAID', 'SWF-90019-FIN', 'Balance of the fence', 1800, 0, 1800, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(19, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90019-B-FIN', 'Balance of the fence', 1200, 1200, 0, NULL, nb, 'XC-NB1');
 PERFORM pg_temp.sp_fx_add(19, j, 'commitment', 'payment', 'payment', 'us', 'Both parties are to pay their shares of the fence.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'Both parties are to pay their shares of the fence.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid');
 -- 20. A site and client sibling (two stages) paid; this stage's invoice is owed.
 j := pg_temp.sp_job(20, 1, 'SWF-90020'); j2 := pg_temp.sp_job(20, 2, 'SWF-90021');
 own := pg_temp.sp_party(20, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(20, 2, j2, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(20, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(20, 1, j2, 'ACCREC', 'PAID', 'SWF-90021-FIN', 'Balance of stage two', 1500, 0, 1500, paid, nb, 'XC-OWN');
 x2 := pg_temp.sp_inv(20, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90020-FIN', 'Balance of stage one', 1500, 1500, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(20, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid');
 -- 21. A make-safe's own invoice to the builder's listed contact, paid.
 j := pg_temp.sp_job(21, 1, 'SWMS-90022', 'makesafe');
 e1 := pg_temp.sp_note(21, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(21, 1, j, 'ACCREC', 'PAID', 'MLB-77003PO-60001', 'Make safe works', 800, 0, 800, paid, NULL, 'XC-B1');
 PERFORM pg_temp.sp_fx_add(21, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 22. One invoice for two cards on one work order sits on the other card.
 j := pg_temp.sp_job(22, 1, 'SWMS-90023', 'makesafe'); j2 := pg_temp.sp_job(22, 2, 'SWMS-90024', 'makesafe');
 e1 := pg_temp.sp_note(22, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(22, 1, j2, 'ACCREC', 'PAID', 'MLB-77004PO-60004', 'Make safe SWMS-90023 and SWMS-90024', 1600, 0, 1600, paid, NULL, 'XC-B1');
 PERFORM pg_temp.sp_fx_add(22, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'no_own_invoice');
 -- 23. A neighbour's sign-off is not a payment, however paid their courtesy invoice.
 j := pg_temp.sp_job(23, 1, 'SWF-90025');
 own := pg_temp.sp_party(23, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(23, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1', 0);
 e1 := pg_temp.sp_note(23, 1, j, 'The neighbour is to sign off the fence line before the install.', tn);
 x1 := pg_temp.sp_inv(23, 1, j, 'ACCREC', 'PAID', 'SWF-90025-B-FIN', 'Balance', 0, 0, 0, paid, nb, 'XC-NB1', NULL, '2026-09-06');
 PERFORM pg_temp.sp_fx_add(23, j, 'dependency', 'record', 'install', 'us', 'The neighbour is to sign off the fence line before the install.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The neighbour is to sign off the fence line before the install.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?',
  'record_not_person', 'approval:neighbour-signoff');
 -- 24. A receipt asked for the day of payment: a payment is not the reply.
 j := pg_temp.sp_job(24, 1, 'SWF-90026');
 own := pg_temp.sp_party(24, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(24, 1, j, 'Please send me the receipt for the payment.', '2026-09-05 06:00Z', 'G-OWN');
 x1 := pg_temp.sp_inv(24, 1, j, 'ACCREC', 'PAID', 'SWF-90026-FIN', 'Balance of the fence', 1000, 0, 1000, paid, own, 'XC-OWN', NULL, '2026-09-06');
 PERFORM pg_temp.sp_fx_add(24, j, 'request', 'reply', NULL, 'customer', 'The owner asked for the receipt for the payment.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'Please send me the receipt for the payment.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'wrong_obligation_class');
 -- 25. A neighbour's key reused: the retired neighbour's item, the new neighbour's paid invoice.
 j := pg_temp.sp_job(25, 1, 'SWF-90027');
 own := pg_temp.sp_party(25, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 nb := pg_temp.sp_party(25, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1', 50, true);
 nb2 := pg_temp.sp_party(25, 3, j, 'nb-1#2', 'neighbour', false, 'G-NB2', 'XC-NB2');
 e1 := pg_temp.sp_text(25, 1, j, 'I will pay my share next week.', t1, 'G-NB1');
 x1 := pg_temp.sp_inv(25, 1, j, 'ACCREC', 'PAID', 'SWF-90027-B-FIN', 'Balance of the fence', 1500, 0, 1500, paid, nb2, 'XC-NB2');
 PERFORM pg_temp.sp_fx_add(25, j, 'commitment', 'payment', 'payment', 'unknown', 'The neighbour will pay their share next week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my share next week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'obligated_party_retired');
 -- 26. The same amount from a different payer.
 j := pg_temp.sp_job(26, 1, 'SWF-90028');
 own := pg_temp.sp_party(26, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(26, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(26, 1, j, 'I will pay my half of the fence on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(26, 1, j, 'ACCREC', 'PAID', 'SWF-90028-B-FIN', 'Balance of the fence', 2400, 0, 2400, paid, nb, 'XC-NB1');
 x2 := pg_temp.sp_inv(26, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90028-FIN', 'Balance of the fence', 2400, 2400, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(26, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay their half of the fence on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my half of the fence on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid');
 -- 27. A neighbour's overpayment allocated to the owner's invoice (today this closes).
 j := pg_temp.sp_job(27, 1, 'SWF-90029');
 own := pg_temp.sp_party(27, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(27, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(27, 1, j, 'I will pay my half of the fence on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(27, 1, j, 'ACCREC', 'PAID', 'SWF-90029-B-FIN', 'Balance of the fence', 1500, 0, 2000, paid, nb, 'XC-NB1');
 x2 := pg_temp.sp_inv(27, 2, j, 'ACCREC', 'PAID', 'SWF-90029-FIN', 'Balance of the fence', 1500, 0, 1500, paid, own, 'XC-OWN',
  '{"Overpayments":[{"Contact":{"ContactID":"XC-NB1"},"Total":500}]}');
 PERFORM pg_temp.sp_fx_add(27, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay their half of the fence on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my half of the fence on Friday.')), jsonb_build_array(pg_temp.sp_cx(x2)), 'O?', 'other_money_allocated');
 -- 28. The owner's own prepayment on the owner's own invoice.
 j := pg_temp.sp_job(28, 1, 'SWF-90030');
 own := pg_temp.sp_party(28, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(28, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(28, 1, j, 'ACCREC', 'PAID', 'SWF-90030-FIN', 'Balance of the fence', 1500, 0, 1500, paid, own, 'XC-OWN',
  '{"Prepayments":[{"Contact":{"ContactID":"XC-OWN"},"Total":1500}]}');
 PERFORM pg_temp.sp_fx_add(28, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 29. "Paid" said only in words while the invoice is owed (reviewer note 2: open and certain).
 j := pg_temp.sp_job(29, 1, 'SWP-90031', 'patio');
 own := pg_temp.sp_party(29, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(29, 1, j, 'I will pay the patio invoice this week.', t1, 'G-OWN');
 e2 := pg_temp.sp_text(29, 2, j, 'I paid it yesterday.', '2026-09-06 02:00Z', 'G-OWN');
 e3 := pg_temp.sp_note(29, 3, j, 'Client says paid.', '2026-09-06 03:00Z');
 x1 := pg_temp.sp_inv(29, 1, j, 'ACCREC', 'AUTHORISED', 'SWP-90031-FIN', 'Balance of the patio', 1200, 1200, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(29, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the patio invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the patio invoice this week.')),
  jsonb_build_array(pg_temp.sp_cb(e2, 'I paid it yesterday.'), pg_temp.sp_cb(e3, 'Client says paid.')), 'O', 'invoice_unpaid');
 -- 30. A proven builder close is not held by unpaid siblings on its work order or site.
 j := pg_temp.sp_job(30, 1, 'SWMS-90032', 'makesafe'); j2 := pg_temp.sp_job(30, 2, 'SWMS-90133', 'makesafe'); j3 := pg_temp.sp_job(30, 3, 'SWMS-90134', 'makesafe');
 e1 := pg_temp.sp_note(30, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(30, 1, j, 'ACCREC', 'PAID', 'MLB-77005PO-60005', 'Make safe works', 800, 0, 800, paid, NULL, 'XC-B1');
 x2 := pg_temp.sp_inv(30, 2, j2, 'ACCREC', 'AUTHORISED', 'MLB-77005PO-60006', 'Make safe works', 800, 800, 0, NULL, NULL, 'XC-B1');
 x3 := pg_temp.sp_inv(30, 3, j3, 'ACCREC', 'AUTHORISED', 'MLB-77006PO-60007', 'Make safe works', 800, 800, 0, NULL, NULL, 'XC-B1');
 PERFORM pg_temp.sp_fx_add(30, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 31. No party link and a Xero contact not on the job: never "the owner paid".
 j := pg_temp.sp_job(31, 1, 'SWF-90034', 'fencing', 'scheduled', 'XC-OWN');
 own := pg_temp.sp_party(31, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(31, 1, j, 'I will pay the fence invoice this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(31, 1, j, 'ACCREC', 'PAID', 'SWF-90034-FIN', 'Balance of the fence', 1500, 0, 1500, paid, NULL, 'XC-OTHER');
 PERFORM pg_temp.sp_fx_add(31, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'payer_contact_not_on_job');
 -- 32. Builder work paid by the insured, a resolved party on the job, not the builder.
 j := pg_temp.sp_job(32, 1, 'SWMS-90035', 'makesafe', 'scheduled', 'XC-INS');
 own := pg_temp.sp_party(32, 1, j, 'primary', 'owner', true, 'G-INS', 'XC-INS');
 e1 := pg_temp.sp_note(32, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(32, 1, j, 'ACCREC', 'PAID', 'MLB-77007PO-60008', 'Make safe works', 800, 0, 800, paid, own, 'XC-INS');
 PERFORM pg_temp.sp_fx_add(32, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'other_payer');
 -- 33. The builder's second, unlisted Xero contact.
 j := pg_temp.sp_job(33, 1, 'SWMS-90036', 'makesafe');
 e1 := pg_temp.sp_note(33, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(33, 1, j, 'ACCREC', 'PAID', 'MLB-77008PO-60009', 'Make safe works', 800, 0, 800, paid, NULL, 'XC-B1-FULL');
 PERFORM pg_temp.sp_fx_add(33, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?',
  'payer_builder_contact_unmapped');
 -- 34 and 35. A final-payment item, bound to the final invoice that opened it.
 j := pg_temp.sp_job(34, 1, 'SWF-90037');
 own := pg_temp.sp_party(34, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 x1 := pg_temp.sp_inv(34, 1, j, 'ACCREC', 'AUTHORISED', 'SWF-90037-FIN', 'Balance of the fence', 2000, 2000, 0, NULL, own, 'XC-OWN', NULL, '2026-08-20');
 x2 := pg_temp.sp_inv(34, 2, j, 'ACCREC', 'PAID', 'SWF-90037-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN', NULL, '2026-08-10');
 PERFORM pg_temp.sp_fx_add(34, j, 'commitment', 'payment', 'payment', 'us', 'The owner is to pay the final fence invoice.',
  jsonb_build_array(pg_temp.sp_cx(x1)), jsonb_build_array(pg_temp.sp_cx(x2)), 'O', 'invoice_unpaid');
 j := pg_temp.sp_job(35, 1, 'SWF-90038');
 own := pg_temp.sp_party(35, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 x1 := pg_temp.sp_inv(35, 1, j, 'ACCREC', 'AUTHORISED', 'SWF-90038-FIN', 'Balance of the fence', 2000, 2000, 0, NULL, own, 'XC-OWN', NULL, '2026-08-20');
 x2 := pg_temp.sp_inv(35, 2, j, 'ACCREC', 'PAID', 'SWF-90038-VAR', 'Extra labour for rock', 400, 0, 400, paid, own, 'XC-OWN', NULL, '2026-08-22');
 PERFORM pg_temp.sp_fx_add(35, j, 'commitment', 'payment', 'payment', 'us', 'The owner is to pay the final fence invoice.',
  jsonb_build_array(pg_temp.sp_cx(x1)), jsonb_build_array(pg_temp.sp_cx(x2)), 'O', 'invoice_unpaid');
 -- 36. An unbound item: every issued invoice of the payer on the job paid.
 j := pg_temp.sp_job(36, 1, 'SWF-90039');
 own := pg_temp.sp_party(36, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(36, 1, j, 'I will pay the fence invoices this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(36, 1, j, 'ACCREC', 'PAID', 'SWF-90039-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN', NULL, '2026-08-10');
 x2 := pg_temp.sp_inv(36, 2, j, 'ACCREC', 'PAID', 'SWF-90039-FIN', 'Balance of the fence', 2000, 0, 2000, paid, own, 'XC-OWN', NULL, '2026-08-20');
 PERFORM pg_temp.sp_fx_add(36, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoices this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoices this week.')), jsonb_build_array(pg_temp.sp_cx(x1), pg_temp.sp_cx(x2)), 'C', 'closes');
 -- 37. This card's own invoice is a draft; the sister card's is paid.
 j := pg_temp.sp_job(37, 1, 'SWMS-90040', 'makesafe'); j2 := pg_temp.sp_job(37, 2, 'SWMS-90041', 'makesafe');
 e1 := pg_temp.sp_note(37, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(37, 1, j2, 'ACCREC', 'PAID', 'MLB-77009PO-60010', 'Make safe works', 800, 0, 800, paid, NULL, 'XC-B1');
 x2 := pg_temp.sp_inv(37, 2, j, 'ACCREC', 'DRAFT', 'MLB-77009PO-60011', 'Make safe works', 800, 800, 0, NULL, NULL, 'XC-B1');
 PERFORM pg_temp.sp_fx_add(37, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'no_own_invoice');
 -- 38. Two active parties, no owner marker, an unmatched sender.
 j := pg_temp.sp_job(38, 1, 'SWF-90042', 'fencing', 'scheduled', 'XC-FAM');
 own := pg_temp.sp_party(38, 1, j, NULL, NULL, false, 'G-PA', NULL); nb := pg_temp.sp_party(38, 2, j, NULL, NULL, false, 'G-PB', NULL);
 e1 := pg_temp.sp_text(38, 1, j, 'I will pay the fence invoice this week.', t1, 'G-X');
 x1 := pg_temp.sp_inv(38, 1, j, 'ACCREC', 'PAID', 'SWF-90042-FIN', 'Balance of the fence', 1500, 0, 1500, paid, NULL, 'XC-FAM');
 PERFORM pg_temp.sp_fx_add(38, j, 'commitment', 'payment', 'payment', 'unknown', 'The fence invoice will be paid this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'unmatched_sender');
 -- Review r2 traps.
 -- 39 (M1). Builder work billed under the job's own Xero contact, no party: may be the builder's, unproven.
 j := pg_temp.sp_job(39, 1, 'SWMS-90043', 'makesafe', 'scheduled', 'XC-JOB');
 e1 := pg_temp.sp_note(39, 1, j, 'The builder is to pay the make-safe invoice for this job.', tn);
 x1 := pg_temp.sp_inv(39, 1, j, 'ACCREC', 'PAID', 'MLB-77010PO-60012', 'Make safe works', 800, 0, 800, paid, NULL, 'XC-JOB');
 PERFORM pg_temp.sp_fx_add(39, j, 'commitment', 'payment', 'payment', 'us', 'The builder is to pay the make-safe invoice.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'The builder is to pay the make-safe invoice for this job.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?',
  'payer_job_contact');
 -- 40 (M2). A record cited to close a person's item is evidence only.
 j := pg_temp.sp_job(40, 1, 'SWF-90044');
 own := pg_temp.sp_party(40, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_note(40, 1, j, 'I will send the owner the colour chart.', tn);
 x1 := pg_temp.sp_inv(40, 1, j, 'ACCREC', 'AUTHORISED', 'SWF-90044-FIN', 'Balance of the fence', 1000, 1000, 0, NULL, own, 'XC-OWN', NULL, '2026-09-06');
 PERFORM pg_temp.sp_fx_add(40, j, 'commitment', 'person', NULL, 'us', 'Send the owner the colour chart.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will send the owner the colour chart.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'record_not_person');
 -- 41 and 42 (M3). Our own message with no named sender: a later row of ours closes it, a customer's never
 -- (and, being the customer the item is owed to, never certainly: review r5, M10).
 j := pg_temp.sp_job(41, 1, 'SWF-90045');
 own := pg_temp.sp_party(41, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_ev(41, 1, j, 'client.sms_out', 'sms', 'outbound', 'We will book the install date by Friday.', tn, 'G-OWN');
 e2 := pg_temp.sp_ev(41, 2, j, 'client.sms_out', 'sms', 'outbound', 'Your install is booked for Tuesday the 8th.', '2026-09-03 02:00Z', 'G-OWN');
 e3 := pg_temp.sp_text(41, 3, j, 'Tuesday works for us, thanks.', '2026-09-03 03:00Z', 'G-OWN');
 PERFORM pg_temp.sp_fx_add(41, j, 'commitment', 'person', NULL, 'us', 'Book the install date by Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'We will book the install date by Friday.')),
  jsonb_build_array(pg_temp.sp_cb(e2, 'Your install is booked for Tuesday the 8th.')), 'C', 'closes');
 PERFORM pg_temp.sp_fx_add(42, j, 'commitment', 'person', NULL, 'us', 'Book the install date by the Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'We will book the install date by Friday.')),
  jsonb_build_array(pg_temp.sp_cb(e3, 'Tuesday works for us, thanks.')), 'O?', 'released_by_obligee');
 -- Review r3 traps.
 -- 43 (M4). The item names its deposit invoice, which is paid; the balance invoice is owed: closes.
 j := pg_temp.sp_job(43, 1, 'SWF-90046');
 own := pg_temp.sp_party(43, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(43, 1, j, 'I will pay invoice SWF-90046-DEP this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(43, 1, j, 'ACCREC', 'PAID', 'SWF-90046-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(43, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90046-FIN', 'Balance of the fence', 2100, 2100, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(43, j, 'commitment', 'payment', 'deposit', 'customer', 'The owner will pay invoice SWF-90046-DEP this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay invoice SWF-90046-DEP this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 44 (M4). The item names its balance invoice, which is owed; a paid deposit is cited: open, certain.
 j := pg_temp.sp_job(44, 1, 'SWF-90047');
 own := pg_temp.sp_party(44, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(44, 1, j, 'I will pay invoice SWF-90047-FIN this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(44, 1, j, 'ACCREC', 'PAID', 'SWF-90047-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(44, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90047-FIN', 'Balance of the fence', 2100, 2100, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(44, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay invoice SWF-90047-FIN this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay invoice SWF-90047-FIN this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid');
 -- 45 (M4). No invoice named; the cited invoice is paid and another of the payer's is owed: payer not certain.
 j := pg_temp.sp_job(45, 1, 'SWF-90048');
 own := pg_temp.sp_party(45, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(45, 1, j, 'I will pay for the fence this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(45, 1, j, 'ACCREC', 'PAID', 'SWF-90048-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(45, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90048-FIN', 'Balance of the fence', 2100, 2100, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(45, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay for the fence this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay for the fence this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'other_invoice_owed');
 -- 46 (M4). A reference matched only as a substring (SWF-90049-DEP inside SWF-90049-DEP2) binds nothing.
 j := pg_temp.sp_job(46, 1, 'SWF-90049');
 own := pg_temp.sp_party(46, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(46, 1, j, 'I will pay invoice SWF-90049-DEP2 this week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(46, 1, j, 'ACCREC', 'PAID', 'SWF-90049-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(46, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90049-FIN', 'Balance of the fence', 2100, 2100, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(46, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay invoice SWF-90049-DEP2 this week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay invoice SWF-90049-DEP2 this week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'other_invoice_owed');
 -- 47 (M5). A visit item closed only by a paid invoice: evidence only, payer not certain.
 j := pg_temp.sp_job(47, 1, 'SWF-90050');
 own := pg_temp.sp_party(47, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_note(47, 1, j, 'We will come back to check the gate hinge.', tn);
 x1 := pg_temp.sp_inv(47, 1, j, 'ACCREC', 'PAID', 'SWF-90050-FIN', 'Balance of the fence', 1000, 0, 1000, paid, own, 'XC-OWN', NULL, '2026-09-06');
 PERFORM pg_temp.sp_fx_add(47, j, 'commitment', 'visit', NULL, 'us', 'Come back to check the gate hinge.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'We will come back to check the gate hinge.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'wrong_obligation_class');
 -- 48 (M6). A reply item closed by our reply, with a paid invoice cited beside it: the reply closes it.
 j := pg_temp.sp_job(48, 1, 'SWF-90051');
 own := pg_temp.sp_party(48, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(48, 1, j, 'Can you tell me when the gate will be fitted?', t1, 'G-OWN');
 e2 := pg_temp.sp_ev(48, 2, j, 'client.sms_out', 'sms', 'outbound', 'The gate is being fitted on Thursday.', '2026-09-03 02:00Z', 'G-OWN');
 x1 := pg_temp.sp_inv(48, 1, j, 'ACCREC', 'PAID', 'SWF-90051-FIN', 'Balance of the fence', 1000, 0, 1000, paid, own, 'XC-OWN', NULL, '2026-09-06');
 PERFORM pg_temp.sp_fx_add(48, j, 'request', 'reply', NULL, 'customer', 'The owner asked when the gate will be fitted.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'Can you tell me when the gate will be fitted?')),
  jsonb_build_array(pg_temp.sp_cb(e2, 'The gate is being fitted on Thursday.'), pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 49 (M7). Our offer, released by the customer it was owed to: open, not certain.
 j := pg_temp.sp_job(49, 1, 'SWF-90052');
 own := pg_temp.sp_party(49, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_ev(49, 1, j, 'client.sms_out', 'sms', 'outbound', 'We can bring a spare gate latch over on Monday.', tn, 'G-OWN');
 e2 := pg_temp.sp_text(49, 2, j, 'No need, we fixed the latch ourselves, thanks.', '2026-09-03 02:00Z', 'G-OWN');
 PERFORM pg_temp.sp_fx_add(49, j, 'commitment', 'person', NULL, 'us', 'Bring a spare gate latch over on Monday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'We can bring a spare gate latch over on Monday.')),
  jsonb_build_array(pg_temp.sp_cb(e2, 'No need, we fixed the latch ourselves, thanks.')), 'O?', 'released_by_obligee');
 -- Review r4 traps (M8): a closing citation never stands in for the payer.
 -- 50. Fixture 3 with about key payment:deposit: the neighbour's paid deposit never closes the owner's deposit item.
 j := pg_temp.sp_job(50, 1, 'SWF-90053');
 own := pg_temp.sp_party(50, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(50, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(50, 1, j, 'I will pay my deposit on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(50, 1, j, 'ACCREC', 'PAID', 'SWF-90053-B-DEP', 'Deposit 30%', 900, 0, 900, paid, nb, 'XC-NB1');
 x2 := pg_temp.sp_inv(50, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90053-DEP', 'Deposit 30%', 900, 900, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(50, j, 'commitment', 'payment', 'deposit', 'customer', 'The owner will pay their deposit on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my deposit on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid',
  'payment:deposit');
 -- 51. Fixture 26 with about key invoice:<the neighbour's invoice number>: still the owner's own invoice decides.
 j := pg_temp.sp_job(51, 1, 'SWF-90054');
 own := pg_temp.sp_party(51, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(51, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(51, 1, j, 'I will pay my half of the fence on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(51, 1, j, 'ACCREC', 'PAID', 'SWF-90054-B-FIN', 'Balance of the fence', 2400, 0, 2400, paid, nb, 'XC-NB1');
 x2 := pg_temp.sp_inv(51, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90054-FIN', 'Balance of the fence', 2400, 2400, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(51, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay their half of the fence on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my half of the fence on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid',
  'invoice:inv-90511');
 -- 52. The owner's opening request names their own invoice, paid and cited (the item's words do not): closes,
 -- whatever their variation invoice owes.
 j := pg_temp.sp_job(52, 1, 'SWF-90055');
 own := pg_temp.sp_party(52, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(52, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(52, 1, j, 'I will pay SWF-90055-FIN on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(52, 1, j, 'ACCREC', 'PAID', 'SWF-90055-FIN', 'Balance of the fence', 2400, 0, 2400, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(52, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90055-VAR', 'Extra labour', 300, 300, 0, NULL, own, 'XC-OWN');
 x3 := pg_temp.sp_inv(52, 3, j, 'ACCREC', 'AUTHORISED', 'SWF-90055-B-FIN', 'Balance of the fence', 2400, 2400, 0, NULL, nb, 'XC-NB1');
 PERFORM pg_temp.sp_fx_add(52, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence balance on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay SWF-90055-FIN on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes');
 -- 53. Only the item's own words name the neighbour's invoice: no binding, no payer bypass.
 j := pg_temp.sp_job(53, 1, 'SWF-90056');
 own := pg_temp.sp_party(53, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(53, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(53, 1, j, 'I will pay my half of the fence on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(53, 1, j, 'ACCREC', 'PAID', 'SWF-90056-B-FIN', 'Balance of the fence', 2400, 0, 2400, paid, nb, 'XC-NB1');
 x2 := pg_temp.sp_inv(53, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90056-FIN', 'Balance of the fence', 2400, 2400, 0, NULL, own, 'XC-OWN');
 PERFORM pg_temp.sp_fx_add(53, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay invoice SWF-90056-B-FIN on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my half of the fence on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid');
 -- 54. About a deposit, citing a paid deposit whose payer is unknown: payer not certain, never closed.
 j := pg_temp.sp_job(54, 1, 'SWF-90057');
 own := pg_temp.sp_party(54, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(54, 1, j, 'I will pay the deposit on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(54, 1, j, 'ACCREC', 'PAID', 'SWF-90057-DEP', 'Deposit 30%', 900, 0, 900, paid, NULL, 'XC-ELSE');
 PERFORM pg_temp.sp_fx_add(54, j, 'commitment', 'payment', 'deposit', 'customer', 'The owner will pay the deposit on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the deposit on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'payer_contact_not_on_job',
  'payment:deposit');
 -- Review r5 traps (M9, M10, known uncertainty).
 -- 55 (M9). Fixture 3 reversed: the owner's own deposit paid and cited, the neighbour's deposit owed: closes.
 j := pg_temp.sp_job(55, 1, 'SWF-90058');
 own := pg_temp.sp_party(55, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(55, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(55, 1, j, 'I will pay my deposit on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(55, 1, j, 'ACCREC', 'PAID', 'SWF-90058-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(55, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90058-B-DEP', 'Deposit 30%', 900, 900, 0, NULL, nb, 'XC-NB1');
 PERFORM pg_temp.sp_fx_add(55, j, 'commitment', 'payment', 'deposit', 'customer', 'The owner will pay their deposit on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my deposit on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes',
  'payment:deposit');
 -- 56 (M9). Fixture 26 reversed, about the owner's own invoice number: closes.
 j := pg_temp.sp_job(56, 1, 'SWF-90059');
 own := pg_temp.sp_party(56, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(56, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(56, 1, j, 'I will pay my half of the fence on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(56, 1, j, 'ACCREC', 'PAID', 'SWF-90059-FIN', 'Balance of the fence', 2400, 0, 2400, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(56, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90059-B-FIN', 'Balance of the fence', 2400, 2400, 0, NULL, nb, 'XC-NB1');
 PERFORM pg_temp.sp_fx_add(56, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay their half of the fence on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my half of the fence on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'C', 'closes',
  'invoice:inv-90561');
 -- 57 (M9). The owner's own deposit cited and still owed (the neighbour's paid): open and certain.
 j := pg_temp.sp_job(57, 1, 'SWF-90060');
 own := pg_temp.sp_party(57, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(57, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_text(57, 1, j, 'I will pay my deposit on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(57, 1, j, 'ACCREC', 'AUTHORISED', 'SWF-90060-DEP', 'Deposit 30%', 900, 900, 0, NULL, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(57, 2, j, 'ACCREC', 'PAID', 'SWF-90060-B-DEP', 'Deposit 30%', 900, 0, 900, paid, nb, 'XC-NB1');
 PERFORM pg_temp.sp_fx_add(57, j, 'commitment', 'payment', 'deposit', 'customer', 'The owner will pay their deposit on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my deposit on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O', 'invoice_unpaid',
  'payment:deposit');
 -- 58 (M9). The owner's own deposit paid and cited; the only owed deposit has a payer not on the job: not certain.
 j := pg_temp.sp_job(58, 1, 'SWF-90061');
 own := pg_temp.sp_party(58, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(58, 1, j, 'I will pay my deposit on Friday.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(58, 1, j, 'ACCREC', 'PAID', 'SWF-90061-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(58, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90061-DEP2', 'Deposit 30%', 900, 900, 0, NULL, NULL, 'XC-ELSE');
 PERFORM pg_temp.sp_fx_add(58, j, 'commitment', 'payment', 'deposit', 'customer', 'The owner will pay their deposit on Friday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay my deposit on Friday.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'same_kind_payer_unproven',
  'payment:deposit');
 -- 59 (M9, the reported shape). Our own note on every payer's deposit, the owner's paid and cited, the
 -- second party's owed and never cited: which party's deposit it is is not known, never certain.
 j := pg_temp.sp_job(59, 1, 'SWF-90062');
 own := pg_temp.sp_party(59, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN'); nb := pg_temp.sp_party(59, 2, j, 'nb-1', 'neighbour', false, 'G-NB1', 'XC-NB1');
 e1 := pg_temp.sp_note(59, 1, j, 'Chase the fence deposit.', t1);
 x1 := pg_temp.sp_inv(59, 1, j, 'ACCREC', 'PAID', 'SWF-90062-DEP', 'Deposit 30%', 900, 0, 900, paid, own, 'XC-OWN');
 x2 := pg_temp.sp_inv(59, 2, j, 'ACCREC', 'AUTHORISED', 'SWF-90062-B-DEP', 'Deposit 30%', 900, 900, 0, NULL, nb, 'XC-NB1');
 PERFORM pg_temp.sp_fx_add(59, j, 'commitment', 'payment', 'deposit', 'us', 'Chase the fence deposit.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'Chase the fence deposit.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'other_invoice_owed',
  'payment:deposit');
 -- 60 (M10). The customer the item is owed to, with no release words, gives it to someone else: never certain.
 j := pg_temp.sp_job(60, 1, 'SWF-90063');
 own := pg_temp.sp_party(60, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_ev(60, 1, j, 'client.sms_out', 'sms', 'outbound', 'We will send the crew to fix the gate on Monday.', t1, 'G-OWN');
 e2 := pg_temp.sp_text(60, 2, j, 'Another contractor is doing the gate now.', '2026-09-03 03:00Z', 'G-OWN');
 PERFORM pg_temp.sp_fx_add(60, j, 'commitment', 'person', NULL, 'us', 'Send the crew to fix the gate on Monday.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'We will send the crew to fix the gate on Monday.')),
  jsonb_build_array(pg_temp.sp_cb(e2, 'Another contractor is doing the gate now.')), 'O?', 'released_by_obligee');
 -- 61 (M10). Another of our people, not the one who promised: open and certain (other_person), unchanged.
 j := pg_temp.sp_job(61, 1, 'SWF-90064');
 own := pg_temp.sp_party(61, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_note(61, 1, j, 'I will call the supplier about the gate.', t1, 'ghl-s1');
 e2 := pg_temp.sp_note(61, 2, j, 'Called the supplier about the gate.', '2026-09-03 03:00Z', 'ghl-s2');
 PERFORM pg_temp.sp_fx_add(61, j, 'commitment', 'person', NULL, 'us', 'Call the supplier about the gate.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will call the supplier about the gate.')),
  jsonb_build_array(pg_temp.sp_cb(e2, 'Called the supplier about the gate.')), 'O', 'other_person');
 -- 62 (known uncertainty). The only owed invoice is to a company Xero contact that is no party on the job:
 -- payer not certain, never widened to certain.
 j := pg_temp.sp_job(62, 1, 'SWF-90065');
 own := pg_temp.sp_party(62, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(62, 1, j, 'I will pay the fence invoice next week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(62, 1, j, 'ACCREC', 'AUTHORISED', 'SWF-90065-FIN', 'Balance of the fence', 2400, 2400, 0, NULL, NULL, 'XC-COMPANY');
 PERFORM pg_temp.sp_fx_add(62, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice next week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice next week.')), NULL, 'O?', 'no_own_invoice',
  'invoice:inv-90621');
 -- 63. As 62, closed citing that company invoice, unpaid: the existing rule refuses the close
 -- (closing_not_issued) and the open item has no invoice of the owner's: payer not certain.
 j := pg_temp.sp_job(63, 1, 'SWF-90066');
 own := pg_temp.sp_party(63, 1, j, 'primary', 'owner', true, 'G-OWN', 'XC-OWN');
 e1 := pg_temp.sp_text(63, 1, j, 'I will pay the fence invoice next week.', t1, 'G-OWN');
 x1 := pg_temp.sp_inv(63, 1, j, 'ACCREC', 'AUTHORISED', 'SWF-90066-FIN', 'Balance of the fence', 2400, 2400, 0, NULL, NULL, 'XC-COMPANY');
 PERFORM pg_temp.sp_fx_add(63, j, 'commitment', 'payment', 'payment', 'customer', 'The owner will pay the fence invoice next week.',
  jsonb_build_array(pg_temp.sp_cb(e1, 'I will pay the fence invoice next week.')), jsonb_build_array(pg_temp.sp_cx(x1)), 'O?', 'no_own_invoice',
  'invoice:inv-90631');
 PERFORM pg_temp.sp_assert((SELECT count(*) FROM sp_fx) = 63, 'the 63 fixtures');
END $c$;

-- 3. Today's answers: the bodies before this migration (its down, undone at the savepoint).
SAVEPOINT sp_base;
\ir ../../../rollbacks/20261019130000_context_ledger_same_payer_close_down.sql
SELECT pg_temp.sp_run()::text AS sp_base_run \gset
ROLLBACK TO SAVEPOINT sp_base;
-- This migration's bodies, switch off.
SELECT pg_temp.sp_run()::text AS sp_off_run \gset
-- 4. Switch on.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'context_ledger_same_payer_close_v1';
SELECT pg_temp.sp_run()::text AS sp_on_run \gset
SELECT pg_temp.sp_verify(:'sp_base_run'::jsonb, :'sp_off_run'::jsonb, :'sp_on_run'::jsonb) AS same_payer_close_fixtures;
-- Today's wrong closes (fixtures 3, 7, 11 and 27) close off and stay open on; the closes on are a subset.
SELECT pg_temp.sp_assert(bool_and(:'sp_base_run'::jsonb #>> ARRAY[n::text, 'a', 'outcome'] = 'C'), 'fixtures 3, 7, 11 and 27 close today')
FROM unnest(ARRAY[3, 7, 11, 27]) n;
-- 5. With no builder contact listed, a builder's own paid invoice proves nothing about who paid.
DELETE FROM public.context_ledger_builder_contacts;
SELECT pg_temp.sp_run(ARRAY[21, 30])::text AS sp_unmapped_run \gset
SELECT pg_temp.sp_assert(bool_and(:'sp_unmapped_run'::jsonb #>> ARRAY[n::text, p, 'outcome'] = 'O?'
  AND :'sp_unmapped_run'::jsonb #>> ARRAY[n::text, p, 'reason'] = 'payer_builder_contact_unmapped'),
 'an unmapped builder''s paid invoice leaves its payment item open, payer not certain: ' || :'sp_unmapped_run')
FROM unnest(ARRAY[21, 30]) n, unnest(ARRAY['a', 'b']) p;
ROLLBACK;

-- 6. Re-applying the migration changes nothing (its guard accepts its own bodies).
BEGIN;
CREATE TEMP TABLE sp_md5 AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('context_ledger_cite', 'context_ledger_check_item', 'context_ledger_write',
  'context_ledger_same_payer_close_on', 'context_ledger_invoice_kind_of', 'context_ledger_obligation_kind', 'context_ledger_obligation_class',
  'context_ledger_invoice_payer', 'context_ledger_invoice_facts', 'context_ledger_obligation_job_facts', 'context_ledger_obligation_payer_match',
  'context_ledger_obligated_party', 'context_ledger_obligation_closes');
\ir ../../../migrations/20261019130000_context_ledger_same_payer_close.sql
DO $c$ BEGIN
 PERFORM pg_temp.sp_assert((SELECT count(*) FROM sp_md5) = 13, 'thirteen functions before the re-apply');
 PERFORM pg_temp.sp_assert(NOT EXISTS (SELECT 1 FROM sp_md5 b LEFT JOIN pg_proc p ON p.oid = to_regprocedure(b.sig)
   WHERE p.oid IS NULL OR md5(p.prosrc) <> b.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.c OR p.proacl::text IS DISTINCT FROM b.acl),
  're-applying changed a body, comment or grant');
 PERFORM pg_temp.sp_assert(NOT public.context_ledger_same_payer_close_on(), 're-applying left the switch off');
END $c$;
ROLLBACK;
