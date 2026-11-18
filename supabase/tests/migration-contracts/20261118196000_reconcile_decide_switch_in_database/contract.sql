\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '120s';
-- Re-apply: this migration's own bodies stay as they are.
\ir ../../../migrations/20261118196000_reconcile_decide_switch_in_database.sql

CREATE TEMP TABLE switch_checks(label text);
CREATE FUNCTION pg_temp.check_it(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'failed: %', label; END IF;
 INSERT INTO switch_checks VALUES (label);
END $$;
CREATE FUNCTION pg_temp.md5_of(sig text) RETURNS text LANGUAGE sql AS $$
 SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(sig)
$$;
-- Runs one command and returns the error it raised, as 'SQLSTATE message'.
CREATE FUNCTION pg_temp.error_of(command text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE command;
 RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
 RETURN SQLSTATE || ' ' || SQLERRM;
END $$;
-- Everything a decide or undo could change, for the item's document.
CREATE FUNCTION pg_temp.state(d text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'lines', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.job_cost_lines l
            WHERE l.document_kind = 'xero_bill' AND l.document_id = 'ZZTEST-9920-' || d),
  'parts', (SELECT count(*) FROM public.job_cost_line_parts p JOIN public.job_cost_lines l ON l.id = p.line_id
            WHERE l.document_id = 'ZZTEST-9920-' || d),
  'items', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.reconcile_items i
            WHERE i.subject_id = 'xero_bill:ZZTEST-9920-' || d),
  'decisions', (SELECT count(*) FROM public.reconcile_decisions WHERE subject_id = 'xero_bill:ZZTEST-9920-' || d))
$$;

-- Ruling (5), director 04:34: with the switch OFF, reconcile_decide and
-- reconcile_undo write NOTHING: no decision row, no line state, no part, no
-- profit or page mark. Every table either body (or a function it calls) writes,
-- read whole, so a write anywhere moves the digest.
CREATE FUNCTION pg_temp.world() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
  'reconcile_decisions', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.reconcile_decisions t),
  'reconcile_items', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.reconcile_items t),
  'job_cost_lines', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.job_cost_lines t),
  'job_cost_line_parts', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.job_cost_line_parts t),
  'job_profit_dirty', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.job_profit_dirty t),
  'job_change_mark_events', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.job_change_mark_events t),
  'job_notes_marks_seen', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.job_notes_marks_seen t),
  'match_clues', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.match_clues t),
  'match_queue', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.match_queue t),
  'match_shadow_runs', (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM public.match_shadow_runs t))
$$;

