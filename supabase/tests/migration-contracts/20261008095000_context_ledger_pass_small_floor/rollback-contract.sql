-- Rollback contract: 20261008095000_context_ledger_pass_small_floor. The runner applied the stack
-- through this migration and then its down. context_ledger_finish and its comment are 20261006013000's
-- word for word (the live md5s), its grants and attributes stand, and the earlier verdict is back: a
-- 5-item reading with 2 of the reader's own refusals fails whole again, 1 in 5 still passes. The down
-- runs again cleanly, and the migration re-applies on top of its own rollback. Every fixture instant is
-- fixed and every fixture write is rolled back.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.rb_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger pass small floor rollback contract: %', p_msg; END IF; END $$;
CREATE FUNCTION pg_temp.rb_restored() RETURNS void LANGUAGE plpgsql AS $$
DECLARE f constant text := 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'; p record;
BEGIN
 SELECT md5(pp.prosrc) AS m, md5(obj_description(pp.oid, 'pg_proc')) AS cm, pp.prosecdef, pp.proconfig, pp.provolatile
 INTO p FROM pg_proc pp WHERE pp.oid = to_regprocedure(f);
 PERFORM pg_temp.rb_assert(p.m = '0c02a410bb32f46315fbf278090ef60e', f || ' is not the 20261006013000 body');
 PERFORM pg_temp.rb_assert(p.cm = 'fd494eca3fc28825a838d82d4a652218', f || ' comment is not 20261006013000''s');
 PERFORM pg_temp.rb_assert(p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND p.provolatile = 'v', f || ' attributes changed');
 PERFORM pg_temp.rb_assert(has_function_privilege('service_role', f, 'EXECUTE') AND NOT has_function_privilege('anon', f, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', f, 'EXECUTE'), f || ' grants changed');
END $$;
-- One build finished from fixed fixtures: p_proposed items proposed, p_local refused by the reader,
-- the rest accepted by the store, one stored item each.
CREATE FUNCTION pg_temp.rb_build(p_n integer, p_proposed integer, p_local integer) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j uuid := ('f2080000-0000-4000-8000-0000000009' || lpad(p_n::text, 2, '0'))::uuid;
 r uuid := ('f2081000-0000-4000-8000-0000000009' || lpad(p_n::text, 2, '0'))::uuid;
 g uuid := ('f2082000-0000-4000-8000-0000000009' || lpad(p_n::text, 2, '0'))::uuid;
 tok uuid := ('f2083000-0000-4000-8000-0000000009' || lpad(p_n::text, 2, '0'))::uuid;
 acc integer := p_proposed - p_local; fin jsonb;
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'SWF-9959' || lpad(p_n::text, 2, '0'), 'Pat Example', NULL,
  'pf-rb-contact-' || p_n, 'Testville', '{}', '2026-09-01 02:00:00+00');
 INSERT INTO public.context_extraction_runs (id, job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at)
 VALUES (r, j, '2026-09-30', 'ledger', 'running', tok, 'infinity', 1, '2026-09-30 02:00:00+00');
 INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, run_id, created_at, updated_at)
 VALUES (g, j, 'backfill', 'building', 'luna-ledger:v2', r, '2026-09-30 02:00:00+00', '2026-09-30 02:00:00+00');
 INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused, result, created_at)
 VALUES (r, g, j, repeat('c', 64), acc, 0, jsonb_build_object('outcome', 'written', 'accepted', '[]'::jsonb, 'refused', '[]'::jsonb),
  '2026-09-30 02:05:00+00');
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by,
  created_at, updated_at)
 SELECT g, j, 'request:none:rb' || k, 'request', 'open', 'customer', 'Asked us to call back about the gate (' || k || ')', '2026-09-20 02:00:00+00',
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', ('f2084000-0000-4000-8000-0000000009' || lpad((p_n * 10 + k)::text, 2, '0')),
   'excerpt', 'please call me back about the gate')),
  'model:luna-ledger:v2', '2026-09-30 02:05:00+00', '2026-09-30 02:05:00+00'
 FROM generate_series(1, acc) k;
 fin := public.context_ledger_finish(r, tok, g, 'built', jsonb_build_object('model', 'gpt-6-luna', 'prompt_sha256', repeat('a', 64),
  'evidence_until', '2026-09-30 01:30:00+00', 'evidence_rows', 6, 'chunks', 1, 'calls', 1, 'tokens_in', 4321,
  'checks', jsonb_build_object('proposed', p_proposed, 'refused_local', p_local)));
 PERFORM pg_temp.rb_assert(fin ->> 'outcome' = 'built' AND (fin #>> '{checks,pass}')::boolean = (fin ->> 'passed')::boolean, 'finish answered: ' || fin::text);
 RETURN (fin ->> 'passed')::boolean;
END $$;

SELECT pg_temp.rb_restored();

-- The earlier verdict is back.
BEGIN;
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert(pg_temp.rb_build(1, 5, 2) IS FALSE, 'after the rollback, 2 of the reader''s own refusals in 5 fail a reading again');
 PERFORM pg_temp.rb_assert(pg_temp.rb_build(2, 5, 1) IS TRUE, 'after the rollback, 1 in 5 still passes');
END $c$;
ROLLBACK;

-- The down runs again cleanly (it accepts the body it restored).
BEGIN;
\ir ../../../rollbacks/20261008095000_context_ledger_pass_small_floor_down.sql
SELECT pg_temp.rb_restored();
ROLLBACK;

-- The migration re-applies on top of its own rollback, and the floor is back.
BEGIN;
\ir ../../../migrations/20261008095000_context_ledger_pass_small_floor.sql
DO $c$ BEGIN
 PERFORM pg_temp.rb_assert((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure)
   = '9a16395d29a3fe4ed9c291c6fadf9a69'
  AND obj_description('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure, 'pg_proc')
   LIKE 'Context ledger store (20261006013000), ledger pass small floor (20261008095000): %', 'the migration re-applies over its rollback');
 PERFORM pg_temp.rb_assert(pg_temp.rb_build(3, 5, 2) IS TRUE, 'after the re-apply, 2 of the reader''s own refusals in 5 pass again');
END $c$;
ROLLBACK;
