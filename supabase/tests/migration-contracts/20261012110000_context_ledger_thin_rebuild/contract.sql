-- Contract: 20261012110000_context_ledger_thin_rebuild, the thin rebuild guard: a whole re-read that
-- would replace a job's live notes with far fewer of them is held for one more read. Every fixture
-- write is rolled back. Ids, job numbers and counts are synthetic. Each reading states its counts
-- exactly (its items written straight in, one receipt for what the store accepted, the reader's own
-- count in p_meta.checks), so no fixture depends on the item check's rules. Every job and live reading
-- is dated at a fixed instant; a verdict reads no clock but its own run's.
--
--  1. Shape: the three numbers (10, half, 1); finish keeps its signature, definer and path, grants
--     (service role only) and the store's and the pass rule's comment markers first, now naming this
--     slice; the one verdict reader is untouched; nothing is switched on.
--  2. The four named cases, in live mode: a 37 to 6 rebuild stays a shadow with the reason
--     thin_rebuild, the 37 stay live and the job backs off for one more read; 37 to 33 goes live; a
--     first-ever read (no live reading) goes live; an update of a live reading is untouched.
--  3. The edges: exactly half is not thin and one under is; a live reading under 10 notes is never
--     guarded; the count is taken after a person's settled notes are carried across; a rebuild that
--     fails its own checks is not weighed.
--  4. Held means held everywhere: the go-live sweep skips it, the judge still asks for the rebuild,
--     and the job's backoff runs from the held read.
--  5. The second read: not thin goes live and the held one stays; thin again and fuller or equal
--     goes live as confirmed; thin again and thinner puts the held one live and stays a shadow.
--     Nothing is deleted in any of them.
--  6. Outside live mode a thin rebuild beside a live reading is still held, and the second one is
--     confirmed and waits for the sweep.
--  7. Re-applying the migration changes no body, comment or grant.
--  8. Last, so a behaviour break above is reported by its behaviour: the body is this migration's.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.tr_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'thin rebuild contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.tr_id(p_prefix text, p_n integer) RETURNS uuid LANGUAGE sql AS $$
 SELECT (p_prefix || '-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- A job created at a fixed instant.
CREATE FUNCTION pg_temp.tr_job(p_n integer) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := pg_temp.tr_id('f7800000', p_n);
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (v, '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'SWF-978' || lpad(p_n::text, 2, '0'), 'Pat Example', NULL,
  'tr-' || p_n, 'Testville', '{}', '2026-09-01 00:00Z');
 RETURN v;
END $$;
-- p_n notes on a reading, keyed by p_tag so a rebuild's never collide with the live reading's;
-- p_locked of them settled by a person (the carry-forward copies those into a rebuild).
CREATE FUNCTION pg_temp.tr_items(p_gen uuid, p_job uuid, p_tag text, p_n integer, p_locked integer DEFAULT 0) RETURNS void
LANGUAGE sql AS $$
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by,
  written_by, person_locked)
 SELECT p_gen, p_job, 'request:none:' || p_tag || lpad(k::text, 11, '0'), 'request', 'open', 'customer', 'Fixture note ' || p_tag || k,
  '2026-09-02 00:00Z', jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', pg_temp.tr_id('f780e000', k)::text, 'excerpt', 'x')),
  CASE WHEN k <= p_locked THEN 'person:' || pg_temp.tr_id('f780aaaa', 1)::text ELSE 'model:luna-ledger:v2' END, k <= p_locked
 FROM generate_series(1, p_n) k $$;
-- A job with a live reading of p_n notes, built and promoted at fixed instants.
CREATE FUNCTION pg_temp.tr_live(p_job_n integer, p_n integer, p_locked integer DEFAULT 0) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE j uuid := pg_temp.tr_job(p_job_n); g uuid := pg_temp.tr_id('f781a000', p_job_n);
BEGIN
 INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, evidence_until, promoted_at, created_at, finished_at,
  updated_at, checks)
 VALUES (g, j, 'backfill', 'live', 'luna-ledger:v2', '2026-09-02 00:00Z', '2026-09-03 00:00Z', '2026-09-02 00:00Z', '2026-09-02 01:00Z',
  '2026-09-03 00:00Z', '{"passed": true, "store": {"pass": true}}');
 PERFORM pg_temp.tr_items(g, j, 'L', p_n, p_locked);
 RETURN j;
