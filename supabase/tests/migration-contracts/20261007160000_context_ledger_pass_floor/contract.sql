-- Contract: 20261007160000_context_ledger_pass_floor. Every fixture write is rolled back. Ids, job
-- numbers and counts are synthetic. Each reading states its counts exactly (one receipt per run for
-- what the store accepted and refused, the reader's own count in p_meta.checks, its items written
-- straight in), so no fixture depends on the item check's rules. Every job and stored reading is
-- dated at a fixed instant; a verdict reads no clock but its own run's.
--
--  1. Shape: finish keeps its signature, definer and path, grants (service role only) and the store's
--     comment marker first, now naming this slice; context_ledger_checks_pass is untouched; nothing
--     is switched on.
--  2. The verdict through finish. Small readings: 5 proposed with 2 refused by the reader's own
--     validator passes and goes live in live mode; 3 of 5 still fails; 2 by the reader and 1 by the
--     store (3 in all) fails; the store refusing 1 of 2 passes, 2 of 4 fails. Big readings keep the
--     20%: 4 of 20 refused by the reader passes, 5 of 20 fails; the store refusing 2 of 10 passes,
--     3 of 10 fails. A build that read evidence and kept no item still fails (none read, none
--     needed). An update is judged by the same line and still combines with its build's verdict.
--  3. The re-judge (the migration re-applied over stored readings in a rolled-back transaction): only
--     a failed shadow luna-ledger:v2 reading whose stored verdicts the old line explains and the new
--     line passes is passed, with its audit keys; live, retired, failed and building readings, another
--     reader's, a passed one, one whose verdict its counts do not explain and one with counts missing
--     are untouched; a second apply writes nothing.
--  4. Re-applying the migration changes no body, comment or grant.
--  5. Last, so a behaviour break above is reported by its behaviour: the body is this migration's.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.pf_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger pass floor contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.pf_id(p_prefix text, p_n integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT (p_prefix || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- A job created at a fixed instant.
CREATE FUNCTION pg_temp.pf_job(p_id uuid, p_number text) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (p_id, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', p_number, 'Pat Example', NULL, 'pf-' || p_number,
  'Testville', '{}', '2026-09-01 00:00Z');
 RETURN p_id;
END $$;
-- A running ledger run holding its lease (started an hour ago, so the reading's evidence_until stands).
CREATE FUNCTION pg_temp.pf_run(p_job uuid, p_token uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; d date := (now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at)
 VALUES (p_job, d, 'ledger', 'running', p_token, now() + interval '30 minutes',
  (SELECT coalesce(max(r.run_seq), 0) + 1 FROM public.context_extraction_runs r WHERE r.job_id = p_job AND r.run_date = d AND r.phase = 'ledger'),
  now() - interval '1 hour')
 RETURNING id INTO v;
 RETURN v;
END $$;
-- The store's receipt for a run: what it accepted and refused (none for a person's settled matter).
CREATE FUNCTION pg_temp.pf_receipt(p_run uuid, p_gen uuid, p_job uuid, p_accepted integer, p_refused integer) RETURNS void
LANGUAGE sql AS $$
 INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused, result)
 VALUES (p_run, p_gen, p_job, encode(sha256(convert_to(p_run::text, 'UTF8')), 'hex'), p_accepted, p_refused, '{"refused": []}') $$;
