-- Rollback contract: 20261012110000_context_ledger_thin_rebuild_down.sql has just run over the forward
-- stack. Every fixture write is rolled back.
--  1. finish is the 20261007160000 body and comment again, its grants as they were; the policy is gone.
--  2. The old behaviour is back: a 37 to 6 rebuild replaces the live reading.
--  3. The migration re-applies over its rollback; a reading it then holds is left exactly as stored by
--     a second rollback (no row is touched), the live reading stays live, and the job's next rebuild
--     goes live by the rules as they were.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.tr_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'thin rebuild rollback contract: %', p_msg; END IF; END $$;
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

-- 1. The body, comment and grants as 20261007160000 left them; the policy dropped.
DO $c$
DECLARE f constant text := 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'; p record;
BEGIN
 SELECT md5(pp.prosrc) AS m, pp.prosecdef, pp.proconfig, obj_description(pp.oid, 'pg_proc') AS c INTO p FROM pg_proc pp WHERE pp.oid = to_regprocedure(f);
 PERFORM pg_temp.tr_assert(p.m = '110174bcd355a82568fd7bc572d414f6', 'finish is not the 20261007160000 body: ' || coalesce(p.m, '<missing>'));
 PERFORM pg_temp.tr_assert(p.c LIKE 'Context ledger store (20261006013000), ledger pass rule (20261007160000): closes a ledger run. evidence_until is capped%'
  AND p.c NOT LIKE '%Thin rebuild guard%', 'finish comment: ' || coalesce(p.c, '<none>'));
 PERFORM pg_temp.tr_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND has_function_privilege('service_role', f, 'EXECUTE')
  AND NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'), 'finish attributes or grants changed');
 PERFORM pg_temp.tr_assert(to_regprocedure('public.context_ledger_thin_rebuild_policy()') IS NULL, 'the policy function is still there');
END $c$;

-- 2. The old behaviour: a 37 to 6 rebuild goes live.
BEGIN;
DO $c$
DECLARE fin jsonb; j uuid;
BEGIN
 UPDATE public.context_ledger_settings SET mode = 'live', reader = 'luna-ledger:v2';
 j := pg_temp.tr_live(1, 37);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 6);
 PERFORM pg_temp.tr_assert((fin ->> 'promoted')::boolean AND fin ->> 'generation_status' = 'live' AND NOT fin ? 'thin_rebuild'
  AND (SELECT x.status = 'retired' FROM public.context_ledger_generations x WHERE x.id = pg_temp.tr_live_gen(1)),
  'after the rollback a 37 to 6 rebuild goes live as before: ' || fin::text);
END $c$;
ROLLBACK;

-- 3. The migration re-applies over its rollback, holds a reading, and a second rollback touches no row.
BEGIN;
\ir ../../../migrations/20261012110000_context_ledger_thin_rebuild.sql
DO $c$
DECLARE fin jsonb; j uuid;
BEGIN
 PERFORM pg_temp.tr_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure)
  = '1695e52f99f56534a24166f6662ced35' AND to_regprocedure('public.context_ledger_thin_rebuild_policy()') IS NOT NULL, 'the migration re-applies over its rollback');
 UPDATE public.context_ledger_settings SET mode = 'live', reader = 'luna-ledger:v2';
 j := pg_temp.tr_live(2, 37);
 fin := pg_temp.tr_build(j, 'rebuild', 'R', 6);
 PERFORM pg_temp.tr_assert(fin #>> '{thin_rebuild,state}' = 'held', 'fixture: the re-applied guard holds a 37 to 6 rebuild: ' || fin::text);
 CREATE TEMP TABLE tr_rows ON COMMIT DROP AS
  SELECT g.id, g.ctid::text AS row_version, g.status, g.checks, (fin ->> 'generation_id')::uuid AS held
  FROM public.context_ledger_generations g WHERE g.job_id = j;
 CREATE TEMP TABLE tr_notes ON COMMIT DROP AS SELECT count(*) AS n FROM public.context_ledger_items i WHERE i.job_id = j;
END $c$;
\ir ../../../rollbacks/20261012110000_context_ledger_thin_rebuild_down.sql
DO $c$
DECLARE fin jsonb; j uuid := pg_temp.tr_id('f7800000', 2);
BEGIN
 PERFORM pg_temp.tr_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure)
  = '110174bcd355a82568fd7bc572d414f6', 'the second rollback restores the 20261007160000 body');
 PERFORM pg_temp.tr_assert((SELECT count(*) FROM tr_rows) = 2 AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations g
   JOIN tr_rows b ON b.id = g.id WHERE g.ctid::text <> b.row_version OR g.status <> b.status OR g.checks IS DISTINCT FROM b.checks)
  AND (SELECT count(*) FROM public.context_ledger_items i WHERE i.job_id = j) = (SELECT n FROM tr_notes),
  'the rollback touched a reading or a note');
 PERFORM pg_temp.tr_assert((SELECT g.status = 'shadow' AND NOT public.context_ledger_checks_pass(g.checks) AND g.checks #>> '{thin_rebuild,state}' = 'held'
   FROM public.context_ledger_generations g WHERE g.id = (SELECT held FROM tr_rows LIMIT 1))
  AND (SELECT g.status = 'live' FROM public.context_ledger_generations g WHERE g.id = pg_temp.tr_live_gen(2)),
  'the held reading stays a failed shadow and the live reading stays live');
 -- The job's next rebuild goes live by the rules as they were.
 fin := pg_temp.tr_build(j, 'rebuild', 'S', 6);
 PERFORM pg_temp.tr_assert((fin ->> 'promoted')::boolean AND NOT fin ? 'thin_rebuild', 'the next rebuild goes live after the rollback: ' || fin::text);
END $c$;
ROLLBACK;