END $$;
-- A running ledger run holding its lease (started an hour ago, so the reading's evidence_until stands).
CREATE FUNCTION pg_temp.tr_run(p_job uuid, p_token uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid; d date := (now() AT TIME ZONE 'Australia/Perth')::date;
BEGIN
 INSERT INTO public.context_extraction_runs (job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at)
 VALUES (p_job, d, 'ledger', 'running', p_token, now() + interval '30 minutes',
  (SELECT coalesce(max(r.run_seq), 0) + 1 FROM public.context_extraction_runs r WHERE r.job_id = p_job AND r.run_date = d AND r.phase = 'ledger'),
  now() - interval '1 hour')
 RETURNING id INTO v;
 RETURN v;
END $$;
CREATE FUNCTION pg_temp.tr_receipt(p_run uuid, p_gen uuid, p_job uuid, p_accepted integer, p_refused integer) RETURNS void
LANGUAGE sql AS $$
 INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused, result)
 VALUES (p_run, p_gen, p_job, encode(sha256(convert_to(p_run::text, 'UTF8')), 'hex'), p_accepted, p_refused, '{"refused": []}') $$;
CREATE FUNCTION pg_temp.tr_meta(p_proposed integer, p_local integer, p_rows integer) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('model', 'tr-model', 'evidence_until', now() - interval '2 hours', 'evidence_rows', p_rows, 'chunks', 1,
  'calls', 1, 'tokens_in', 100, 'checks', jsonb_build_object('proposed', p_proposed, 'refused_local', p_local)) $$;
-- One finished whole read of a job: a building generation of p_kind with p_n notes of its own, the
-- store's receipt, then finish. p_local of the reader's own refusals on top (0: a clean read).
-- Returns finish's answer with the generation and run.
CREATE FUNCTION pg_temp.tr_build(p_job uuid, p_kind text, p_tag text, p_n integer, p_local integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE run uuid; gen uuid; tok uuid := gen_random_uuid();
BEGIN
 run := pg_temp.tr_run(p_job, tok);
 -- each reading newer than the last, as the clock makes them (a transaction's now() stands still)
 INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, run_id, created_at)
 VALUES (p_job, p_kind, 'building', 'luna-ledger:v2', run, clock_timestamp()) RETURNING id INTO gen;
 PERFORM pg_temp.tr_items(gen, p_job, p_tag, p_n);
 PERFORM pg_temp.tr_receipt(run, gen, p_job, p_n, 0);
 RETURN public.context_ledger_finish(run, tok, gen, 'built', pg_temp.tr_meta(p_n + p_local, p_local, 40))
  || jsonb_build_object('generation_id', gen, 'run_id', run);
END $$;
-- A reading's stored state in one row.
CREATE FUNCTION pg_temp.tr_gen(p_gen uuid) RETURNS TABLE(status text, passed boolean, store_pass text, thin jsonb, items bigint,
 promoted_by text) LANGUAGE sql AS $$
 SELECT g.status, public.context_ledger_checks_pass(g.checks), g.checks #>> '{store,pass}', g.checks -> 'thin_rebuild',
  (SELECT count(*) FROM public.context_ledger_items i WHERE i.generation_id = g.id), g.checks ->> 'promoted_by'
 FROM public.context_ledger_generations g WHERE g.id = p_gen $$;
CREATE FUNCTION pg_temp.tr_live_gen(p_job_n integer) RETURNS uuid LANGUAGE sql AS $$ SELECT pg_temp.tr_id('f781a000', p_job_n) $$;

-- 1. Shape.
DO $c$
DECLARE f constant text := 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)';
 pol constant text := 'public.context_ledger_thin_rebuild_policy()'; p record;
BEGIN
 PERFORM pg_temp.tr_assert(public.context_ledger_thin_rebuild_policy() = '{"min_live_items": 10, "min_share": 0.5, "max_holds": 1}'::jsonb,
  'the numbers: ' || public.context_ledger_thin_rebuild_policy()::text);
 PERFORM pg_temp.tr_assert(obj_description(pol::regprocedure, 'pg_proc') LIKE 'Thin rebuild guard (20261012110000): %',
  'the policy''s comment marker');
 PERFORM pg_temp.tr_assert(has_function_privilege('service_role', pol, 'EXECUTE') AND NOT has_function_privilege('anon', pol, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', pol, 'EXECUTE'), 'the policy is service role only');
 PERFORM pg_temp.tr_assert((SELECT pp.prosecdef AND pp.proconfig = ARRAY['search_path=public, pg_temp'] FROM pg_proc pp WHERE pp.oid = to_regprocedure(pol)),
  'the policy must be definer with search_path public, pg_temp, like every store function');
 SELECT pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c INTO p FROM pg_proc pp WHERE pp.oid = to_regprocedure(f);
 PERFORM pg_temp.tr_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'], 'finish must stay definer with search_path public, pg_temp');
 PERFORM pg_temp.tr_assert(has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', f, 'EXECUTE'), 'finish grants changed');
 PERFORM pg_temp.tr_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid IN (to_regprocedure(f), to_regprocedure(pol)) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), 'executable by PUBLIC');
 PERFORM pg_temp.tr_assert(p.c LIKE 'Context ledger store (20261006013000), ledger pass rule (20261007160000): closes a ledger run. (Thin rebuild guard, 20261012110000) %'
  AND p.c LIKE '%is held, not promoted%' AND p.c LIKE '%the fuller of it and the fullest held one goes live%'
  AND p.c LIKE '%The verdict, at most half refused (owner ruling 9 Oct 2026), counts both sides%', 'finish comment: ' || coalesce(p.c, '<none>'));
 -- The one verdict reader is untouched: it reads checks.passed and nothing else.
 PERFORM pg_temp.tr_assert(obj_description('public.context_ledger_checks_pass(jsonb)'::regprocedure, 'pg_proc') LIKE 'Context ledger store (20261006013000): %'
  AND NOT public.context_ledger_checks_pass('{"passed": false, "store": {"pass": true}, "thin_rebuild": {"state": "held"}}'),
  'context_ledger_checks_pass changed');
 -- Nothing switched on: the ledger stays off with no calls.
 PERFORM pg_temp.tr_assert((SELECT mode = 'off' AND calls_per_day = 0 FROM public.context_ledger_settings), 'ledger settings changed');
END $c$;

-- 2. The four named cases, 3. the edges and 4. held means held everywhere.
BEGIN;
DO $c$
DECLARE fin jsonb; j uuid; lv uuid; g record; l record; f record; d record; sw jsonb;
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live', reader = 'luna-ledger:v2';

 -- 37 to 6: the rebuild passes its own checks and is held. It stays a shadow with the reason, the 37
 -- stay live, and the run ends as a build that did not pass.
 j := pg_temp.tr_live(1, 37); lv := pg_temp.tr_live_gen(1);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 6);
 SELECT * INTO g FROM pg_temp.tr_gen((fin ->> 'generation_id')::uuid);
 SELECT * INTO l FROM pg_temp.tr_gen(lv);
 PERFORM pg_temp.tr_assert(fin ->> 'outcome' = 'built' AND fin ->> 'generation_status' = 'shadow' AND NOT (fin ->> 'promoted')::boolean
  AND NOT (fin ->> 'passed')::boolean AND fin #>> '{thin_rebuild,reason}' = 'thin_rebuild' AND fin #>> '{thin_rebuild,state}' = 'held'
  AND (fin #>> '{checks,pass}')::boolean AND NOT fin ? 'promoted_generation_id',
  'a 37 to 6 rebuild is held, not promoted: ' || fin::text);
 PERFORM pg_temp.tr_assert(g.status = 'shadow' AND NOT g.passed AND g.store_pass = 'true' AND g.items = 6 AND g.promoted_by IS NULL
  AND g.thin = jsonb_build_object('state', 'held', 'reason', 'thin_rebuild', 'items', 6, 'live_items', 37, 'live_generation_id', lv,
   'min_share', 0.5, 'min_live_items', 10, 'max_holds', 1, 'held_before', 0, 'at', now()),
  'the held reading stays a shadow with its 6 notes and the reason: ' || coalesce(g.thin::text, '<none>'));
 PERFORM pg_temp.tr_assert(l.status = 'live' AND l.items = 37 AND l.passed AND l.thin IS NULL
  AND (SELECT count(*) FROM public.context_ledger_generations x WHERE x.job_id = j AND x.status = 'live') = 1
  AND (SELECT x.retired_at IS NULL AND x.updated_at = '2026-09-03 00:00Z' FROM public.context_ledger_generations x WHERE x.id = lv),
  'the 37-note reading stays live and untouched');
 PERFORM pg_temp.tr_assert((SELECT r.status = 'done' AND r.error = 'checks_failed' FROM public.context_extraction_runs r
   WHERE r.id = (fin ->> 'run_id')::uuid), 'the held read''s run ends checks_failed');
 -- 4. Due for one more read later, by the store's own rules. The backoff runs from the held read.
 SELECT * INTO f FROM public.context_ledger_failures(ARRAY[j]);
 PERFORM pg_temp.tr_assert(f.failures = 1 AND f.backoff_until = now() + interval '2 hours' AND f.failed_builds = 1 AND NOT f.needs_person,
  'the job backs off 2 hours from the held read: ' || to_jsonb(f)::text);
 -- The go-live sweep never takes it.
 sw := public.context_ledger_promote_shadow('rule:contract', ARRAY[j]);
 PERFORM pg_temp.tr_assert((sw ->> 'promoted')::integer = 0 AND sw #>> '{skipped_generations,0,reason}' = 'checks_failed'
  AND (SELECT x.status = 'shadow' FROM public.context_ledger_generations x WHERE x.id = (fin ->> 'generation_id')::uuid)
  AND (SELECT x.status = 'live' FROM public.context_ledger_generations x WHERE x.id = lv),
  'the go-live sweep skips a held reading: ' || sw::text);
 -- The judge: with the reader changed, the live reading's rebuild is still asked for (a held reading
 -- answers nothing; the fixture's notes cite rows that do not exist, so the judge names the moved
 -- citation first), and a passing one of the same size would have answered it.
 UPDATE public.context_ledger_settings SET reader = 'luna-ledger:v3';
 UPDATE public.context_ledger_generations SET reader = 'luna-ledger:v3' WHERE id = (fin ->> 'generation_id')::uuid;
 SELECT * INTO d FROM public.context_ledger_judge(ARRAY[j]);
 PERFORM pg_temp.tr_assert(d.kind = 'rebuild' AND d.reason IN ('citation_moved', 'reader_changed') AND d.generation_id = lv,
  'the judge still asks for the live reading''s rebuild beside a held one: ' || to_jsonb(d)::text);
 UPDATE public.context_ledger_generations SET checks = checks || '{"passed": true}' WHERE id = (fin ->> 'generation_id')::uuid;
 SELECT * INTO d FROM public.context_ledger_judge(ARRAY[j]);
 PERFORM pg_temp.tr_assert(d.reason IS NULL AND d.kind IS NULL,
  'fixture: a passing shadow of the same size would have answered the rebuild: ' || to_jsonb(d)::text);
 UPDATE public.context_ledger_settings SET reader = 'luna-ledger:v2';

 -- 37 to 33: not thin, it goes live as any passing rebuild; the 37 are retired, never deleted.
 j := pg_temp.tr_live(2, 37); lv := pg_temp.tr_live_gen(2);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 33);
 SELECT * INTO g FROM pg_temp.tr_gen((fin ->> 'generation_id')::uuid);
 SELECT * INTO l FROM pg_temp.tr_gen(lv);
 PERFORM pg_temp.tr_assert(fin ->> 'generation_status' = 'live' AND (fin ->> 'promoted')::boolean AND (fin ->> 'passed')::boolean
  AND NOT fin ? 'thin_rebuild' AND g.status = 'live' AND g.passed AND g.thin IS NULL AND g.items = 33 AND g.promoted_by = 'rule:auto'
  AND l.status = 'retired' AND l.items = 37
  AND (SELECT r.error IS NULL FROM public.context_extraction_runs r WHERE r.id = (fin ->> 'run_id')::uuid),
  'a 37 to 33 rebuild goes live: ' || fin::text);

 -- A first-ever read has no live reading to weigh against: 6 notes go live.
 j := pg_temp.tr_job(3);
 fin := pg_temp.tr_build(j, 'backfill', 'B', 6);
 SELECT * INTO g FROM pg_temp.tr_gen((fin ->> 'generation_id')::uuid);
 PERFORM pg_temp.tr_assert(fin ->> 'generation_status' = 'live' AND (fin ->> 'promoted')::boolean AND NOT fin ? 'thin_rebuild'
  AND g.status = 'live' AND g.thin IS NULL AND g.items = 6, 'a first-ever read goes live: ' || fin::text);

 -- An update of a live reading is untouched: it adds to the 37, its answer and the reading's checks
 -- carry no thin_rebuild, and the reading stays live.
 j := pg_temp.tr_live(4, 37); lv := pg_temp.tr_live_gen(4);
 DECLARE run uuid; tok uuid := gen_random_uuid();
 BEGIN
  run := pg_temp.tr_run(j, tok);
  PERFORM pg_temp.tr_items(lv, j, 'U', 1);
  PERFORM pg_temp.tr_receipt(run, lv, j, 1, 0);
  fin := public.context_ledger_finish(run, tok, lv, 'updated', pg_temp.tr_meta(1, 0, 2));
  SELECT * INTO l FROM pg_temp.tr_gen(lv);
  PERFORM pg_temp.tr_assert(fin ->> 'outcome' = 'updated' AND fin ->> 'generation_status' = 'live' AND (fin ->> 'passed')::boolean
   AND NOT fin ? 'thin_rebuild' AND l.status = 'live' AND l.passed AND l.thin IS NULL AND l.items = 38
   AND (SELECT r.status = 'done' AND r.error IS NULL FROM public.context_extraction_runs r WHERE r.id = run),
   'an update of a live reading is untouched: ' || fin::text);
 END;

 -- 3. The edges. Exactly half is not thin; one under is.
 j := pg_temp.tr_live(5, 20);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 10);
 PERFORM pg_temp.tr_assert((fin ->> 'promoted')::boolean AND NOT fin ? 'thin_rebuild', 'a 20 to 10 rebuild (exactly half) goes live: ' || fin::text);
 j := pg_temp.tr_live(6, 20);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 9);
 PERFORM pg_temp.tr_assert(NOT (fin ->> 'promoted')::boolean AND fin #>> '{thin_rebuild,state}' = 'held', 'a 20 to 9 rebuild is held: ' || fin::text);
 -- A live reading under 10 notes is never guarded; one of exactly 10 is.
 j := pg_temp.tr_live(7, 9);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 1);
 PERFORM pg_temp.tr_assert((fin ->> 'promoted')::boolean AND NOT fin ? 'thin_rebuild', 'a 9 to 1 rebuild goes live (live reading under 10): ' || fin::text);
 j := pg_temp.tr_live(8, 10);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 4);
 PERFORM pg_temp.tr_assert(NOT (fin ->> 'promoted')::boolean AND fin #>> '{thin_rebuild,state}' = 'held', 'a 10 to 4 rebuild is held: ' || fin::text);
 -- Counted as it would go live: 4 of the live reading's 12 notes were settled by a person and are
 -- carried into the rebuild, so its own 2 notes make 6, exactly half, and it goes live. Without
 -- them 2 of 12 would be thin.
 j := pg_temp.tr_live(9, 12, 4);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 2);
 SELECT * INTO g FROM pg_temp.tr_gen((fin ->> 'generation_id')::uuid);
 PERFORM pg_temp.tr_assert((fin ->> 'promoted')::boolean AND (fin ->> 'carried')::integer = 4 AND g.status = 'live' AND g.items = 6
  AND NOT fin ? 'thin_rebuild', 'a person''s settled notes carried across are counted: ' || fin::text);
 -- A rebuild that fails its own checks (4 of 7 refused by the reader) is not weighed: it is a failed
 -- shadow as before, with no thin_rebuild.
 j := pg_temp.tr_live(10, 37);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 3, 4);
 SELECT * INTO g FROM pg_temp.tr_gen((fin ->> 'generation_id')::uuid);
 PERFORM pg_temp.tr_assert(NOT (fin ->> 'passed')::boolean AND NOT (fin ->> 'promoted')::boolean AND NOT fin ? 'thin_rebuild'
  AND g.status = 'shadow' AND g.store_pass = 'false' AND g.thin IS NULL,
  'a rebuild that fails its own checks is not weighed: ' || fin::text);