-- The reader's meta: its own count of what it proposed and refused before the store saw it.
CREATE FUNCTION pg_temp.pf_meta(p_proposed integer, p_local integer, p_rows integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('model', 'pf-model', 'evidence_until', now() - interval '2 hours', 'evidence_rows', p_rows, 'chunks', 1,
  'calls', 1, 'tokens_in', 100, 'checks', jsonb_build_object('proposed', p_proposed, 'refused_local', p_local)) $$;
-- One finished build on a new job: its building generation, p_items items (the store's accepted ones
-- unless said), the store's receipt, then finish. Returns finish's answer with the generation and run.
CREATE FUNCTION pg_temp.pf_build(p_n integer, p_proposed integer, p_local integer, p_accepted integer, p_refused integer,
 p_items integer DEFAULT NULL, p_rows integer DEFAULT 3) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j uuid; run uuid; gen uuid; tok uuid := gen_random_uuid(); k integer;
BEGIN
 j := pg_temp.pf_job(pg_temp.pf_id('f7600000', p_n), 'SWF-976' || lpad(p_n::text, 2, '0'));
 run := pg_temp.pf_run(j, tok);
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, run_id)
 VALUES (j, 'backfill', 'building', 'luna-ledger:v2', run) RETURNING id INTO gen;
 FOR k IN 1 .. coalesce(p_items, p_accepted) LOOP
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by)
  VALUES (gen, j, 'request:none:' || lpad(k::text, 12, '0'), 'request', 'open', 'customer', 'Fixture item ' || k, '2026-09-02 00:00Z',
   jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', pg_temp.pf_id('f760e000', k)::text, 'excerpt', 'x')),
   'model:luna-ledger:v2');
 END LOOP;
 PERFORM pg_temp.pf_receipt(run, gen, j, p_accepted, p_refused);
 RETURN public.context_ledger_finish(run, tok, gen, 'built', pg_temp.pf_meta(p_proposed, p_local, p_rows))
  || jsonb_build_object('generation_id', gen, 'run_id', run);
END $$;
-- The checks finish stores on a build, from its counts (rates as finish rounds them) and the verdict it gave.
CREATE FUNCTION pg_temp.pf_checks(p_proposed integer, p_local integer, p_accepted integer, p_refused integer, p_items integer,
 p_rows integer, p_pass boolean) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('passed', p_pass, 'store', jsonb_build_object('items', p_items, 'items_accepted', p_accepted,
   'items_refused', p_refused, 'refused_rate', CASE WHEN p_accepted + p_refused = 0 THEN 0
    ELSE trim_scale(round(p_refused::numeric / (p_accepted + p_refused), 4)) END,
   'proposed', p_proposed, 'refused_local', p_local,
   'refusal_rate', trim_scale(round((p_local + p_refused)::numeric / greatest(p_proposed, p_accepted + p_refused, 1), 4)),
   'refused_person_locked', 0, 'evidence_rows', p_rows, 'pass', p_pass),
  'reader', jsonb_build_object('kind', 'backfill', 'proposed', p_proposed, 'refused_local', p_local)) $$;