DO $bodies$
/* block */ BEGIN
 PERFORM pg_temp.check_it(
   pg_temp.md5_of('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)') = '95d788204b6dbbc1817d48a254989130'
   AND pg_temp.md5_of('public.reconcile_undo(bigint,uuid)') = '7c7cf1647abd300405165d017cd35338',
   'own bodies after a re-apply');
 PERFORM pg_temp.check_it(
   (SELECT prosrc FROM pg_proc WHERE oid = 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)'::regprocedure)
     ~ 'reconcile_decide_v1'
   AND (SELECT prosrc FROM pg_proc WHERE oid = 'public.reconcile_undo(bigint,uuid)'::regprocedure) ~ 'reconcile_decide_v1',
   'both bodies read the switch');
 -- Only the check was added: grants, owner settings and security stay.
 PERFORM pg_temp.check_it(
   has_function_privilege('service_role', 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)', 'execute')
   AND NOT has_function_privilege('authenticated', 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)', 'execute')
   AND NOT has_function_privilege('anon', 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)', 'execute')
   AND has_function_privilege('service_role', 'public.reconcile_undo(bigint,uuid)', 'execute')
   AND NOT has_function_privilege('authenticated', 'public.reconcile_undo(bigint,uuid)', 'execute')
   AND NOT has_function_privilege('anon', 'public.reconcile_undo(bigint,uuid)', 'execute')
   AND (SELECT bool_and(prosecdef AND proconfig = ARRAY['search_path=""']) FROM pg_proc
        WHERE oid IN ('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)'::regprocedure,
                      'public.reconcile_undo(bigint,uuid)'::regprocedure)),
   'grants, security definer and search_path kept');
 PERFORM pg_temp.check_it(
   (SELECT enabled FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1') IS FALSE,
   'the switch is off as seeded, and the migration does not touch it');
END $bodies$;

-- Fixture: one staff member, one trade, one job, two waiting bills with items.
INSERT INTO public.users(id, org_id, name, role) VALUES
 ('99200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'office', 'ops_manager'),
 ('99200000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'trade', 'installer');
INSERT INTO public.jobs(id, org_id, job_number, type, status) VALUES
 ('99200000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-9920', 'fencing', 'accepted');
INSERT INTO public.job_cost_lines(org_id, kind, document_kind, document_id, line_key, source_hash, state, needs_reason, lane, amount_ex)
 SELECT '00000000-0000-0000-0000-0000000000a1', 'supplier_bill', 'xero_bill', 'ZZTEST-9920-' || d, '1',
   'source', 'needs_person', 'new', 'materials', 12 FROM unnest(ARRAY['off', 'on']) d;
CREATE FUNCTION pg_temp.item(d text) RETURNS uuid LANGUAGE sql AS $$
 SELECT public.reconcile_item_raise('bill', 'cost_document', 'xero_bill:ZZTEST-9920-' || d, '{}',
   '{"outcome":"job","clue_ids":[1]}', '{"reason":"one_clue","summary":{"number":"ZZTEST"}}', 'matcher:v1');
$$;
CREATE FUNCTION pg_temp.decide_sql(d text, who uuid) RETURNS text LANGUAGE sql AS $$
 SELECT format('SELECT public.reconcile_decide(%L, %L, ''place'', %L, NULL, false, %L)',
   i.id, i.evidence_hash, '[{"job_id":"99200000-0000-4000-8000-000000000004"}]', who)
 FROM public.reconcile_items i WHERE i.subject_id = 'xero_bill:ZZTEST-9920-' || d AND i.status = 'open'
$$;
CREATE FUNCTION pg_temp.set_switch(state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1';
 IF state = 'missing' THEN RETURN; END IF;
 INSERT INTO public.feature_flags(flag_name, enabled, description)
 VALUES ('reconcile_decide_v1', CASE state WHEN 'on' THEN true WHEN 'off' THEN false END, 'contract');
END $$;
-- A null switch is refused like off; allow storing one for this transaction.
ALTER TABLE public.feature_flags ALTER COLUMN enabled DROP NOT NULL;
ALTER TABLE public.feature_flags ALTER COLUMN enabled DROP DEFAULT;

DO $off$
DECLARE
 i uuid := pg_temp.item('off');
 before jsonb := pg_temp.state('off');
 world_before jsonb;
 st text;
 e text;
/* block */ BEGIN
 PERFORM pg_temp.check_it(i IS NOT NULL, 'fixture item raised');
 FOREACH st IN ARRAY ARRAY['off', 'missing', 'null'] LOOP
   PERFORM pg_temp.set_switch(st);
   world_before := pg_temp.world();
   e := pg_temp.error_of(pg_temp.decide_sql('off', '99200000-0000-4000-8000-000000000001'));
   PERFORM pg_temp.check_it(e = '55000 reconcile_decide_off', 'decide refused with the switch ' || st || ': ' || e);
   -- A trade is refused for the switch too: the switch is the first statement.
   e := pg_temp.error_of(pg_temp.decide_sql('off', '99200000-0000-4000-8000-000000000002'));
   PERFORM pg_temp.check_it(e = '55000 reconcile_decide_off', 'switch read before staff, ' || st);
   e := pg_temp.error_of('SELECT public.reconcile_undo(1, ''99200000-0000-4000-8000-000000000001'')');
   PERFORM pg_temp.check_it(e = '55000 reconcile_decide_off', 'undo refused with the switch ' || st || ': ' || e);
   PERFORM pg_temp.check_it(pg_temp.state('off') = before, 'nothing written with the switch ' || st);
   PERFORM pg_temp.check_it(pg_temp.world() = world_before,
     'switch ' || st || ': no decision row, line state, part, profit or page mark written anywhere');
 END LOOP;
END $off$;

-- MUST NOT CHANGE: with the switch on, a decision and its undo run exactly as
-- before; with it off again, an undo of that decision is refused and leaves it.
DO $on$
DECLARE
 i uuid := pg_temp.item('on');
 before jsonb := pg_temp.state('on');
 -- The undo contract's own view of a document's lines (20261118195300).
 before_lines jsonb := public.reconcile_undo_lines('00000000-0000-0000-0000-0000000000a1', 'xero_bill', 'ZZTEST-9920-on');
 placed jsonb;
 r jsonb;
 d bigint;
 e text;
 w jsonb;
/* block */ BEGIN
 PERFORM pg_temp.set_switch('on');
 e := pg_temp.error_of(pg_temp.decide_sql('on', '99200000-0000-4000-8000-000000000002'));
 PERFORM pg_temp.check_it(e = '42501 reconcile_not_staff', 'switch on: the staff rule still refuses a trade');
 w := pg_temp.world();
 EXECUTE pg_temp.decide_sql('on', '99200000-0000-4000-8000-000000000001') INTO r;
 -- The digest sees a real write: the same decide with the switch on moves it.
 PERFORM pg_temp.check_it(pg_temp.world() ->> 'reconcile_decisions' <> w ->> 'reconcile_decisions'
   AND pg_temp.world() ->> 'job_cost_lines' <> w ->> 'job_cost_lines', 'switch on: the digest sees the decision and the line move');
 d := (r ->> 'decision_id')::bigint;
 placed := pg_temp.state('on');
 PERFORM pg_temp.check_it(placed #>> '{lines,0,state}' = 'on_job' AND (placed ->> 'decisions')::int = 1
   AND r ->> 'item_status' = 'decided', 'switch on: place recorded and applied');
 PERFORM pg_temp.set_switch('off');
 w := pg_temp.world();
 e := pg_temp.error_of(format('SELECT public.reconcile_undo(%s, %L)', d, '99200000-0000-4000-8000-000000000001'));
 PERFORM pg_temp.check_it(e = '55000 reconcile_decide_off' AND pg_temp.state('on') = placed,
   'switch off: undo refused, the decision stands');
 PERFORM pg_temp.check_it(pg_temp.world() = w, 'switch off: undo of a real decision writes nothing anywhere');
 PERFORM pg_temp.set_switch('on');
 r := public.reconcile_undo(d, '99200000-0000-4000-8000-000000000001');
 PERFORM pg_temp.check_it(r ->> 'restored_item_id' = i::text
   AND public.reconcile_undo_lines('00000000-0000-0000-0000-0000000000a1', 'xero_bill', 'ZZTEST-9920-on') = before_lines
   AND (pg_temp.state('on') ->> 'parts')::int = 0
   AND (pg_temp.state('on') ->> 'decisions')::int = 2, 'switch on: undo puts the line back');
END $on$;

-- Rollback, re-run of the rollback, and apply again.
\ir ../../../rollbacks/20261118196000_reconcile_decide_switch_in_database_down.sql
SELECT pg_temp.check_it(
  pg_temp.md5_of('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)') = '5eb8d0b43f1a2b8339d3f739a6d05433'
  AND pg_temp.md5_of('public.reconcile_undo(bigint,uuid)') = '8d34d85b018204c72d7db66ea915dcda',
  'rollback returns main''s bodies');
\ir ../../../rollbacks/20261118196000_reconcile_decide_switch_in_database_down.sql
SELECT pg_temp.check_it(
  pg_temp.md5_of('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)') = '5eb8d0b43f1a2b8339d3f739a6d05433',
  'rollback re-run leaves main''s bodies');
\ir ../../../migrations/20261118196000_reconcile_decide_switch_in_database.sql
SELECT pg_temp.check_it(
  pg_temp.md5_of('public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)') = '95d788204b6dbbc1817d48a254989130'
  AND pg_temp.md5_of('public.reconcile_undo(bigint,uuid)') = '7c7cf1647abd300405165d017cd35338'
  AND has_function_privilege('service_role', 'public.reconcile_undo(bigint,uuid)', 'execute')
  AND NOT has_function_privilege('authenticated', 'public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid)', 'execute'),
  'apply again after a rollback');

-- A changed body is refused: break-contract.sql.

SELECT 'PASS reconcile decide switch in the database: off, missing and null refuse decide and undo before any read or write; on, place and undo run as before; grants kept; rollback returns main''s bodies; re-apply and apply-after-rollback hold' AS result;
SELECT count(*) AS checks FROM switch_checks;
ROLLBACK;