END $c$;
ROLLBACK;

-- 5. The second read.
BEGIN;
DO $c$
DECLARE one jsonb; two jsonb; j uuid; lv uuid; a record; b record; l record; f record;
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live', reader = 'luna-ledger:v2';

 -- Held at 6, then a read of 33: not thin, it goes live as any passing rebuild. The held reading
 -- stays a shadow the sweep never takes (it fails the one verdict and is older than the live one).
 j := pg_temp.tr_live(21, 37); lv := pg_temp.tr_live_gen(21);
 one := pg_temp.tr_build(j, 'rebuild', 'R', 6);
 two := pg_temp.tr_build(j, 'rebuild', 'S', 33);
 SELECT * INTO a FROM pg_temp.tr_gen((one ->> 'generation_id')::uuid);
 SELECT * INTO b FROM pg_temp.tr_gen((two ->> 'generation_id')::uuid);
 SELECT * INTO l FROM pg_temp.tr_gen(lv);
 PERFORM pg_temp.tr_assert((two ->> 'promoted')::boolean AND NOT two ? 'thin_rebuild' AND b.status = 'live' AND b.items = 33
  AND a.status = 'shadow' AND NOT a.passed AND a.thin ->> 'state' = 'held' AND a.items = 6 AND l.status = 'retired' AND l.items = 37
  AND (public.context_ledger_promote_shadow('rule:contract', ARRAY[j]) ->> 'promoted')::integer = 0,
  'held at 6, then 33: the 33 go live and the held reading stays: ' || two::text);

 -- Held at 6, then a read of 16: thin again and fuller. Two reads agree the reading is short, the
 -- fuller goes live as confirmed, and its run is clean.
 j := pg_temp.tr_live(22, 37); lv := pg_temp.tr_live_gen(22);
 one := pg_temp.tr_build(j, 'rebuild', 'R', 6);
 two := pg_temp.tr_build(j, 'rebuild', 'S', 16);
 SELECT * INTO a FROM pg_temp.tr_gen((one ->> 'generation_id')::uuid);
 SELECT * INTO b FROM pg_temp.tr_gen((two ->> 'generation_id')::uuid);
 SELECT * INTO l FROM pg_temp.tr_gen(lv);
 PERFORM pg_temp.tr_assert((two ->> 'promoted')::boolean AND (two ->> 'passed')::boolean AND two ->> 'generation_status' = 'live'
  AND two #>> '{thin_rebuild,state}' = 'confirmed' AND two #>> '{thin_rebuild,reason}' = 'thin_rebuild_confirmed'
  AND two #>> '{thin_rebuild,held_generation_id}' = one ->> 'generation_id' AND two #>> '{thin_rebuild,held_items}' = '6'
  AND two #>> '{thin_rebuild,held_before}' = '1' AND NOT two ? 'promoted_generation_id'
  AND b.status = 'live' AND b.passed AND b.items = 16 AND b.promoted_by = 'rule:auto' AND b.thin ->> 'state' = 'confirmed'
  AND a.status = 'shadow' AND NOT a.passed AND a.items = 6 AND l.status = 'retired' AND l.items = 37
  AND (SELECT r.error IS NULL FROM public.context_extraction_runs r WHERE r.id = (two ->> 'run_id')::uuid),
  'held at 6, then 16: the 16 go live as confirmed: ' || two::text);
 -- An equal second read goes to the newer.
 j := pg_temp.tr_live(23, 37);
 one := pg_temp.tr_build(j, 'rebuild', 'R', 6);
 two := pg_temp.tr_build(j, 'rebuild', 'S', 6);
 PERFORM pg_temp.tr_assert((two ->> 'promoted')::boolean AND two #>> '{thin_rebuild,state}' = 'confirmed',
  'held at 6, then 6 again: the newer goes live: ' || two::text);

 -- Held at 16, then a read of 6: thin again and thinner. The held 16 go live; the 6 stay a shadow,
 -- passed over, and the run that settled it is clean. Every reading keeps every note.
 j := pg_temp.tr_live(24, 37); lv := pg_temp.tr_live_gen(24);
 one := pg_temp.tr_build(j, 'rebuild', 'R', 16);
 two := pg_temp.tr_build(j, 'rebuild', 'S', 6);
 SELECT * INTO a FROM pg_temp.tr_gen((one ->> 'generation_id')::uuid);
 SELECT * INTO b FROM pg_temp.tr_gen((two ->> 'generation_id')::uuid);
 SELECT * INTO l FROM pg_temp.tr_gen(lv);
 PERFORM pg_temp.tr_assert(NOT (two ->> 'promoted')::boolean AND NOT (two ->> 'passed')::boolean AND two ->> 'generation_status' = 'shadow'
  AND two #>> '{thin_rebuild,state}' = 'passed_over' AND two #>> '{thin_rebuild,reason}' = 'thin_rebuild_fuller_held'
  AND two ->> 'promoted_generation_id' = one ->> 'generation_id',
  'held at 16, then 6: the answer names the held reading that went live: ' || two::text);
 PERFORM pg_temp.tr_assert(a.status = 'live' AND a.passed AND a.items = 16 AND a.promoted_by = 'rule:thin_rebuild'
  AND a.thin ->> 'state' = 'confirmed' AND a.thin ->> 'confirmed_by' = two ->> 'generation_id' AND a.thin ->> 'confirmed_items' = '6'
  AND b.status = 'shadow' AND NOT b.passed AND b.store_pass = 'true' AND b.items = 6 AND b.thin ->> 'state' = 'passed_over'
  AND l.status = 'retired' AND l.items = 37
  AND (SELECT count(*) FROM public.context_ledger_generations x WHERE x.job_id = j AND x.status = 'live') = 1
  AND (SELECT r.error IS NULL FROM public.context_extraction_runs r WHERE r.id = (two ->> 'run_id')::uuid),
  'held at 16, then 6: the held 16 go live and the 6 stay a shadow: ' || coalesce(a.thin::text, '<none>') || ' ' || coalesce(b.thin::text, '<none>'));
 -- The passed-over reading is never taken by the sweep, and the job's failures are settled: its
 -- newest run is clean.
 SELECT * INTO f FROM public.context_ledger_failures(ARRAY[j]);
 PERFORM pg_temp.tr_assert((public.context_ledger_promote_shadow('rule:contract', ARRAY[j]) ->> 'promoted')::integer = 0
  AND NOT f.needs_person, 'the passed-over reading stays a shadow: ' || to_jsonb(f)::text);

 -- A hold belongs to the live reading it was weighed against: a held reading from before an
 -- earlier promotion is not counted against the next live reading.
 j := pg_temp.tr_live(25, 37);
 one := pg_temp.tr_build(j, 'rebuild', 'R', 6);    -- held against the 37
 two := pg_temp.tr_build(j, 'rebuild', 'S', 33);   -- goes live
 one := pg_temp.tr_build(j, 'rebuild', 'T', 7);    -- thin against the 33: the first hold against them
 PERFORM pg_temp.tr_assert(NOT (one ->> 'promoted')::boolean AND one #>> '{thin_rebuild,state}' = 'held'
  AND one #>> '{thin_rebuild,held_before}' = '0' AND one #>> '{thin_rebuild,live_items}' = '33'
  AND one #>> '{thin_rebuild,live_generation_id}' = two ->> 'generation_id',
  'a hold counts only against the live reading it was weighed against: ' || one::text);