-- The same checks after an update: the build's verdict and this update's together, as finish stores them.
CREATE FUNCTION pg_temp.pf_updated(p_checks jsonb, p_proposed integer, p_local integer, p_accepted integer, p_refused integer,
 p_pass boolean) RETURNS jsonb LANGUAGE sql AS $$
 SELECT p_checks || jsonb_build_object('passed', (p_checks #>> '{store,pass}')::boolean AND p_pass,
  'last_update', jsonb_build_object('run_id', 'f76f0000-0000-4000-8000-000000000001', 'at', '2026-09-05T00:00:00+00:00',
   'items_accepted', p_accepted, 'items_refused', p_refused, 'proposed', p_proposed, 'refused_local', p_local,
   'refused_rate', CASE WHEN p_accepted + p_refused = 0 THEN 0 ELSE trim_scale(round(p_refused::numeric / (p_accepted + p_refused), 4)) END,
   'refusal_rate', trim_scale(round((p_local + p_refused)::numeric / greatest(p_proposed, p_accepted + p_refused, 1), 4)),
   'refused_person_locked', 0, 'evidence_rows', 2, 'pass', p_pass, 'reader', jsonb_build_object('kind', 'update'))) $$;
-- A stored reading on its own new job, finished at a fixed instant.
CREATE FUNCTION pg_temp.pf_gen(p_n integer, p_status text, p_reader text, p_checks jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid; g uuid := pg_temp.pf_id('f761a000', p_n);
BEGIN
 j := pg_temp.pf_job(pg_temp.pf_id('f7610000', p_n), 'SWF-977' || lpad(p_n::text, 2, '0'));
 INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, evidence_until, promoted_at, retired_at, failure,
  created_at, finished_at, updated_at, checks)
 VALUES (g, j, 'backfill', p_status, p_reader, '2026-09-02 00:00Z',
  CASE WHEN p_status IN ('live', 'retired') THEN '2026-09-03 00:00Z'::timestamptz END,
  CASE WHEN p_status = 'retired' THEN '2026-09-04 00:00Z'::timestamptz END,
  CASE WHEN p_status = 'failed' THEN 'model_timeout' END,
  '2026-09-02 00:00Z', CASE WHEN p_status <> 'building' THEN '2026-09-02 01:00Z'::timestamptz END, '2026-09-02 01:00Z', p_checks);
 RETURN g;
END $$;
-- An update of a stored reading: a run on its job, the store's receipt, then finish.
CREATE FUNCTION pg_temp.pf_update(p_gen uuid, p_proposed integer, p_local integer, p_accepted integer, p_refused integer) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE j uuid; run uuid; tok uuid := gen_random_uuid();
BEGIN
 SELECT g.job_id INTO j FROM public.context_ledger_generations g WHERE g.id = p_gen;
 run := pg_temp.pf_run(j, tok);
 PERFORM pg_temp.pf_receipt(run, p_gen, j, p_accepted, p_refused);
 RETURN public.context_ledger_finish(run, tok, p_gen, 'updated', pg_temp.pf_meta(p_proposed, p_local, 2));
END $$;

-- 1. Shape.
DO $c$
DECLARE f constant text := 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'; p record;
BEGIN
 SELECT pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c INTO p FROM pg_proc pp WHERE pp.oid = to_regprocedure(f);
 PERFORM pg_temp.pf_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], 'finish must stay definer with search_path public, pg_temp');
 PERFORM pg_temp.pf_assert(has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', f, 'EXECUTE'), 'finish grants changed');
 PERFORM pg_temp.pf_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'finish executable by PUBLIC');
 PERFORM pg_temp.pf_assert(p.c LIKE 'Context ledger store (20261006013000), ledger pass floor (20261007160000): closes a ledger run. %'
  AND p.c LIKE '%or 2, whichever is more%' AND p.c LIKE '%or 1, whichever is more%' AND p.c LIKE '%(checks.repassed_by)%',
  'finish comment: ' || coalesce(p.c, '<none>'));
 -- The one verdict reader is untouched: it reads checks.passed and nothing else.
 PERFORM pg_temp.pf_assert(obj_description('public.context_ledger_checks_pass(jsonb)'::regprocedure, 'pg_proc') LIKE 'Context ledger store (20261006013000): %'
  AND public.context_ledger_checks_pass('{"passed": true}') AND NOT public.context_ledger_checks_pass('{"passed": false, "store": {"pass": true}}'),
  'context_ledger_checks_pass changed');
 -- Nothing switched on: the ledger stays off with no calls.
 PERFORM pg_temp.pf_assert((SELECT mode = 'off' AND calls_per_day = 0 FROM public.context_ledger_settings), 'ledger settings changed');
END $c$;

