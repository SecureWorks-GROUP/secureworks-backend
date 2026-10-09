-- Rollback contract: 20261007160000_context_ledger_pass_floor. The runner applied the stack through
-- this migration and then its down. finish is the 20261006013000 body and comment word for word with
-- its grants, and the old line judges again (2 of 5 refused by the reader fails whole). Over stored
-- readings, the migration re-applied on top of its own rollback (as on production, over the
-- 20261006013000 body) passes the ones the floor qualifies; the down then judges each one still a
-- shadow by the old line on its stored counts, an update since included, and removes the audit keys,
-- while one promoted since keeps its verdict and its audit keys. The down runs again cleanly.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger pass floor rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_restored() RETURNS void LANGUAGE plpgsql AS $$
DECLARE f constant text := 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'; p record;
BEGIN
 SELECT md5(pp.prosrc) AS m, pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c INTO p
 FROM pg_proc pp WHERE pp.oid = to_regprocedure(f);
 PERFORM pg_temp.rb_assert(p.m = '0c02a410bb32f46315fbf278090ef60e', 'finish is not the 20261006013000 body: ' || coalesce(p.m, '<missing>'));
 PERFORM pg_temp.rb_assert(p.c LIKE 'Context ledger store (20261006013000): closes a ledger run. %' AND p.c NOT LIKE '%pass floor%'
  AND p.c LIKE '%at most 20%, the store''s own refusals at most 20% of what it saw,%', 'finish comment is not 20261006013000''s: ' || coalesce(p.c, '<none>'));
 PERFORM pg_temp.rb_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], 'finish security or path changed');
 PERFORM pg_temp.rb_assert(has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', f, 'EXECUTE'), 'finish grants changed');
END $$;
CREATE FUNCTION pg_temp.rb_id(p_prefix text, p_n integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT (p_prefix || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.rb_job(p_id uuid, p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (p_id, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', p_number, 'Pat Example', NULL, 'rb-' || p_number,
  'Testville', '{}', '2026-09-01 00:00Z');
 RETURN p_id;
END $$;
CREATE FUNCTION pg_temp.rb_run(p_job uuid, p_token uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; d date := (now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at)
 VALUES (p_job, d, 'ledger', 'running', p_token, now() + interval '30 minutes',
  (SELECT coalesce(max(r.run_seq), 0) + 1 FROM public.context_extraction_runs r WHERE r.job_id = p_job AND r.run_date = d AND r.phase = 'ledger'),
  now() - interval '1 hour')
 RETURNING id INTO v;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.rb_receipt(p_run uuid, p_gen uuid, p_job uuid, p_accepted integer, p_refused integer) RETURNS void
LANGUAGE sql AS $$
 INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused, result)
 VALUES (p_run, p_gen, p_job, encode(sha256(convert_to(p_run::text, 'UTF8')), 'hex'), p_accepted, p_refused, '{"refused": []}') $$;
CREATE FUNCTION pg_temp.rb_meta(p_proposed integer, p_local integer, p_rows integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('model', 'rb-model', 'evidence_until', now() - interval '2 hours', 'evidence_rows', p_rows, 'chunks', 1,
  'calls', 1, 'tokens_in', 100, 'checks', jsonb_build_object('proposed', p_proposed, 'refused_local', p_local)) $$;
CREATE FUNCTION pg_temp.rb_checks(p_proposed integer, p_local integer, p_accepted integer, p_refused integer, p_items integer,
 p_rows integer, p_pass boolean) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('passed', p_pass, 'store', jsonb_build_object('items', p_items, 'items_accepted', p_accepted,
   'items_refused', p_refused, 'proposed', p_proposed, 'refused_local', p_local, 'refused_person_locked', 0, 'evidence_rows', p_rows,
   'pass', p_pass), 'reader', jsonb_build_object('kind', 'backfill', 'proposed', p_proposed, 'refused_local', p_local)) $$;
CREATE FUNCTION pg_temp.rb_gen(p_n integer, p_checks jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE g uuid := pg_temp.rb_id('f762a000', p_n);
BEGIN
 INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, evidence_until, created_at, finished_at, updated_at, checks)
 VALUES (g, pg_temp.rb_job(pg_temp.rb_id('f7620000', p_n), 'SWF-978' || lpad(p_n::text, 2, '0')), 'backfill', 'shadow', 'luna-ledger:v2',
  '2026-09-02 00:00Z', '2026-09-02 00:00Z', '2026-09-02 01:00Z', '2026-09-02 01:00Z', p_checks);
 RETURN g;
END $$;

SELECT pg_temp.rb_restored();

-- The old line judges again: 5 proposed, 2 refused by the reader's own validator, 3 kept fails whole.
BEGIN;
DO $c$
DECLARE j uuid := pg_temp.rb_job(pg_temp.rb_id('f7620000', 90), 'SWF-97890'); tok uuid := gen_random_uuid(); run uuid; gen uuid; k integer;
 fin jsonb;
BEGIN
 run := pg_temp.rb_run(j, tok);
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, run_id) VALUES (j, 'backfill', 'building', 'luna-ledger:v2', run)
 RETURNING id INTO gen;
 FOR k IN 1 .. 3 LOOP
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by)
  VALUES (gen, j, 'request:none:' || lpad(k::text, 12, '0'), 'request', 'open', 'customer', 'Fixture item ' || k, '2026-09-02 00:00Z',
   jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', pg_temp.rb_id('f762e000', k)::text, 'excerpt', 'x')),
   'model:luna-ledger:v2');
 END LOOP;
 PERFORM pg_temp.rb_receipt(run, gen, j, 3, 0);
 fin := public.context_ledger_finish(run, tok, gen, 'built', pg_temp.rb_meta(5, 2, 3));
 PERFORM pg_temp.rb_assert(fin ->> 'outcome' = 'built' AND NOT (fin ->> 'passed')::boolean, 'the old line fails 2 of 5 again: ' || fin::text);
END $c$;
ROLLBACK;

-- The re-judge undone.
BEGIN;
DO $c$
BEGIN
 -- 1: 2 of 5 refused by the reader; 2: the same, updated cleanly after the floor; 3: the same,
 -- promoted after the floor; 4: 3 of 5, which the floor never passed.
 PERFORM pg_temp.rb_gen(1, pg_temp.rb_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.rb_gen(2, pg_temp.rb_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.rb_gen(3, pg_temp.rb_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.rb_gen(4, pg_temp.rb_checks(5, 3, 2, 0, 2, 4, false));
END $c$;
CREATE TEMP TABLE rb_before AS
 SELECT g.id, g.checks FROM public.context_ledger_generations g WHERE g.id IN (SELECT pg_temp.rb_id('f762a000', n) FROM generate_series(1, 4) n);
-- The migration re-applies on top of its own rollback and passes 1, 2 and 3.
\ir ../../../migrations/20261007160000_context_ledger_pass_floor.sql
DO $c$
DECLARE g2 uuid := pg_temp.rb_id('f762a000', 2); tok uuid := gen_random_uuid(); run uuid; fin jsonb;
BEGIN
 PERFORM pg_temp.rb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure)
  = '24fdd0673f8692c082cf9d19c22ab210', 'the migration re-applies over its rollback');
 PERFORM pg_temp.rb_assert((SELECT count(*) FROM public.context_ledger_generations WHERE id IN (SELECT pg_temp.rb_id('f762a000', n) FROM generate_series(1, 3) n)
   AND checks ->> 'passed' = 'true' AND checks ->> 'repassed_by' = 'migration 20261007160000: pass floor') = 3
  AND (SELECT g.checks = b.checks FROM public.context_ledger_generations g JOIN rb_before b ON b.id = g.id WHERE g.id = pg_temp.rb_id('f762a000', 4)),
  'the floor passed the three it qualifies over the 20261006013000 body');
 -- 2 is updated cleanly under the floor; 3 goes live.
 run := pg_temp.rb_run((SELECT job_id FROM public.context_ledger_generations WHERE id = g2), tok);
 PERFORM pg_temp.rb_receipt(run, g2, (SELECT job_id FROM public.context_ledger_generations WHERE id = g2), 2, 0);
 fin := public.context_ledger_finish(run, tok, g2, 'updated', pg_temp.rb_meta(2, 0, 2));
 PERFORM pg_temp.rb_assert(fin ->> 'outcome' = 'updated' AND (fin ->> 'passed')::boolean, 'a clean update keeps a re-judged reading passed: ' || fin::text);
 PERFORM pg_temp.rb_assert(public.context_ledger_promote(pg_temp.rb_id('f762a000', 3), 'rule:rollback-contract') ->> 'outcome' = 'promoted',
  'a re-judged reading can be promoted');
END $c$;
\ir ../../../rollbacks/20261007160000_context_ledger_pass_floor_down.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_restored();
 -- 1 and 4 are exactly as they were stored before the floor.
 PERFORM pg_temp.rb_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g JOIN rb_before b ON b.id = g.id
   WHERE g.id IN (pg_temp.rb_id('f762a000', 1), pg_temp.rb_id('f762a000', 4)) AND (g.checks IS DISTINCT FROM b.checks OR g.status <> 'shadow')),
  'the down did not put the readings back as they were stored: '
   || (SELECT string_agg(g.checks::text, ' | ') FROM public.context_ledger_generations g WHERE g.id IN (pg_temp.rb_id('f762a000', 1), pg_temp.rb_id('f762a000', 4))));
 -- 2 keeps its later update, judged as finish judged it before the floor: the build fails, so the reading fails.
 PERFORM pg_temp.rb_assert((SELECT g.status = 'shadow' AND (g.checks - 'last_update') = b.checks AND g.checks #>> '{last_update,pass}' = 'true'
   FROM public.context_ledger_generations g JOIN rb_before b ON b.id = g.id WHERE g.id = pg_temp.rb_id('f762a000', 2)),
  'the updated reading is judged by the old line: ' || (SELECT checks::text FROM public.context_ledger_generations WHERE id = pg_temp.rb_id('f762a000', 2)));
 -- 3 went live: the rollback never demotes it, and its audit keys stay.
 PERFORM pg_temp.rb_assert((SELECT g.status = 'live' AND g.checks ->> 'passed' = 'true' AND g.checks ->> 'repassed_by' = 'migration 20261007160000: pass floor'
   FROM public.context_ledger_generations g WHERE g.id = pg_temp.rb_id('f762a000', 3)), 'the promoted reading kept its verdict and audit keys');
END $c$;
ROLLBACK;

-- The down runs again cleanly (it accepts the body it restored).
BEGIN;
\ir ../../../rollbacks/20261007160000_context_ledger_pass_floor_down.sql
SELECT pg_temp.rb_restored();
ROLLBACK;