END $c$;
ROLLBACK;

-- 6. Outside live mode nothing is promoted, and a thin rebuild beside a live reading is still held, so
-- the sweep cannot take it once the ledger goes live. The second thin one is confirmed (the newer,
-- the only one the sweep takes) and waits for the sweep.
BEGIN;
DO $c$
DECLARE one jsonb; two jsonb; j uuid; lv uuid; a record; b record; sw jsonb;
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'shadow', reader = 'luna-ledger:v2';
 j := pg_temp.tr_live(31, 37); lv := pg_temp.tr_live_gen(31);
 one := pg_temp.tr_build(j, 'rebuild', 'R', 16);
 SELECT * INTO a FROM pg_temp.tr_gen((one ->> 'generation_id')::uuid);
 PERFORM pg_temp.tr_assert(NOT (one ->> 'promoted')::boolean AND one #>> '{thin_rebuild,state}' = 'held' AND a.status = 'shadow' AND NOT a.passed,
  'in shadow mode a 37 to 16 rebuild is held: ' || one::text);
 UPDATE public.context_ledger_settings SET mode = 'live';
 sw := public.context_ledger_promote_shadow('rule:contract', ARRAY[j]);
 PERFORM pg_temp.tr_assert((sw ->> 'promoted')::integer = 0 AND (SELECT x.status = 'live' FROM public.context_ledger_generations x WHERE x.id = lv),
  'the go-live sweep leaves a reading held in shadow mode: ' || sw::text);
 UPDATE public.context_ledger_settings SET mode = 'shadow';
 two := pg_temp.tr_build(j, 'rebuild', 'S', 6);
 SELECT * INTO a FROM pg_temp.tr_gen((one ->> 'generation_id')::uuid);
 SELECT * INTO b FROM pg_temp.tr_gen((two ->> 'generation_id')::uuid);
 PERFORM pg_temp.tr_assert(NOT (two ->> 'promoted')::boolean AND (two ->> 'passed')::boolean AND two #>> '{thin_rebuild,state}' = 'confirmed'
  AND NOT two ? 'promoted_generation_id' AND b.status = 'shadow' AND b.passed AND a.status = 'shadow' AND NOT a.passed
  AND (SELECT x.status = 'live' FROM public.context_ledger_generations x WHERE x.id = lv),
  'in shadow mode the second thin read is confirmed and nothing is promoted: ' || two::text);
