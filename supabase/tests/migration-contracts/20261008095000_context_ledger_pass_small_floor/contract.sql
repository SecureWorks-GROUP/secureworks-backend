-- Contract: 20261008095000_context_ledger_pass_small_floor. Every fixture write is rolled back. Job
-- numbers, names and words are synthetic; the counts are the graded shapes (8 Oct: 30 of 172 v2 shadow
-- readings failed their checks, small jobs whose items the reader's own validator refused). Every
-- fixture instant is fixed (a job made 1 Sep 2026, a run claimed 30 Sep 2026 10:00 Perth whose lease
-- never runs out, evidence read to 30 Sep 09:30 Perth), so no answer depends on the clock of the run.
-- Each reading is finished through context_ledger_finish itself, from the store's own receipt rows.
-- No text is sorted here: every order is by an integer (a case number or an item ordinal), so no answer
-- depends on the database collation either.
--
--  1. Shape: the signature, definer and search path, grants, the comment (the store's name first, the
--     floor stated), and nothing switched on.
--  2. The verdict on a build: 2 of the reader's own refusals in 5 pass; 3 in 5 fail; the store's own
--     refusals keep their 20% (the store refusing 1 of the 4 items the reader sent it fails as before,
--     1 of 5 passes as before, and the floor never carries one past it); a 20-item reading keeps the
--     20% rule, both sides counted; from 10 proposed up the floor is the 20%; a build that read
--     evidence and kept no item still fails. Each verdict is the same in the answer, the generation's
--     checks, the promotion rule, the run and the job's backoff.
--  3. The verdict on an update is the same line: 2 of 5 keep a passing reading passing, 3 of 5 fail it.
--  4. The body is the 20261006013000 body production runs with only its v_pass line changed.
--  5. Re-applying the migration changes nothing.
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.pf_assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ledger pass small floor contract: %', p_msg; END IF; END $$;
-- One reading as the store holds it just before its finish, every instant fixed: a job, a ledger run
-- claimed at 30 Sep 2026 02:00 UTC whose lease never runs out ('infinity'), and the generation it reads
-- into: for a build its own building generation, for an update a shadow that passed its build. Then the
-- store's receipt of one write (p_accepted accepted, p_refused refused by the store; none when nothing
-- reached the store) and one stored item per accepted item.
CREATE FUNCTION pg_temp.pf_claimed(p_n integer, p_accepted integer, p_refused integer, p_kind text DEFAULT 'build') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE j uuid := ('f2080000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
 r uuid := ('f2081000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
 g uuid := ('f2082000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
 tok uuid := ('f2083000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
 claimed constant timestamptz := '2026-09-30 02:00:00+00';
BEGIN
 INSERT INTO public.jobs (id, org_id, status, type, job_number, client_name, client_email, ghl_contact_id, site_suburb, metadata, created_at)
 VALUES (j, '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'SWF-9950' || lpad(p_n::text, 2, '0'), 'Pat Example', NULL,
  'pf-contact-' || p_n, 'Testville', '{}', '2026-09-01 02:00:00+00');
 INSERT INTO public.context_extraction_runs (id, job_id, run_date, phase, status, lease_token, lease_expires_at, run_seq, started_at)
 VALUES (r, j, '2026-09-30', 'ledger', 'running', tok, 'infinity', 1, claimed);
 IF p_kind = 'build' THEN
  INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, run_id, created_at, updated_at)
  VALUES (g, j, 'backfill', 'building', 'luna-ledger:v2', r, claimed, claimed);
 ELSE
  INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, model, evidence_until, evidence_rows, chunks, calls, checks,
   created_at, finished_at, updated_at)
  VALUES (g, j, 'backfill', 'shadow', 'luna-ledger:v2', 'gpt-6-luna', '2026-09-29 02:00:00+00', 4, 1, 1,
   '{"passed":true,"store":{"pass":true,"items":3,"items_accepted":3,"items_refused":0,"proposed":3,"refused_local":0}}',
   '2026-09-29 02:00:00+00', '2026-09-29 02:10:00+00', '2026-09-29 02:10:00+00');
 END IF;
 IF p_accepted + p_refused > 0 THEN
  INSERT INTO public.context_ledger_writes (run_id, generation_id, job_id, request_sha256, items_accepted, items_refused, result, created_at)
  VALUES (r, g, j, repeat('c', 64), p_accepted, p_refused, jsonb_build_object('outcome', 'written',
    'accepted', (SELECT coalesce(jsonb_agg(jsonb_build_object('ref', 'a' || k, 'item_key', 'request:none:pf' || k) ORDER BY k), '[]')
                 FROM generate_series(1, p_accepted) k),
    'refused', (SELECT coalesce(jsonb_agg(jsonb_build_object('ref', 'r' || k, 'code', 'closing_not_issued') ORDER BY k), '[]')
                FROM generate_series(1, p_refused) k),
    'transitions_accepted', 0, 'transitions_refused', '[]'::jsonb), claimed + interval '5 minutes');
 END IF;
 INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by,
  created_at, updated_at)
 SELECT g, j, 'request:none:pf' || k, 'request', 'open', 'customer', 'Asked us to call back about the gate (' || k || ')', '2026-09-20 02:00:00+00',
  jsonb_build_array(jsonb_build_object('table', 'business_events', 'id', ('f2084000-0000-4000-8000-' || lpad((p_n * 100 + k)::text, 12, '0')),
   'excerpt', 'please call me back about the gate')),
  'model:luna-ledger:v2', claimed + interval '5 minutes', claimed + interval '5 minutes'
 FROM generate_series(1, p_accepted) k;
 RETURN jsonb_build_object('job', j, 'run', r, 'lease', tok, 'generation', g);
END $$;
-- The reader's finish: what it proposed and what its own validator refused before the store saw it.
CREATE FUNCTION pg_temp.pf_meta(p_proposed integer, p_local integer, p_rows integer DEFAULT 6) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('model', 'gpt-6-luna', 'prompt_sha256', repeat('a', 64), 'evidence_until', '2026-09-30 01:30:00+00',
  'evidence_rows', p_rows, 'chunks', 1, 'calls', 1, 'tokens_in', 4321,
  'checks', jsonb_build_object('validator', 'ok', 'proposed', p_proposed, 'refused_local', p_local)) $$;
-- A build: claimed, written and finished.
CREATE FUNCTION pg_temp.pf_build(p_n integer, p_proposed integer, p_local integer, p_accepted integer, p_refused integer,
 p_rows integer DEFAULT 6) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c jsonb; fin jsonb;
BEGIN
 c := pg_temp.pf_claimed(p_n, p_accepted, p_refused);
 fin := public.context_ledger_finish((c ->> 'run')::uuid, (c ->> 'lease')::uuid, (c ->> 'generation')::uuid, 'built',
  pg_temp.pf_meta(p_proposed, p_local, p_rows));
 RETURN fin || jsonb_build_object('job', c -> 'job', 'run', c -> 'run', 'generation', c -> 'generation');
END $$;
-- A build's verdict, after checking it is kept alike everywhere: the answer, the generation's checks
-- (passed and store.pass), the promotion rule (context_ledger_checks_pass), the run (done, with error
-- checks_failed only on a fail) and the job's backoff (a failed verdict counts once, a pass never).
CREATE FUNCTION pg_temp.pf_verdict(p_fin jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v boolean := (p_fin ->> 'passed')::boolean; g public.context_ledger_generations; r public.context_extraction_runs; f record;
BEGIN
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = (p_fin ->> 'generation')::uuid;
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = (p_fin ->> 'run')::uuid;
 SELECT * INTO f FROM public.context_ledger_failures(ARRAY[(p_fin ->> 'job')::uuid]);
 PERFORM pg_temp.pf_assert(p_fin ->> 'outcome' = 'built' AND v IS NOT NULL AND p_fin ->> 'generation_status' = 'shadow'
  AND NOT (p_fin ->> 'promoted')::boolean AND (p_fin #>> '{checks,pass}')::boolean = v
  AND g.status = 'shadow' AND (g.checks ->> 'passed')::boolean = v AND (g.checks #>> '{store,pass}')::boolean = v
  AND public.context_ledger_checks_pass(g.checks) = v
  AND r.status = 'done' AND r.lease_expires_at IS NULL AND r.error IS NOT DISTINCT FROM CASE WHEN v THEN NULL ELSE 'checks_failed' END
  AND f.failures = CASE WHEN v THEN 0 ELSE 1 END,
  'the verdict is kept alike in the answer, the checks, the promotion rule, the run and the backoff: ' || p_fin::text);
 RETURN v;
END $$;

-- 1. Shape.
DO $c$
DECLARE f constant text := 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'; p record;
BEGIN
 SELECT pp.prosecdef, pp.proconfig, pp.provolatile, pp.prorettype::regtype::text AS rt, obj_description(pp.oid, 'pg_proc') AS c
 INTO p FROM pg_proc pp WHERE pp.oid = to_regprocedure(f);
 PERFORM pg_temp.pf_assert(p.rt = 'jsonb' AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND p.provolatile = 'v',
  f || ' must stay a volatile definer returning jsonb with search_path public, pg_temp');
 PERFORM pg_temp.pf_assert(has_function_privilege('service_role', f, 'EXECUTE')
  AND NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE'),
  f || ' must be executable by service_role only');
 PERFORM pg_temp.pf_assert(NOT EXISTS (SELECT 1 FROM pg_proc pp, aclexplode(coalesce(pp.proacl, acldefault('f', pp.proowner))) a
   WHERE pp.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'), f || ' executable by PUBLIC');
 -- The store's name first (its shape contract and its re-apply guard read it), this slice named, the floor stated.
 PERFORM pg_temp.pf_assert(p.c LIKE 'Context ledger store (20261006013000), ledger pass small floor (20261008095000): closes a ledger run. %'
  AND p.c LIKE '%or at most 2 when that is more (the small-count floor, 20261008095000: up to 2 refused items never fail a reading by ratio;%'
  AND p.c LIKE '%the store''s own refusals at most 20\% of what it saw (no floor)%', f || ' comment: ' || coalesce(p.c, '<none>'));
 -- Nothing switched on: the ledger stays off with no calls.
 PERFORM pg_temp.pf_assert((SELECT mode = 'off' AND calls_per_day = 0 FROM public.context_ledger_settings), 'ledger settings changed');
END $c$;

-- 2. The verdict on a build.
BEGIN;
DO $c$
DECLARE fin jsonb; x record; bad text[] := '{}';
BEGIN
 -- The graded shape: 5 items proposed, the reader's validator refused 2 before the store, the store
 -- accepted the other 3. 40% by ratio, within the floor of 2: passes (it failed whole before).
 fin := pg_temp.pf_build(1, 5, 2, 3, 0);
 PERFORM pg_temp.pf_assert(pg_temp.pf_verdict(fin) IS TRUE AND (fin #>> '{checks,refusal_rate}')::numeric = 0.4
   AND (fin #>> '{checks,refused_rate}')::numeric = 0 AND fin #>> '{checks,proposed}' = '5' AND fin #>> '{checks,refused_local}' = '2'
   AND fin #>> '{checks,items}' = '3',
  'a 5-item reading with 2 of the reader''s own refusals passes: ' || fin::text);
 -- 3 of the reader's own refusals in 5: over the floor and over 20%.
 fin := pg_temp.pf_build(2, 5, 3, 2, 0);
 PERFORM pg_temp.pf_assert(pg_temp.pf_verdict(fin) IS FALSE AND (fin #>> '{checks,refusal_rate}')::numeric = 0.6,
  '3 of the reader''s own refusals in 5 fail: ' || fin::text);
 -- The store's own refusals keep their 20% of what it saw: the reader's validator passed 4 items and the
 -- store refused 1 of them (25%): fails as before, the floor does not reach it.
 fin := pg_temp.pf_build(3, 4, 0, 3, 1);
 PERFORM pg_temp.pf_assert(pg_temp.pf_verdict(fin) IS FALSE AND (fin #>> '{checks,refused_rate}')::numeric = 0.25
   AND (fin #>> '{checks,refusal_rate}')::numeric = 0.25,
  'the store refusing 1 of the 4 items the reader sent it fails as before: ' || fin::text);
 -- Every other shape, one finish each (n, proposed, refused by the reader, accepted by the store,
 -- refused by the store, evidence rows, verdict).
 FOR x IN SELECT * FROM (VALUES
  (4, 5, 0, 4, 1, 6, true, 'the store refusing 1 of 5 is its 20%: passes as before'),
  (5, 5, 1, 3, 1, 6, false, '1 refused by the reader and 1 of 4 by the store: within the floor, but the store''s 25% fails it'),
  (6, 6, 1, 4, 1, 6, true, '1 refused by the reader and 1 of 5 by the store: within the floor and within the store''s 20%'),
  (7, 20, 4, 16, 0, 30, true, 'a 20-item reading: 4 of the reader''s own refusals are its 20%'),
  (8, 20, 5, 15, 0, 30, false, 'a 20-item reading: 5 of the reader''s own refusals are over its 20% (the floor is 4 there)'),
  (9, 20, 3, 15, 2, 30, false, 'a 20-item reading: 3 refused by the reader and 2 of 17 by the store are 25% of it'),
  (10, 9, 2, 7, 0, 12, true, '9 proposed: 2 refused are within the floor'),
  (11, 10, 3, 7, 0, 12, false, '10 proposed: the floor is the 20%, 3 refused fail'),
  (12, 2, 2, 0, 0, 3, false, 'both items refused by the reader: within the floor, but a build that read evidence and kept no item fails')
 ) v(n, proposed, loc, acc, ref, erows, pass, what) ORDER BY n LOOP
  fin := pg_temp.pf_build(x.n, x.proposed, x.loc, x.acc, x.ref, x.erows);
  IF pg_temp.pf_verdict(fin) IS DISTINCT FROM x.pass THEN bad := bad || format('%s (case %s): %s', x.what, x.n, fin); END IF;
 END LOOP;
 PERFORM pg_temp.pf_assert(cardinality(bad) = 0, array_to_string(bad, '; '));
END $c$;
ROLLBACK;

-- 3. The verdict on an update: the same line. A shadow that passed its build stays passing with 2 of the
-- reader's own refusals in 5, and fails with 3.
BEGIN;
DO $c$
DECLARE c jsonb; fin jsonb; g public.context_ledger_generations; r public.context_extraction_runs; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES (21, 2, true), (22, 3, false)) v(n, loc, pass) ORDER BY n LOOP
  c := pg_temp.pf_claimed(x.n, 5 - x.loc, 0, 'update');
  fin := public.context_ledger_finish((c ->> 'run')::uuid, (c ->> 'lease')::uuid, (c ->> 'generation')::uuid, 'updated', pg_temp.pf_meta(5, x.loc));
  SELECT * INTO g FROM public.context_ledger_generations WHERE id = (c ->> 'generation')::uuid;
  SELECT * INTO r FROM public.context_extraction_runs WHERE id = (c ->> 'run')::uuid;
  PERFORM pg_temp.pf_assert(fin ->> 'outcome' = 'updated' AND (fin ->> 'passed')::boolean = x.pass AND NOT (fin ->> 'promoted')::boolean
   AND g.status = 'shadow' AND (g.checks ->> 'passed')::boolean = x.pass AND (g.checks #>> '{store,pass}')::boolean
   AND (g.checks #>> '{last_update,pass}')::boolean = x.pass AND (g.checks #>> '{last_update,refusal_rate}')::numeric = x.loc / 5.0
   AND g.evidence_until = '2026-09-30 01:30:00+00' AND r.status = 'done'
   AND r.error IS NOT DISTINCT FROM CASE WHEN x.pass THEN NULL ELSE 'checks_failed' END,
   format('an update with %s of the reader''s own refusals in 5 %s: %s', x.loc,
    CASE WHEN x.pass THEN 'keeps a passing reading passing' ELSE 'fails it' END, fin));
 END LOOP;
END $c$;
ROLLBACK;

-- 4. The body is the one production runs with only its v_pass line changed: the new line appears once,
-- and put back, the body is the 20261006013000 body word for word (its live md5).
DO $c$
DECLARE src text;
 nl constant text := ' v_pass := (v_local + v_ref) <= greatest(2, 0.2 * v_den) AND v_ref <= 0.2 * (v_acc + v_ref);'
  || '  -- 20261008095000: up to 2 refused items never fail it by ratio' || chr(10);
 ol constant text := ' v_pass := (v_local + v_ref) <= 0.2 * v_den AND v_ref <= 0.2 * (v_acc + v_ref);' || chr(10);
BEGIN
 SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure;
 PERFORM pg_temp.pf_assert((length(src) - length(replace(src, nl, ''))) / length(nl) = 1, 'the floor''s v_pass line appears exactly once');
 PERFORM pg_temp.pf_assert(md5(replace(src, nl, ol)) = '0c02a410bb32f46315fbf278090ef60e',
  'with its v_pass line put back, the body is the 20261006013000 body production runs');
END $c$;

-- 5. Re-applying the migration changes nothing (its guard accepts its own body).
BEGIN;
CREATE TEMP TABLE pf_before AS
 SELECT md5(p.prosrc) AS m, obj_description(p.oid, 'pg_proc') AS c, p.proacl::text AS acl, p.proowner, p.proconfig, p.prosecdef, p.provolatile
 FROM pg_proc p WHERE p.oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure;
\ir ../../../migrations/20261008095000_context_ledger_pass_small_floor.sql
DO $c$ BEGIN
 PERFORM pg_temp.pf_assert((SELECT count(*) FROM pf_before) = 1 AND NOT EXISTS (SELECT 1 FROM pf_before b
   JOIN pg_proc p ON p.oid = 'public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)'::regprocedure
   WHERE md5(p.prosrc) <> b.m OR obj_description(p.oid, 'pg_proc') IS DISTINCT FROM b.c OR p.proacl::text IS DISTINCT FROM b.acl
    OR p.proowner <> b.proowner OR p.proconfig IS DISTINCT FROM b.proconfig OR p.prosecdef <> b.prosecdef OR p.provolatile <> b.provolatile),
  're-applying changed the body, comment, grants or attributes');
END $c$;
ROLLBACK;