-- 2. The verdict through finish.
BEGIN;
DO $c$
DECLARE fin jsonb; g uuid;
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live';
 -- 5 proposed, 2 refused by the reader's own validator, the 3 it kept accepted by the store (40%):
 -- the old line failed it whole; now it passes, and in live mode it goes live.
 fin := pg_temp.pf_build(1, 5, 2, 3, 0);
 PERFORM pg_temp.pf_assert(fin ->> 'outcome' = 'built' AND (fin ->> 'passed')::boolean AND (fin ->> 'promoted')::boolean
  AND fin ->> 'generation_status' = 'live' AND (fin #>> '{checks,refusal_rate}')::numeric = 0.4,
  '5 proposed, 2 refused by the reader''s own validator: passes: ' || fin::text);
 PERFORM pg_temp.pf_assert((SELECT g2.status = 'live' AND g2.checks ->> 'passed' = 'true' AND g2.checks #>> '{store,pass}' = 'true'
   AND g2.checks #>> '{store,proposed}' = '5' AND g2.checks #>> '{store,refused_local}' = '2' AND NOT g2.checks ? 'repassed_by'
   FROM public.context_ledger_generations g2 WHERE g2.id = (fin ->> 'generation_id')::uuid)
  AND (SELECT r.status = 'done' AND r.error IS NULL FROM public.context_extraction_runs r WHERE r.id = (fin ->> 'run_id')::uuid),
  'the verdict is stored on the reading and its run is clean: ' || fin::text);
 -- 3 of 5 refused by the reader still fails whole, and the run counts toward the backoff.
 fin := pg_temp.pf_build(2, 5, 3, 2, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean AND fin ->> 'generation_status' = 'shadow'
  AND (SELECT r.error = 'checks_failed' FROM public.context_extraction_runs r WHERE r.id = (fin ->> 'run_id')::uuid),
  '3 of 5 refused by the reader still fails: ' || fin::text);
 -- 2 by the reader and 1 by the store, 3 of 5 in all: fails.
 fin := pg_temp.pf_build(3, 5, 2, 2, 1);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND (fin #>> '{checks,refusal_rate}')::numeric = 0.6,
  '2 by the reader and 1 by the store still fails: ' || fin::text);
 -- The store's own refusals: 1 of the 2 it saw passes (the old line failed it, 50%); 2 of 4 fails.
 fin := pg_temp.pf_build(4, 0, 0, 1, 1);
 PERFORM pg_temp.pf_assert((fin ->> 'passed')::boolean AND (fin #>> '{checks,refused_rate}')::numeric = 0.5,
  'the store refusing 1 of 2 passes: ' || fin::text);
 fin := pg_temp.pf_build(5, 0, 0, 2, 2);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND (fin #>> '{checks,refused_rate}')::numeric = 0.5,
  'the store refusing 2 of 4 still fails: ' || fin::text);
 -- A big reading keeps the 20%: 4 of 20 refused by the reader passes, 5 of 20 fails ...
 fin := pg_temp.pf_build(6, 20, 4, 16, 0);
 PERFORM pg_temp.pf_assert((fin ->> 'passed')::boolean, '4 of 20 refused by the reader passes: ' || fin::text);
 fin := pg_temp.pf_build(7, 20, 5, 15, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean, 'a big reading still uses 20%: 5 of 20 refused by the reader fails: ' || fin::text);
 -- ... and the store's own share is 20% of what it saw: 2 of 10 passes, 3 of 10 fails (both under the
 -- 20% of the 20 proposed, so only the store's share decides).
 fin := pg_temp.pf_build(8, 20, 0, 8, 2);
 PERFORM pg_temp.pf_assert((fin ->> 'passed')::boolean, 'the store refusing 2 of 10 passes: ' || fin::text);
 fin := pg_temp.pf_build(9, 20, 0, 7, 3);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND (fin #>> '{checks,refusal_rate}')::numeric = 0.15,
  'a big reading still uses 20%: the store refusing 3 of 10 fails: ' || fin::text);
 -- A build that read evidence still needs an item, refusals within the floor or not; one that read
 -- none needs none.
 fin := pg_temp.pf_build(10, 1, 1, 0, 0, 0, 3);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean, 'evidence read and no item kept still fails: ' || fin::text);
 fin := pg_temp.pf_build(11, 0, 0, 0, 0, 0, 0);
 PERFORM pg_temp.pf_assert((fin ->> 'passed')::boolean, 'no evidence and no item passes: ' || fin::text);
 -- An update is judged by the same line, and still combines with its build's verdict.
 g := pg_temp.pf_gen(1, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(4, 0, 4, 0, 4, 5, true));
 fin := pg_temp.pf_update(g, 3, 2, 1, 0);
 PERFORM pg_temp.pf_assert(fin ->> 'outcome' = 'updated' AND (fin ->> 'passed')::boolean AND (fin ->> 'promoted')::boolean
  AND (SELECT g2.checks #>> '{last_update,pass}' = 'true' AND g2.checks #>> '{last_update,refused_local}' = '2'
       FROM public.context_ledger_generations g2 WHERE g2.id = g),
  'an update with 2 of 3 refused by the reader passes on a passing build: ' || fin::text);
 g := pg_temp.pf_gen(2, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(4, 0, 4, 0, 4, 5, true));
 fin := pg_temp.pf_update(g, 5, 3, 2, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean
  AND (SELECT g2.status = 'shadow' AND g2.checks #>> '{last_update,pass}' = 'false' FROM public.context_ledger_generations g2 WHERE g2.id = g),
  'an update with 3 of 5 refused by the reader still fails: ' || fin::text);
 g := pg_temp.pf_gen(3, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 3, 2, 0, 2, 5, false));
 fin := pg_temp.pf_update(g, 2, 0, 2, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean
  AND (SELECT g2.checks #>> '{last_update,pass}' = 'true' FROM public.context_ledger_generations g2 WHERE g2.id = g),
  'a clean update keeps a build the floor still fails failed: ' || fin::text);
END $c$;
ROLLBACK;

-- 3. The re-judge, and 4. re-applying changes no body, comment or grant. The readings as finish
-- stored them before the floor, then the migration applied over them.
BEGIN;
DO $c$
BEGIN
 -- Passed by the floor: a build with 2 of 5 refused by the reader; a build whose store refused 1 of
 -- the 2 it saw; a passing build whose last update had 1 of 3 refused by the reader.
 PERFORM pg_temp.pf_gen(1, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(2, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(2, 0, 1, 1, 1, 2, false));
 PERFORM pg_temp.pf_gen(3, 'shadow', 'luna-ledger:v2', pg_temp.pf_updated(pg_temp.pf_checks(24, 2, 22, 0, 22, 30, true), 3, 1, 2, 0, false));
 -- Still failing under the floor: 3 of 5 by the reader; the store 2 of 4; no item from evidence; 5 of
 -- 20 by the reader; a build the floor passes whose last update the floor still fails.
 PERFORM pg_temp.pf_gen(4, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 3, 2, 0, 2, 4, false));
 PERFORM pg_temp.pf_gen(5, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(4, 0, 2, 2, 2, 3, false));
 PERFORM pg_temp.pf_gen(6, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(1, 1, 0, 0, 0, 3, false));
 PERFORM pg_temp.pf_gen(7, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(20, 5, 15, 0, 15, 40, false));
 PERFORM pg_temp.pf_gen(8, 'shadow', 'luna-ledger:v2', pg_temp.pf_updated(pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false), 5, 3, 2, 0, false));
 -- Never touched: already passed; a verdict the old line does not explain on its counts (failed
 -- although its counts passed, and passed at build although its counts failed); counts missing; a
 -- passed key that is not a boolean; another reader's; live, retired, failed and building readings.
 PERFORM pg_temp.pf_gen(9, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 1, 4, 0, 4, 4, true));
 PERFORM pg_temp.pf_gen(10, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 1, 4, 0, 4, 4, false));
 PERFORM pg_temp.pf_gen(11, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false)
  || jsonb_build_object('store', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, true) -> 'store'));
 PERFORM pg_temp.pf_gen(12, 'shadow', 'luna-ledger:v2', '{"passed": false, "store": {"pass": false, "proposed": 5, "refused_local": 2}}');
 PERFORM pg_temp.pf_gen(13, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false) || '{"passed": "false"}'::jsonb);
 PERFORM pg_temp.pf_gen(14, 'shadow', 'luna-ledger:v1', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(15, 'live', 'luna-ledger:v2', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(16, 'retired', 'luna-ledger:v2', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(17, 'failed', 'luna-ledger:v2', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(18, 'building', 'luna-ledger:v2', pg_temp.pf_checks(5, 2, 3, 0, 3, 4, false));
END $c$;
CREATE TEMP TABLE pf_before AS
 SELECT g.id, g.status, g.checks, g.updated_at FROM public.context_ledger_generations g
 WHERE g.id IN (SELECT pg_temp.pf_id('f761a000', n) FROM generate_series(1, 18) n);
CREATE TEMP TABLE pf_fn AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS cfg
 FROM pg_proc p WHERE p.oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure;
\ir ../../../migrations/20261007160000_context_ledger_pass_floor.sql
DO $c$
DECLARE audit constant jsonb := jsonb_build_object('repassed_by', 'migration 20261007160000: pass floor', 'repassed_at', now());
 flipped constant uuid[] := ARRAY[pg_temp.pf_id('f761a000', 1), pg_temp.pf_id('f761a000', 2), pg_temp.pf_id('f761a000', 3)];
BEGIN
 PERFORM pg_temp.pf_assert((SELECT g.status = 'shadow' AND g.updated_at = now() AND g.checks = b.checks
    || jsonb_build_object('passed', true, 'store', (b.checks -> 'store') || '{"pass": true}'::jsonb) || audit
    || jsonb_build_object('repassed_from', jsonb_build_object('passed', false, 'store_pass', false))
   FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id WHERE g.id = flipped[1]),
  'a reading with 2 of 5 refused by the reader is passed on its stored counts: '
   || (SELECT g.checks::text FROM public.context_ledger_generations g WHERE g.id = flipped[1]));
 PERFORM pg_temp.pf_assert((SELECT g.status = 'shadow' AND g.updated_at = now() AND g.checks = b.checks
    || jsonb_build_object('passed', true, 'store', (b.checks -> 'store') || '{"pass": true}'::jsonb) || audit
    || jsonb_build_object('repassed_from', jsonb_build_object('passed', false, 'store_pass', false))
   FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id WHERE g.id = flipped[2]),
  'a reading whose store refused 1 of 2 is passed: ' || (SELECT g.checks::text FROM public.context_ledger_generations g WHERE g.id = flipped[2]));
 PERFORM pg_temp.pf_assert((SELECT g.status = 'shadow' AND g.updated_at = now() AND g.checks = b.checks
    || jsonb_build_object('passed', true, 'last_update', (b.checks -> 'last_update') || '{"pass": true}'::jsonb) || audit
    || jsonb_build_object('repassed_from', jsonb_build_object('passed', false, 'store_pass', true, 'last_update_pass', false))
   FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id WHERE g.id = flipped[3]),
  'a passing build whose last update had 1 of 3 refused is passed: '
   || (SELECT g.checks::text FROM public.context_ledger_generations g WHERE g.id = flipped[3]));
 PERFORM pg_temp.pf_assert((SELECT bool_and(public.context_ledger_checks_pass(g.checks)) FROM public.context_ledger_generations g
   WHERE g.id = ANY(flipped)), 'the one verdict reads the re-judged readings as passed');
 PERFORM pg_temp.pf_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id
   WHERE NOT (g.id = ANY(flipped)) AND (g.checks IS DISTINCT FROM b.checks OR g.updated_at IS DISTINCT FROM b.updated_at
    OR g.status IS DISTINCT FROM b.status)),
  'only the three the floor passes were changed: ' || coalesce((SELECT string_agg(g.id::text, ', ') FROM public.context_ledger_generations g
   JOIN pf_before b ON b.id = g.id WHERE NOT (g.id = ANY(flipped)) AND g.checks IS DISTINCT FROM b.checks), ''));
 -- 4. The re-apply changed no body, comment or grant.
 PERFORM pg_temp.pf_assert((SELECT f.m = md5(p.prosrc) AND f.c IS NOT DISTINCT FROM obj_description(p.oid, 'pg_proc')
   AND f.acl IS NOT DISTINCT FROM p.proacl::text AND f.prosecdef = p.prosecdef AND f.cfg IS NOT DISTINCT FROM p.proconfig::text
  FROM pf_fn f, pg_proc p WHERE p.oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure),
  're-applying changed finish''s body, comment or grants');
END $c$;
-- A second apply writes nothing: every reading keeps its row version.
CREATE TEMP TABLE pf_mid AS
 SELECT g.id, g.ctid::text AS row_version, g.checks FROM public.context_ledger_generations g
 WHERE g.id IN (SELECT pg_temp.pf_id('f761a000', n) FROM generate_series(1, 18) n);
\ir ../../../migrations/20261007160000_context_ledger_pass_floor.sql
DO $c$ BEGIN
 PERFORM pg_temp.pf_assert((SELECT count(*) FROM pf_mid) = 18 AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g
   JOIN pf_mid m ON m.id = g.id WHERE g.ctid::text <> m.row_version OR g.checks IS DISTINCT FROM m.checks),
  'a second apply wrote a reading');
END $c$;
ROLLBACK;

-- 5. Last, so a behaviour break above is reported by its behaviour: finish is this migration's body.
DO $c$ BEGIN
 PERFORM pg_temp.pf_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure)
  = '24fdd0673f8692c082cf9d19c22ab210', 'context_ledger_finish is not this migration''s body');
END $c$;