END $c$;
ROLLBACK;

-- 7. Re-applying the migration changes no body, comment or grant.
BEGIN;
CREATE TEMP TABLE tr_fn AS
 SELECT p.oid, md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl, p.prosecdef, p.proconfig::text AS cfg
 FROM pg_proc p WHERE p.oid IN ('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure,
  'public.context_ledger_thin_rebuild_policy()'::regprocedure);
\ir ../../../migrations/20261012110000_context_ledger_thin_rebuild.sql
DO $c$ BEGIN
 PERFORM pg_temp.tr_assert((SELECT count(*) = 2 AND bool_and(f.m = md5(p.prosrc) AND f.c IS NOT DISTINCT FROM obj_description(p.oid, 'pg_proc')
   AND f.acl IS NOT DISTINCT FROM p.proacl::text AND f.prosecdef = p.prosecdef AND f.cfg IS NOT DISTINCT FROM p.proconfig::text)
  FROM tr_fn f JOIN pg_proc p ON p.oid = f.oid), 're-applying changed a body, comment or grant');
END $c$;
ROLLBACK;

-- 8. Last, so a behaviour break above is reported by its behaviour: finish is this migration's body.
DO $c$ BEGIN
 PERFORM pg_temp.tr_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure)
  = '1695e52f99f56534a24166f6662ced35', 'context_ledger_finish is not this migration''s body');
END $c$;
