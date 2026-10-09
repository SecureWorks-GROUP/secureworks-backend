-- Contract: 20261007160000_context_ledger_pass_floor, the ledger pass rule: at most half refused (owner
-- ruling 9 Oct 2026). Every fixture write is rolled back. Ids, job numbers and counts are synthetic.
-- Each reading states its counts exactly (one receipt per run for what the store accepted and
-- refused, the reader's own count in p_meta.checks, its items written straight in), so no fixture
-- depends on the item check's rules. Every job and stored reading is dated at a fixed instant; a
-- verdict reads no clock but its own run's.
--
--  1. Shape: finish keeps its signature, definer and path, grants (service role only) and the store's
--     comment marker first, now naming this slice and the rule; context_ledger_checks_pass is
--     untouched; nothing is switched on.
--  2. The verdict through finish, at most half refused: 3 of 6 refused by the reader's own validator
--     passes and goes live in live mode; 4 of 7 fails and its run counts toward the backoff; 2 of 3
--     fails (no floor for small readings); 5 of 10 in all (3 by the reader, 2 by the store) passes and
--     6 of 10 (4 and 2) fails; the store refusing 4 of the 8 it saw passes and 5 of 8 fails, even when
--     the reader's count keeps the share in all under half. A build that read evidence and kept no item
--     still fails (none read, none needed). An update is judged by the same line (3 of 6 passes, 4 of 7
--     fails, the store's 5 of 8 fails) and still combines with its build's verdict.
--  3. The re-judge (the migration re-applied over stored readings in a rolled-back transaction): only
--     a hidden shadow luna-ledger:v2 reading whose stored verdicts the old line explains and the half
--     rule passes is passed, with store.pass, last_update.pass after an update, and its audit keys;
--     readings the half rule still fails, live, retired, failed and building readings, another
--     reader's, a passed one, one whose verdict its counts do not explain, one with counts missing and
--     the readings the owner's direct re-judge marked (passed, or failed again by an update since) are
--     untouched; a second apply writes nothing.
--  4. Re-applying the migration changes no body, comment or grant.
--  5. Last, so a behaviour break above is reported by its behaviour: the body is this migration's.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.pf_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger pass rule contract: %', p_msg; END IF; END $$;
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
-- The keys the owner's direct re-judge of 9 Oct 2026 wrote on a hidden reading, as production holds
-- them: checks.passed true, its own marker, the verdict it had; store.pass left as it was.
CREATE FUNCTION pg_temp.pf_owner() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('passed', true,
  'repassed_by', 'owner go 9 Oct 2026 (Marnin): at most half of notes refused; refused notes stay dropped', 'passed_before_repass', false) $$;
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
 PERFORM pg_temp.pf_assert(p.c LIKE 'Context ledger store (20261006013000), ledger pass rule (20261007160000): closes a ledger run. %'
  AND p.c LIKE '%The verdict, at most half refused (owner ruling 9 Oct 2026), counts both sides%'
  AND p.c LIKE '%at most 50#% of what it saw%' ESCAPE '#' AND p.c LIKE '%(checks.repassed_by)%'
  AND p.c NOT LIKE '%at most 20#%%' ESCAPE '#' AND p.c NOT LIKE '%whichever is more%', 'finish comment: ' || coalesce(p.c, '<none>'));
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
 -- 6 proposed, 3 refused by the reader's own validator, the 3 it kept accepted by the store: exactly
 -- half. The old line failed it whole; now it passes, and in live mode it goes live.
 fin := pg_temp.pf_build(1, 6, 3, 3, 0);
 PERFORM pg_temp.pf_assert(fin ->> 'outcome' = 'built' AND (fin ->> 'passed')::boolean AND (fin ->> 'promoted')::boolean
  AND fin ->> 'generation_status' = 'live' AND (fin #>> '{checks,refusal_rate}')::numeric = 0.5,
  '3 of 6 refused by the reader''s own validator: passes: ' || fin::text);
 PERFORM pg_temp.pf_assert((SELECT g2.status = 'live' AND g2.checks ->> 'passed' = 'true' AND g2.checks #>> '{store,pass}' = 'true'
   AND g2.checks #>> '{store,proposed}' = '6' AND g2.checks #>> '{store,refused_local}' = '3' AND NOT g2.checks ? 'repassed_by'
   FROM public.context_ledger_generations g2 WHERE g2.id = (fin ->> 'generation_id')::uuid)
  AND (SELECT r.status = 'done' AND r.error IS NULL FROM public.context_extraction_runs r WHERE r.id = (fin ->> 'run_id')::uuid),
  'the verdict is stored on the reading and its run is clean: ' || fin::text);
 -- 4 of 7 refused by the reader is more than half: it fails whole, and the run counts toward the backoff.
 fin := pg_temp.pf_build(2, 7, 4, 3, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean AND fin ->> 'generation_status' = 'shadow'
  AND (fin #>> '{checks,refusal_rate}')::numeric = 0.5714
  AND (SELECT r.error = 'checks_failed' FROM public.context_extraction_runs r WHERE r.id = (fin ->> 'run_id')::uuid),
  '4 of 7 refused by the reader fails: ' || fin::text);
 -- No floor for a small reading: 2 of 3 refused by the reader is more than half and fails.
 fin := pg_temp.pf_build(3, 3, 2, 1, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND (fin #>> '{checks,refusal_rate}')::numeric = 0.6667,
  '2 of 3 refused by the reader fails: ' || fin::text);
 -- Both sides count together: 5 of 10 in all (3 by the reader, 2 of the 7 the store saw) passes;
 -- 6 of 10 in all (4 by the reader, 2 of the 6 the store saw) fails.
 fin := pg_temp.pf_build(4, 10, 3, 5, 2);
 PERFORM pg_temp.pf_assert((fin ->> 'passed')::boolean AND (fin #>> '{checks,refusal_rate}')::numeric = 0.5,
  '5 of 10 refused in all passes: ' || fin::text);
 fin := pg_temp.pf_build(5, 10, 4, 4, 2);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND (fin #>> '{checks,refusal_rate}')::numeric = 0.6,
  '6 of 10 refused in all fails: ' || fin::text);
 -- The store's own share: refusing 4 of the 8 it saw passes; 5 of 8 fails even when the reader says it
 -- proposed 16 (5 of 16 in all is under half, so only the store's own share decides).
 fin := pg_temp.pf_build(6, 8, 0, 4, 4);
 PERFORM pg_temp.pf_assert((fin ->> 'passed')::boolean AND (fin #>> '{checks,refused_rate}')::numeric = 0.5,
  'the store refusing 4 of 8 passes: ' || fin::text);
 fin := pg_temp.pf_build(7, 16, 0, 3, 5);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND (fin #>> '{checks,refused_rate}')::numeric = 0.625
  AND (fin #>> '{checks,refusal_rate}')::numeric = 0.3125, 'the store refusing 5 of 8 fails: ' || fin::text);
 -- A build that read evidence still needs an item, its refusals within half or not (1 of 2 here); one
 -- that read none needs none.
 fin := pg_temp.pf_build(8, 2, 1, 0, 0, 0, 3);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND (fin #>> '{checks,refusal_rate}')::numeric = 0.5,
  'evidence read and no item kept still fails: ' || fin::text);
 fin := pg_temp.pf_build(9, 0, 0, 0, 0, 0, 0);
 PERFORM pg_temp.pf_assert((fin ->> 'passed')::boolean, 'no evidence and no item passes: ' || fin::text);
 -- An update is judged by the same line, and still combines with its build's verdict.
 g := pg_temp.pf_gen(1, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(4, 0, 4, 0, 4, 5, true));
 fin := pg_temp.pf_update(g, 6, 3, 3, 0);
 PERFORM pg_temp.pf_assert(fin ->> 'outcome' = 'updated' AND (fin ->> 'passed')::boolean AND (fin ->> 'promoted')::boolean
  AND (SELECT g2.checks #>> '{last_update,pass}' = 'true' AND g2.checks #>> '{last_update,refused_local}' = '3'
       FROM public.context_ledger_generations g2 WHERE g2.id = g),
  'an update with 3 of 6 refused by the reader passes on a passing build: ' || fin::text);
 g := pg_temp.pf_gen(2, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(4, 0, 4, 0, 4, 5, true));
 fin := pg_temp.pf_update(g, 7, 4, 3, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean
  AND (SELECT g2.status = 'shadow' AND g2.checks #>> '{last_update,pass}' = 'false' FROM public.context_ledger_generations g2 WHERE g2.id = g),
  'an update with 4 of 7 refused by the reader fails: ' || fin::text);
 g := pg_temp.pf_gen(3, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(4, 0, 4, 0, 4, 5, true));
 fin := pg_temp.pf_update(g, 16, 0, 3, 5);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean
  AND (SELECT g2.status = 'shadow' AND g2.checks #>> '{last_update,pass}' = 'false' FROM public.context_ledger_generations g2 WHERE g2.id = g),
  'an update whose store refused 5 of 8 fails: ' || fin::text);
 g := pg_temp.pf_gen(4, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(7, 4, 3, 0, 3, 5, false));
 fin := pg_temp.pf_update(g, 2, 0, 2, 0);
 PERFORM pg_temp.pf_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean
  AND (SELECT g2.checks #>> '{last_update,pass}' = 'true' FROM public.context_ledger_generations g2 WHERE g2.id = g),
  'a clean update keeps a build the half rule still fails failed: ' || fin::text);
END $c$;
ROLLBACK;

-- 3. The re-judge, and 4. re-applying changes no body, comment or grant. The readings as finish
-- stored them under the 20% line (and the owner's direct re-judge), then the migration applied over them.
BEGIN;
DO $c$
BEGIN
 -- Passed by the half rule: a build with 3 of 6 refused by the reader; a build whose store refused 4
 -- of the 8 it saw; a passing build whose last update had 3 of 6 refused by the reader; a build and its
 -- last update both with 3 of 6 refused.
 PERFORM pg_temp.pf_gen(1, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(2, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(8, 0, 4, 4, 4, 5, false));
 PERFORM pg_temp.pf_gen(3, 'shadow', 'luna-ledger:v2', pg_temp.pf_updated(pg_temp.pf_checks(24, 2, 22, 0, 22, 30, true), 6, 3, 3, 0, false));
 PERFORM pg_temp.pf_gen(4, 'shadow', 'luna-ledger:v2', pg_temp.pf_updated(pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false), 6, 3, 3, 0, false));
 -- Still hidden under the half rule: 4 of 7 by the reader; the store 5 of 8; no item kept from
 -- evidence (1 of 2 refused, within half); 6 of 10 in all; a build the half rule passes whose last
 -- update it still fails (4 of 7).
 PERFORM pg_temp.pf_gen(5, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(7, 4, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(6, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(8, 0, 3, 5, 3, 3, false));
 PERFORM pg_temp.pf_gen(7, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(2, 1, 0, 0, 0, 3, false));
 PERFORM pg_temp.pf_gen(8, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(10, 4, 4, 2, 4, 6, false));
 PERFORM pg_temp.pf_gen(9, 'shadow', 'luna-ledger:v2', pg_temp.pf_updated(pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false), 7, 4, 3, 0, false));
 -- Never touched: already passed; a verdict the old line does not explain on its counts (failed
 -- although its counts passed, and passed at build although its counts failed); counts missing; a
 -- passed key that is not a boolean; another reader's; live, retired, failed and building readings;
 -- the owner's direct re-judge of 9 Oct 2026 (passed, store.pass still false), and one of those an
 -- update has failed again since (its counts would pass the half rule; the owner's marker keeps it out).
 PERFORM pg_temp.pf_gen(10, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 1, 4, 0, 4, 4, true));
 PERFORM pg_temp.pf_gen(11, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(5, 1, 4, 0, 4, 4, false));
 PERFORM pg_temp.pf_gen(12, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false)
  || jsonb_build_object('store', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, true) -> 'store'));
 PERFORM pg_temp.pf_gen(13, 'shadow', 'luna-ledger:v2', '{"passed": false, "store": {"pass": false, "proposed": 6, "refused_local": 3}}');
 PERFORM pg_temp.pf_gen(14, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false) || '{"passed": "false"}'::jsonb);
 PERFORM pg_temp.pf_gen(15, 'shadow', 'luna-ledger:v1', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(16, 'live', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(17, 'retired', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(18, 'failed', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(19, 'building', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false));
 PERFORM pg_temp.pf_gen(20, 'shadow', 'luna-ledger:v2', pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false) || pg_temp.pf_owner());
 PERFORM pg_temp.pf_gen(21, 'shadow', 'luna-ledger:v2',
  pg_temp.pf_updated(pg_temp.pf_checks(6, 3, 3, 0, 3, 4, false) || pg_temp.pf_owner(), 2, 0, 2, 0, true));
 PERFORM pg_temp.pf_assert((SELECT NOT public.context_ledger_checks_pass(g.checks) AND g.checks ? 'repassed_by'
   FROM public.context_ledger_generations g WHERE g.id = pg_temp.pf_id('f761a000', 21)),
  'fixture: an update failed the owner''s re-judged reading again');
END $c$;
CREATE TEMP TABLE pf_before AS
 SELECT g.id, g.status, g.checks, g.updated_at FROM public.context_ledger_generations g
 WHERE g.id IN (SELECT pg_temp.pf_id('f761a000', n) FROM generate_series(1, 21) n);
CREATE TEMP TABLE pf_fn AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS cfg
 FROM pg_proc p WHERE p.oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure;
\ir ../../../migrations/20261007160000_context_ledger_pass_floor.sql
DO $c$
DECLARE audit constant jsonb := jsonb_build_object('repassed_by', 'migration 20261007160000: at most half refused (owner ruling 9 Oct 2026)',
  'repassed_at', now());
 flipped constant uuid[] := ARRAY[pg_temp.pf_id('f761a000', 1), pg_temp.pf_id('f761a000', 2), pg_temp.pf_id('f761a000', 3),
  pg_temp.pf_id('f761a000', 4)];
BEGIN
 PERFORM pg_temp.pf_assert((SELECT g.status = 'shadow' AND g.updated_at = now() AND g.checks = b.checks
    || jsonb_build_object('passed', true, 'store', (b.checks -> 'store') || '{"pass": true}'::jsonb) || audit
    || jsonb_build_object('repassed_from', jsonb_build_object('passed', false, 'store_pass', false))
   FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id WHERE g.id = flipped[1]),
  'a reading with 3 of 6 refused by the reader is passed on its stored counts: '
   || (SELECT g.checks::text FROM public.context_ledger_generations g WHERE g.id = flipped[1]));
 PERFORM pg_temp.pf_assert((SELECT g.status = 'shadow' AND g.updated_at = now() AND g.checks = b.checks
    || jsonb_build_object('passed', true, 'store', (b.checks -> 'store') || '{"pass": true}'::jsonb) || audit
    || jsonb_build_object('repassed_from', jsonb_build_object('passed', false, 'store_pass', false))
   FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id WHERE g.id = flipped[2]),
  'a reading whose store refused 4 of 8 is passed: ' || (SELECT g.checks::text FROM public.context_ledger_generations g WHERE g.id = flipped[2]));
 PERFORM pg_temp.pf_assert((SELECT g.status = 'shadow' AND g.updated_at = now() AND g.checks = b.checks
    || jsonb_build_object('passed', true, 'store', (b.checks -> 'store') || '{"pass": true}'::jsonb,
     'last_update', (b.checks -> 'last_update') || '{"pass": true}'::jsonb) || audit
    || jsonb_build_object('repassed_from', jsonb_build_object('passed', false, 'store_pass', true, 'last_update_pass', false))
   FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id WHERE g.id = flipped[3]),
  'a passing build whose last update had 3 of 6 refused is passed: '
   || (SELECT g.checks::text FROM public.context_ledger_generations g WHERE g.id = flipped[3]));
 PERFORM pg_temp.pf_assert((SELECT g.status = 'shadow' AND g.updated_at = now() AND g.checks = b.checks
    || jsonb_build_object('passed', true, 'store', (b.checks -> 'store') || '{"pass": true}'::jsonb,
     'last_update', (b.checks -> 'last_update') || '{"pass": true}'::jsonb) || audit
    || jsonb_build_object('repassed_from', jsonb_build_object('passed', false, 'store_pass', false, 'last_update_pass', false))
   FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id WHERE g.id = flipped[4]),
  'a build and its last update with 3 of 6 refused each get store.pass and last_update.pass: '
   || (SELECT g.checks::text FROM public.context_ledger_generations g WHERE g.id = flipped[4]));
 PERFORM pg_temp.pf_assert((SELECT bool_and(public.context_ledger_checks_pass(g.checks)) FROM public.context_ledger_generations g
   WHERE g.id = ANY(flipped)), 'the one verdict reads the re-judged readings as passed');
 PERFORM pg_temp.pf_assert(NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g JOIN pf_before b ON b.id = g.id
   WHERE NOT (g.id = ANY(flipped)) AND (g.checks IS DISTINCT FROM b.checks OR g.updated_at IS DISTINCT FROM b.updated_at
    OR g.status IS DISTINCT FROM b.status)),
  'only the four the half rule passes were changed: ' || coalesce((SELECT string_agg(g.id::text, ', ') FROM public.context_ledger_generations g
   JOIN pf_before b ON b.id = g.id WHERE NOT (g.id = ANY(flipped)) AND g.checks IS DISTINCT FROM b.checks), ''));
 -- The owner's direct re-judge keeps its own marker and verdicts, store.pass included.
 PERFORM pg_temp.pf_assert((SELECT count(*) FROM public.context_ledger_generations g
   WHERE g.id IN (pg_temp.pf_id('f761a000', 20), pg_temp.pf_id('f761a000', 21))
    AND g.checks ->> 'repassed_by' LIKE 'owner go 9 Oct 2026%' AND g.checks #>> '{store,pass}' = 'false' AND NOT g.checks ? 'repassed_from') = 2,
  'the owner''s re-judged readings are left as they are');
 -- 4. The re-apply changed no body, comment or grant.
 PERFORM pg_temp.pf_assert((SELECT f.m = md5(p.prosrc) AND f.c IS NOT DISTINCT FROM obj_description(p.oid, 'pg_proc')
   AND f.acl IS NOT DISTINCT FROM p.proacl::text AND f.prosecdef = p.prosecdef AND f.cfg IS NOT DISTINCT FROM p.proconfig::text
  FROM pf_fn f, pg_proc p WHERE p.oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure),
  're-applying changed finish''s body, comment or grants');
END $c$;
-- A second apply writes nothing: every reading keeps its row version.
CREATE TEMP TABLE pf_mid AS
 SELECT g.id, g.ctid::text AS row_version, g.checks FROM public.context_ledger_generations g
 WHERE g.id IN (SELECT pg_temp.pf_id('f761a000', n) FROM generate_series(1, 21) n);
\ir ../../../migrations/20261007160000_context_ledger_pass_floor.sql
DO $c$ BEGIN
 PERFORM pg_temp.pf_assert((SELECT count(*) FROM pf_mid) = 21 AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g
   JOIN pf_mid m ON m.id = g.id WHERE g.ctid::text <> m.row_version OR g.checks IS DISTINCT FROM m.checks),
  'a second apply wrote a reading');
END $c$;
ROLLBACK;

-- 5. Last, so a behaviour break above is reported by its behaviour: finish is this migration's body.
DO $c$ BEGIN
 PERFORM pg_temp.pf_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure)
  = '110174bcd355a82568fd7bc572d414f6', 'context_ledger_finish is not this migration''s body');
END $c$;
