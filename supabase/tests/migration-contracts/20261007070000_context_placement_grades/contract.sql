-- Contract for 20261007070000_context_placement_grades: the placement grades
-- table tied to its draw, the newest-sample read, the sampler and its digest,
-- the grader's card, the copy check, and the plan and counts for the misfiles
-- parked on a holding job. Every fixture row is synthetic and rolled back;
-- user triggers are off while fixtures are written (session_replication_role
-- replica) and on again for every check that needs them. Every instant is
-- pinned: the samples are drawn as of Sat 15 Mar 2031 04:00Z, so no row
-- another case leaves behind is in their window, and no column default
-- (now(), clock_timestamp()) reaches an assertion.

-- 1. Shape: the table, its exact columns, RLS on with no policy, its indexes and
-- foreign keys, and each function with this migration's comment, volatility and
-- security.
DO $$
DECLARE cols text; f text; p record;
BEGIN
 IF to_regclass('public.context_placement_grades') IS NULL THEN RAISE EXCEPTION 'placement contract: the grades table is missing'; END IF;
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_placement_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'id:uuid,sample_id:text,population:text,as_of:timestamp with time zone,pos:integer,drawn:integer,'
   'draw_digest:text,population_rows:integer,population_all:integer,event_id:uuid,placed_job_id:uuid,stratum:text,'
   'stratum_rows:integer,stratum_drawn:integer,verdict:text,reason:text,right_job_id:uuid,grader:text,'
   'graded_at:timestamp with time zone,created_at:timestamp with time zone' THEN
  RAISE EXCEPTION 'placement contract: unexpected columns %', cols;
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_placement_grades'::regclass) THEN
  RAISE EXCEPTION 'placement contract: row level security is off';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.context_placement_grades'::regclass) THEN
  RAISE EXCEPTION 'placement contract: the grades table carries a policy';
 END IF;
 IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'context_placement_grades'
     AND indexname IN ('context_placement_grades_as_of', 'context_placement_grades_event', 'context_placement_grades_placed_job',
                       'context_placement_grades_right_job', 'context_placement_grades_once', 'context_placement_grades_pos_once')) <> 6 THEN
  RAISE EXCEPTION 'placement contract: an index is missing';
 END IF;
 IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'public.context_placement_grades'::regclass AND c.contype = 'f'
     AND c.confrelid = 'public.jobs'::regclass) <> 2 THEN
  RAISE EXCEPTION 'placement contract: placed_job_id and right_job_id must both reference jobs';
 END IF;
 IF coalesce(obj_description('public.context_placement_grades'::regclass, 'pg_class'), '') NOT LIKE 'Context placement grades (20261007070000)%' THEN
  RAISE EXCEPTION 'placement contract: the table comment does not name the migration';
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_placement_population(timestamptz,integer,text)',
   'public.context_placement_sample(timestamptz,integer,text,integer,text)', 'public.context_placement_grade_card(uuid,uuid)',
   'public.context_placement_grades_newest(timestamptz,text)', 'public.context_placement_message_twin(public.business_events)',
   'public.context_placement_misfile_plan()', 'public.context_placement_misfile_counts(timestamptz)'] LOOP
  SELECT pr.prosecdef, pr.provolatile, pr.proconfig INTO p FROM pg_proc pr WHERE pr.oid = to_regprocedure(f);
  IF p IS NULL THEN RAISE EXCEPTION 'placement contract: % is missing', f; END IF;
  IF NOT p.prosecdef OR p.provolatile <> 's' OR NOT ('search_path=public, pg_temp' = ANY (p.proconfig)) THEN
   RAISE EXCEPTION 'placement contract: % must be STABLE SECURITY DEFINER with search_path public, pg_temp', f;
  END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_placement_stratum(text,text,text)', 'public.context_placement_in_population(text,text,text)',
   'public.context_placement_population(timestamptz,integer,text)', 'public.context_placement_draw_digest(jsonb)',
   'public.context_placement_sample(timestamptz,integer,text,integer,text)', 'public.context_placement_grade_card(uuid,uuid)',
   'public.context_placement_grades_newest(timestamptz,text)', 'public.context_placement_message_twin(public.business_events)',
   'public.context_placement_misfile_plan()', 'public.context_placement_misfile_counts(timestamptz)'] LOOP
  IF coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '') NOT LIKE 'Context placement grades (20261007070000)%' THEN
   RAISE EXCEPTION 'placement contract: % comment does not name the migration', f;
  END IF;
 END LOOP;
 -- The per-row stratum and population rules stay inlinable: plain SQL, immutable, no SET clause, not a definer;
 -- the draw digest is plain SQL too (the load re-computes it from a saved draw).
 FOREACH f IN ARRAY ARRAY['public.context_placement_stratum(text,text,text)', 'public.context_placement_in_population(text,text,text)',
   'public.context_placement_draw_digest(jsonb)'] LOOP
  SELECT pr.prosecdef, pr.proconfig, pr.provolatile, l.lanname INTO p FROM pg_proc pr JOIN pg_language l ON l.oid = pr.prolang
  WHERE pr.oid = to_regprocedure(f);
  IF p.prosecdef OR p.proconfig IS NOT NULL OR p.provolatile NOT IN ('i', 's') OR p.lanname <> 'sql'
   OR (f <> 'public.context_placement_draw_digest(jsonb)' AND p.provolatile <> 'i') THEN
   RAISE EXCEPTION 'placement contract: % must stay a plain SQL helper with no SET clause', f;
  END IF;
 END LOOP;
END $$;

-- 2. Access: service role reads and inserts the table and nothing else; anon and
-- authenticated may do nothing; every function is service role only.
DO $$
DECLARE r text; p text; f text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
   IF has_table_privilege(r, 'public.context_placement_grades', p) THEN RAISE EXCEPTION 'placement contract: % may % the grades', r, p; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_table_privilege('service_role', 'public.context_placement_grades', 'SELECT')
  OR NOT has_table_privilege('service_role', 'public.context_placement_grades', 'INSERT') THEN
  RAISE EXCEPTION 'placement contract: service_role cannot read and insert the grades';
 END IF;
 FOREACH p IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
  IF has_table_privilege('service_role', 'public.context_placement_grades', p) THEN RAISE EXCEPTION 'placement contract: service_role may % the grades', p; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_placement_stratum(text,text,text)', 'public.context_placement_in_population(text,text,text)',
   'public.context_placement_population(timestamptz,integer,text)', 'public.context_placement_draw_digest(jsonb)',
   'public.context_placement_sample(timestamptz,integer,text,integer,text)', 'public.context_placement_grade_card(uuid,uuid)',
   'public.context_placement_grades_newest(timestamptz,text)', 'public.context_placement_message_twin(public.business_events)',
   'public.context_placement_misfile_plan()', 'public.context_placement_misfile_counts(timestamptz)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
   OR EXISTS (SELECT 1 FROM pg_proc pr, aclexplode(pr.proacl) a WHERE pr.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
   OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'placement contract: % access wrong', f;
  END IF;
 END LOOP;
END $$;

-- 3. The stratum and population rules.
DO $$
DECLARE c record;
BEGIN
 FOR c IN SELECT * FROM (VALUES
  ('luna', 'review_several', 'contact_id', 'luna'),
  ('single_open', NULL, 'contact_id', 'single_open'), ('single_open', 'identity_email', 'contact_id', 'single_open'),
  ('single_line', 'single_line', 'contact_id', 'single_line'), ('thread', NULL, 'contact_id', 'thread'),
  ('content_ref', 'site_address', 'content_ref', 'content_ref'), ('party', NULL, NULL, 'party'),
  ('direct', 'direct_ref', 'ladder_ref', 'reference'), ('direct', 'internal_ref', 'ladder_ref', 'reference'),
  ('direct', NULL, 'ladder_ref', 'reference'), ('direct', 'payload_job', 'direct_job_id', 'payload_job'),
  ('direct', NULL, 'direct_job_id', 'custody'), ('direct', 'writer_job', 'none', 'custody'),
  ('empty', NULL, NULL, 'no_words'), ('automated', 'writer_job', NULL, 'no_words'),
  (NULL, NULL, 'contact_id', 'other'), ('admin_bucket', 'no_contact', 'none', 'other')
 ) v(st, rule, mm, want) LOOP
  IF public.context_placement_stratum(c.st, c.rule, c.mm) IS DISTINCT FROM c.want THEN
   RAISE EXCEPTION 'placement contract: stratum of (%, %, %) is %, expected %', c.st, c.rule, c.mm,
    public.context_placement_stratum(c.st, c.rule, c.mm), c.want;
  END IF;
 END LOOP;
 FOR c IN SELECT * FROM (VALUES
  ('customer_facing', 'texts', 'customer', true), ('customer_facing', 'emails_out', 'customer', true),
  ('customer_facing', 'texts', 'internal', false), ('customer_facing', 'texts', NULL, false), ('customer_facing', 'xero', 'customer', false),
  ('xero_and_quotes', 'xero', NULL, true), ('xero_and_quotes', 'quotes', 'internal', true), ('xero_and_quotes', 'texts', 'customer', false),
  ('texts', 'texts', 'customer', false), (NULL, 'texts', 'customer', false)
 ) v(pop, lane, aud, want) LOOP
  IF public.context_placement_in_population(c.pop, c.lane, c.aud) IS DISTINCT FROM c.want THEN
   RAISE EXCEPTION 'placement contract: population % of (%, %) is %, expected %', c.pop, c.lane, c.aud,
    public.context_placement_in_population(c.pop, c.lane, c.aud), c.want;
  END IF;
 END LOOP;
END $$;

-- Fixture helpers: one grade row (any field overridden by p; pos is the sample's next when not given),
-- and the SQLSTATE an insert fails with.
CREATE FUNCTION pg_temp.pg_row(p jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('sample_id', 'placement-cf-20310315t040000z-n120-d30', 'population', 'customer_facing',
  'as_of', '2031-03-15 04:00:00+00', 'drawn', 120, 'draw_digest', md5('fixture draw'), 'population_rows', 4000, 'population_all', 6000,
  'event_id', 'a7c00000-0000-4000-8000-0000000000e1', 'placed_job_id', 'a7c00000-0000-4000-8000-0000000000b1',
  'stratum', 'single_open', 'stratum_rows', 60, 'stratum_drawn', 10, 'verdict', 'right', 'grader', 'grader-1',
  'graded_at', '2031-03-16 00:00:00+00', 'created_at', '2031-03-16 00:05:00+00') || p
$$;
CREATE FUNCTION pg_temp.pg_insert(p jsonb) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.context_placement_grades (sample_id, population, as_of, pos, drawn, draw_digest, population_rows, population_all,
  event_id, placed_job_id, stratum, stratum_rows, stratum_drawn, verdict, reason, right_job_id, grader, graded_at, created_at)
 SELECT r.sample_id, r.population, r.as_of,
  coalesce(r.pos, (SELECT coalesce(max(g.pos), 0) + 1 FROM public.context_placement_grades g WHERE g.sample_id = r.sample_id)),
  r.drawn, r.draw_digest, r.population_rows, r.population_all, r.event_id, r.placed_job_id, r.stratum, r.stratum_rows, r.stratum_drawn,
  r.verdict, r.reason, r.right_job_id, r.grader, r.graded_at, r.created_at
 FROM jsonb_populate_record(NULL::public.context_placement_grades, pg_temp.pg_row(p)) r
 RETURNING id
$$;
CREATE FUNCTION pg_temp.pg_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  PERFORM pg_temp.pg_insert(p);
  RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'taken';
 EXCEPTION WHEN SQLSTATE 'P0099' THEN RETURN NULL;
 WHEN OTHERS THEN RETURN SQLSTATE;
 END;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.pg_row(jsonb), pg_temp.pg_insert(jsonb), pg_temp.pg_refused(jsonb) TO anon, authenticated, service_role;

-- Fixture jobs: a holding job, and customers' jobs (all instants pinned).
CREATE FUNCTION pg_temp.pg_jobs() RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.jobs (id, org_id, job_number, status, type, ghl_contact_id, created_at, updated_at, completed_at, metadata, site_address, client_name) VALUES
  ('a7c00000-0000-4000-8000-0000000000b0', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC-HOLD', 'archived', 'fencing', NULL,
   '2031-01-02 00:00Z', '2031-01-02 00:00Z', NULL, '{"do_not_schedule":true,"purpose":"pdf_unlock_bucket"}', NULL, NULL),
  ('a7c00000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC01', 'accepted', 'fencing', 'ctPGCa',
   '2031-02-01 00:00Z', '2031-02-01 00:00Z', NULL, '{}', '1 Fixture Street, Testvale WA', 'Fixture Owner A'),
  ('a7c00000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC02', 'quoted', 'fencing', 'ctPGCb',
   '2031-02-01 00:00Z', '2031-02-01 00:00Z', NULL, '{}', '2 Fixture Street, Testvale WA', 'Fixture Owner B'),
  ('a7c00000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC03', 'quoted', 'patio', 'ctPGCb',
   '2031-02-10 00:00Z', '2031-02-10 00:00Z', NULL, '{}', '3 Fixture Street, Testvale WA', 'Fixture Owner B'),
  ('a7c00000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC04', 'accepted', 'fencing', 'ctPGCc',
   '2031-02-01 00:00Z', '2031-02-01 00:00Z', NULL, '{}', '4 Fixture Street, Testvale WA', 'Fixture Owner C'),
  ('a7c00000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-0000000000aa', 'SWF-PGC05', 'completed', 'fencing', 'ctPGCc',
   '2030-06-01 00:00Z', '2030-08-01 00:00Z', '2030-08-01 00:00Z', '{}', '5 Fixture Street, Testvale WA', 'Fixture Owner C');
 UPDATE public.jobs SET client_email = 'owner.a@pgc.example.test' WHERE id = 'a7c00000-0000-4000-8000-0000000000b1'
$$;

-- 4. The checks keep half answers, unknown codes and draws that do not add up out of the table.
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.pg_jobs();
SET LOCAL session_replication_role = origin;
DO $$
DECLARE c record; got text; i integer := 0;
BEGIN
 IF pg_temp.pg_refused('{}'::jsonb) IS NOT NULL THEN RAISE EXCEPTION 'placement contract: a well formed right grade is refused'; END IF;
 -- Kept (at pos 1) for the duplicate cases below; every other case grades its own message at the sample's
 -- next position, so a unique violation never masks the check or foreign key it is about.
 PERFORM pg_temp.pg_insert('{}'::jsonb);
 IF pg_temp.pg_refused('{"event_id":"a7c00000-0000-4000-8000-0000000000e2","verdict":"wrong","reason":"other_job","right_job_id":"a7c00000-0000-4000-8000-0000000000b2"}')
    IS NOT NULL THEN RAISE EXCEPTION 'placement contract: a well formed wrong grade with its right job is refused'; END IF;
 IF pg_temp.pg_refused('{"event_id":"a7c00000-0000-4000-8000-0000000000e3","verdict":"wrong","reason":"no_job"}') IS NOT NULL
 THEN RAISE EXCEPTION 'placement contract: a well formed wrong grade with no right job is refused'; END IF;
 IF pg_temp.pg_refused('{"event_id":"a7c00000-0000-4000-8000-0000000000e4","verdict":"unsure","reason":"several_jobs","grader":"person:0f000000-0000-4000-8000-0000000000d1"}')
    IS NOT NULL THEN RAISE EXCEPTION 'placement contract: a well formed unsure grade by a person is refused'; END IF;
 IF pg_temp.pg_refused('{"event_id":"a7c00000-0000-4000-8000-0000000000e5","sample_id":"placement-xq-20310315t040000z-n120-d30","population":"xero_and_quotes","stratum":"custody"}')
    IS NOT NULL THEN RAISE EXCEPTION 'placement contract: a well formed Xero and quotes grade is refused'; END IF;
 FOR c IN SELECT * FROM (VALUES
  ('an unknown verdict', '{"verdict":"maybe"}', '23514'),
  ('a right verdict with a reason', '{"reason":"other_job"}', '23514'),
  ('a right verdict naming a right job', '{"right_job_id":"a7c00000-0000-4000-8000-0000000000b2"}', '23514'),
  ('a wrong verdict with no reason', '{"verdict":"wrong"}', '23514'),
  ('a wrong verdict for another job with no job', '{"verdict":"wrong","reason":"other_job"}', '23514'),
  ('a wrong verdict naming the placed job as right', '{"verdict":"wrong","reason":"other_job","right_job_id":"a7c00000-0000-4000-8000-0000000000b1"}', '23514'),
  ('a no-job verdict naming a job', '{"verdict":"wrong","reason":"no_job","right_job_id":"a7c00000-0000-4000-8000-0000000000b2"}', '23514'),
  ('a wrong verdict with an unsure reason', '{"verdict":"wrong","reason":"several_jobs"}', '23514'),
  ('an unsure verdict with no reason', '{"verdict":"unsure"}', '23514'),
  ('an unsure verdict naming a job', '{"verdict":"unsure","reason":"several_jobs","right_job_id":"a7c00000-0000-4000-8000-0000000000b2"}', '23514'),
  ('an unsure verdict with a wrong reason', '{"verdict":"unsure","reason":"no_job"}', '23514'),
  ('an unknown stratum', '{"stratum":"guess"}', '23514'),
  ('a stratum of no rows', '{"stratum_rows":0}', '23514'),
  ('a malformed sample id', '{"sample_id":"Placement 15 March!"}', '23514'),
  ('an unknown population', '{"population":"texts"}', '23514'),
  ('a customer-facing grade under a Xero and quotes sample id', '{"sample_id":"placement-xq-20310315t040000z-n120-d30"}', '23514'),
  ('a Xero and quotes grade under a customer-facing sample id', '{"population":"xero_and_quotes"}', '23514'),
  ('a position before the draw', '{"pos":0}', '23514'),
  ('a position past the draw', '{"pos":121}', '23514'),
  ('a stratum that gave the draw nothing', '{"stratum_drawn":0}', '23514'),
  ('a stratum that gave the draw more than it holds', '{"stratum_drawn":61}', '23514'),
  ('a stratum larger than the placed population', '{"stratum_rows":4001,"stratum_drawn":10}', '23514'),
  ('a draw larger than the placed population', '{"drawn":4001,"population_rows":4000}', '23514'),
  ('a placed population larger than the whole population', '{"population_rows":6001}', '23514'),
  ('a malformed draw digest', '{"draw_digest":"not a digest"}', '23514'),
  ('a malformed grader', '{"grader":"Grader One"}', '23514'),
  ('a grade before the draw', '{"graded_at":"2031-03-15 03:59:59+00"}', '23514'),
  ('a grade stored long before it was given', '{"created_at":"2031-03-15 23:00:00+00"}', '23514'),
  ('a placed job that does not exist', '{"placed_job_id":"a7c00000-0000-4000-8000-0000000000bf"}', '23503'),
  ('a right job that does not exist', '{"verdict":"wrong","reason":"other_job","right_job_id":"a7c00000-0000-4000-8000-0000000000bf"}', '23503'),
  ('a second grade of one message in one sample', '{"event_id":"a7c00000-0000-4000-8000-0000000000e1"}', '23505'),
  ('a second grade at one position of one sample', '{"pos":1}', '23505')
 ) v(label, body, want) LOOP
  i := i + 1;
  got := pg_temp.pg_refused(jsonb_build_object('event_id', ('a7c00000-0000-4000-800b-' || lpad(i::text, 12, '0'))::uuid) || c.body::jsonb);
  IF got IS DISTINCT FROM c.want THEN
   RAISE EXCEPTION 'placement contract: % was not refused with % (got %)', c.label, c.want, coalesce(got, 'taken');
  END IF;
 END LOOP;
END $$;
ROLLBACK;

-- 5. Roles at work: service_role inserts and reads but never updates or deletes; anon and authenticated are refused.
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.pg_jobs();
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE service_role;
DO $$
BEGIN
 PERFORM pg_temp.pg_insert('{}'::jsonb);
 IF (SELECT count(*) FROM public.context_placement_grades WHERE event_id = 'a7c00000-0000-4000-8000-0000000000e1') <> 1 THEN
  RAISE EXCEPTION 'placement contract: service_role cannot read its own grade';
 END IF;
 BEGIN
  UPDATE public.context_placement_grades SET verdict = 'wrong';
  RAISE EXCEPTION 'placement contract: service_role updated a grade';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  DELETE FROM public.context_placement_grades;
  RAISE EXCEPTION 'placement contract: service_role deleted a grade';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 PERFORM * FROM public.context_placement_grades_newest('2031-03-20Z');
 PERFORM * FROM public.context_placement_grades_newest('2031-03-20Z', 'xero_and_quotes');
 PERFORM * FROM public.context_placement_sample('2031-03-15 04:00Z', 5);
 PERFORM public.context_placement_grade_card('a7c00000-0000-4000-8000-0000000000e1');
 PERFORM public.context_placement_misfile_counts('2031-03-20Z');
 PERFORM public.context_placement_draw_digest('[]'::jsonb);
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
 BEGIN
  PERFORM pg_temp.pg_insert('{}'::jsonb);
  RAISE EXCEPTION 'placement contract: authenticated wrote a grade';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM 1 FROM public.context_placement_grades;
  RAISE EXCEPTION 'placement contract: authenticated read the grades';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM * FROM public.context_placement_grades_newest('2031-03-20Z');
  RAISE EXCEPTION 'placement contract: authenticated ran the newest read';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.context_placement_grade_card('a7c00000-0000-4000-8000-0000000000e1');
  RAISE EXCEPTION 'placement contract: authenticated read a grading card';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
 BEGIN
  PERFORM * FROM public.context_placement_sample('2031-03-15 04:00Z', 5);
  RAISE EXCEPTION 'placement contract: anon drew a sample';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM * FROM public.context_placement_misfile_plan();
  RAISE EXCEPTION 'placement contract: anon read the misfile plan';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;

-- 6. The sampler: a scorecard lane's population, stratified, the same rows for one sample id, ids and counts
-- only, and a digest that proves the draw whole.
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.pg_jobs();
-- In the customer-facing population (captured in the 30 days to 15 Mar 2031 04:00Z, on a job, the customer's):
-- 60 single_open texts, 7 custody emails in, 3 Luna texts out, 2 thread emails out.
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, metadata, payload, occurred_at,
 recorded_at, context_captured_at, event_at, attribution_status, match_method)
SELECT ('a7c00000-0000-4000-8001-' || lpad(to_hex(g), 12, '0'))::uuid, 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply',
 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCa',
 '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', '{}',
 '2031-03-01 00:00Z'::timestamptz + make_interval(mins => g), '2031-03-01 00:00Z'::timestamptz + make_interval(mins => g),
 '2031-03-01 00:00Z'::timestamptz + make_interval(mins => g), NULL, 'single_open', 'contact_id'
FROM generate_series(1, 60) g;
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, metadata, payload, occurred_at,
 recorded_at, context_captured_at, event_at, attribution_status, match_method)
SELECT ('a7c00000-0000-4000-8002-' || lpad(to_hex(g), 12, '0'))::uuid, 'a7c00000-0000-4000-8000-0000000000b1', 'client.email_in',
 'outlook-mail-capture', 'email', 'inbound', NULL,
 '{"capture_mode":"live","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}', '{}',
 '2031-03-02 00:00Z'::timestamptz + make_interval(mins => g), '2031-03-02 00:00Z'::timestamptz + make_interval(mins => g),
 '2031-03-02 00:00Z'::timestamptz + make_interval(mins => g), NULL, 'direct', 'direct_job_id'
FROM generate_series(1, 7) g;
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, metadata, payload, occurred_at,
 recorded_at, context_captured_at, event_at, attribution_status, match_method)
SELECT ('a7c00000-0000-4000-8003-' || lpad(to_hex(g), 12, '0'))::uuid, 'a7c00000-0000-4000-8000-0000000000b1', 'client.sms_out',
 'ghl-message-reconcile', 'sms', 'outbound', 'ctPGCa',
 '{"capture_mode":"live","placement_rule":"review_several","party_roles":{"sender_role":"staff","recipient_role":"customer","audience":"customer"}}', '{}',
 '2031-03-03 00:00Z'::timestamptz + make_interval(mins => g), '2031-03-03 00:00Z'::timestamptz + make_interval(mins => g),
 '2031-03-03 00:00Z'::timestamptz + make_interval(mins => g), NULL, 'luna', 'contact_id'
FROM generate_series(1, 3) g;
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, metadata, payload, occurred_at,
 recorded_at, context_captured_at, event_at, attribution_status, match_method)
SELECT ('a7c00000-0000-4000-8004-' || lpad(to_hex(g), 12, '0'))::uuid, 'a7c00000-0000-4000-8000-0000000000b1', 'client.email_out',
 'outlook-mail-capture', 'email', 'outbound', NULL,
 '{"capture_mode":"live","party_roles":{"sender_role":"staff","recipient_role":"customer","audience":"customer"}}', '{}',
 '2031-03-04 00:00Z'::timestamptz + make_interval(mins => g), '2031-03-04 00:00Z'::timestamptz + make_interval(mins => g),
 '2031-03-04 00:00Z'::timestamptz + make_interval(mins => g), NULL, 'thread', 'contact_id'
FROM generate_series(1, 2) g;
-- Out of the customer-facing population: not the customer's, on no job (but in the whole population), captured
-- before the window, captured after the instant, a Xero row, our crew text, and a row with no party roles.
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, metadata, payload, occurred_at, recorded_at,
 context_captured_at, attribution_status, match_method, body_preview) VALUES
 ('a7c00000-0000-4000-8009-000000000001', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl', 'sms', 'inbound',
  '{"party_roles":{"audience":"internal"}}', '{}', '2031-03-05Z', '2031-03-05Z', '2031-03-05Z', 'direct', 'direct_job_id', NULL),
 ('a7c00000-0000-4000-8009-000000000002', NULL, 'client.reply', 'ghl', 'sms', 'inbound',
  '{"party_roles":{"audience":"customer"}}', '{}', '2031-03-05Z', '2031-03-05Z', '2031-03-05Z', 'admin_bucket', 'none', NULL),
 ('a7c00000-0000-4000-8009-000000000003', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl', 'sms', 'inbound',
  '{"party_roles":{"audience":"customer"}}', '{}', '2031-02-13 03:00Z', '2031-02-13 03:00Z', '2031-02-13 03:00Z', 'single_open', 'contact_id', NULL),
 ('a7c00000-0000-4000-8009-000000000004', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl', 'sms', 'inbound',
  '{"party_roles":{"audience":"customer"}}', '{}', '2031-03-15 04:00:01Z', '2031-03-15 04:00:01Z', '2031-03-15 04:00:01Z', 'single_open', 'contact_id', NULL),
 ('a7c00000-0000-4000-8009-000000000005', 'a7c00000-0000-4000-8000-0000000000b1', 'invoice.raised', 'xero', 'invoice', 'internal',
  '{"party_roles":{"audience":"customer"}}', '{}', '2031-03-05Z', '2031-03-05Z', '2031-03-05Z', 'direct', 'direct_job_id', NULL),
 ('a7c00000-0000-4000-8009-000000000006', 'a7c00000-0000-4000-8000-0000000000b1', 'client.sms_out', 'ops-api', 'sms', 'outbound',
  '{"recipient_role":"crew","party_roles":{"audience":"customer"}}', '{}', '2031-03-05Z', '2031-03-05Z', '2031-03-05Z', 'direct', 'direct_job_id',
  'Job ready for crew: SWF-PGC01'),
 ('a7c00000-0000-4000-8009-000000000007', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl', 'sms', 'inbound',
  '{}', '{}', '2031-03-05Z', '2031-03-05Z', '2031-03-05Z', 'single_open', 'contact_id', NULL),
 -- The Xero and quotes population: two more placed Xero rows, one placed quote, one Xero row on no job.
 ('a7c00000-0000-4000-8009-000000000008', 'a7c00000-0000-4000-8000-0000000000b1', 'invoice.paid', 'xero-sync-trigger', NULL, NULL,
  '{}', '{}', '2031-03-06Z', '2031-03-06Z', '2031-03-06Z', 'automated', 'direct_job_id', NULL),
 ('a7c00000-0000-4000-8009-000000000009', 'a7c00000-0000-4000-8000-0000000000b2', 'invoice.authorised', 'xero-history', NULL, NULL,
  '{}', '{}', '2031-03-06Z', '2031-03-06Z', '2031-03-06Z', 'direct', 'direct_job_id', NULL),
 ('a7c00000-0000-4000-8009-00000000000a', 'a7c00000-0000-4000-8000-0000000000b2', 'quote.sent', 'send-quote/send', NULL, NULL,
  '{}', '{}', '2031-03-07Z', '2031-03-07Z', '2031-03-07Z', 'direct', 'direct_job_id', NULL),
 ('a7c00000-0000-4000-8009-00000000000b', NULL, 'payment.reconciled', 'mcp_agent', NULL, NULL,
  '{}', '{}', '2031-03-07Z', '2031-03-07Z', '2031-03-07Z', NULL, NULL, NULL);
SET LOCAL session_replication_role = origin;
DO $$
DECLARE got text; v_a uuid[]; v_b uuid[]; v_draw jsonb; v_d text; v_perth text;
BEGIN
 -- The population is exactly the 72 placed customer messages, each with its stratum and lane.
 IF (SELECT count(*) FROM public.context_placement_population('2031-03-15 04:00Z', 30)) <> 72
  OR (SELECT count(*) FROM public.context_placement_population('2031-03-15 04:00Z', 30) p
      WHERE p.event_id::text LIKE 'a7c00000-0000-4000-8009-%') <> 0 THEN
  RAISE EXCEPTION 'placement contract: the population is not the 72 placed customer messages in the window';
 END IF;
 SELECT string_agg(x.stratum || ':' || x.lane || ':' || x.n, ',' ORDER BY x.stratum COLLATE "C", x.lane COLLATE "C") INTO got
 FROM (SELECT p.stratum, p.lane, count(*) AS n FROM public.context_placement_population('2031-03-15 04:00Z', 30) p GROUP BY 1, 2) x;
 IF got IS DISTINCT FROM 'custody:emails_in:7,luna:texts:3,single_open:texts:60,thread:emails_out:2' THEN
  RAISE EXCEPTION 'placement contract: population strata and lanes are %', got;
 END IF;
 -- 20 of 72: up to 5 each first (custody 5, luna 3, single_open 5, thread 2), the other 5 by what is left
 -- (single_open 55 of 57: 4.8, custody 2 of 57: 0.2), largest remainder.
 SELECT string_agg(x.stratum || ':' || x.k || ':' || x.rows_ || ':' || x.drawn, ',' ORDER BY x.stratum COLLATE "C") INTO got
 FROM (SELECT s.stratum, count(*) AS k, min(s.stratum_rows) AS rows_, min(s.stratum_drawn) AS drawn
       FROM public.context_placement_sample('2031-03-15 04:00Z', 20) s GROUP BY 1) x;
 IF got IS DISTINCT FROM 'custody:5:7:5,luna:3:3:3,single_open:10:60:10,thread:2:2:2' THEN
  RAISE EXCEPTION 'placement contract: a sample of 20 allocates %', got;
 END IF;
 -- The draw's facts on every row: its id and instant, its size, the placed population (72) and every
 -- customer message in the window, placed or not (73: one waits in the bucket).
 IF (SELECT count(*) FROM public.context_placement_sample('2031-03-15 04:00Z', 20)) <> 20
  OR (SELECT count(DISTINCT s.event_id) FROM public.context_placement_sample('2031-03-15 04:00Z', 20) s) <> 20
  OR (SELECT string_agg(s.pos::text, ',' ORDER BY s.pos) FROM public.context_placement_sample('2031-03-15 04:00Z', 20) s)
     IS DISTINCT FROM (SELECT string_agg(g::text, ',' ORDER BY g) FROM generate_series(1, 20) g)
  OR EXISTS (SELECT 1 FROM public.context_placement_sample('2031-03-15 04:00Z', 20) s
             WHERE s.sample_id <> 'placement-cf-20310315t040000z-n20-d30' OR s.population <> 'customer_facing'
                OR s.as_of <> '2031-03-15 04:00Z' OR s.drawn <> 20 OR s.population_rows <> 72 OR s.population_all <> 73
                OR s.placed_job_id <> 'a7c00000-0000-4000-8000-0000000000b1' OR s.captured_at > '2031-03-15 04:00Z'
                OR s.draw_digest !~ '^[0-9a-f]{32}$')
  OR (SELECT count(DISTINCT s.draw_digest) FROM public.context_placement_sample('2031-03-15 04:00Z', 20) s) <> 1 THEN
  RAISE EXCEPTION 'placement contract: a sample of 20 is not 20 distinct rows in draw order with its id, instant and draw facts';
 END IF;
 -- The digest proves the draw whole: re-computed from the saved rows it is the one stamped on them; a draw
 -- saved one row short, mixed with another draw or edited reads otherwise, or not at all.
 SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pos), min(s.draw_digest) INTO v_draw, v_d FROM public.context_placement_sample('2031-03-15 04:00Z', 20) s;
 IF public.context_placement_draw_digest(v_draw) IS DISTINCT FROM v_d THEN
  RAISE EXCEPTION 'placement contract: the saved draw does not re-compute its own digest';
 END IF;
 IF public.context_placement_draw_digest(v_draw - 19) IS NOT DISTINCT FROM v_d
  OR public.context_placement_draw_digest(jsonb_set(v_draw, '{0,placed_job_id}', '"a7c00000-0000-4000-8000-0000000000b2"')) IS NOT DISTINCT FROM v_d
  OR public.context_placement_draw_digest(jsonb_set(v_draw, '{0,drawn}', '19')) IS NOT NULL
  OR public.context_placement_draw_digest(v_draw #- '{0,stratum}') IS NOT NULL
  OR public.context_placement_draw_digest('[]'::jsonb) IS NOT NULL OR public.context_placement_draw_digest('{}'::jsonb) IS NOT NULL THEN
  RAISE EXCEPTION 'placement contract: a short, edited or inconsistent draw reads as whole';
 END IF;
 -- One digest in any session time zone (the saved instant is read as an instant).
 SET LOCAL TIME ZONE 'Australia/Perth';
 SELECT public.context_placement_draw_digest(jsonb_agg(to_jsonb(s) ORDER BY s.pos)) INTO v_perth
 FROM public.context_placement_sample('2031-03-15 04:00Z', 20) s;
 SET LOCAL TIME ZONE 'UTC';
 IF v_perth IS DISTINCT FROM v_d OR public.context_placement_draw_digest(v_draw) IS DISTINCT FROM v_d THEN
  RAISE EXCEPTION 'placement contract: the draw digest depends on the session time zone';
 END IF;
 -- 6 of 72: one each first (6 / 4 strata), the other 2 by what is left (single_open 59 of 68: 1.7).
 SELECT string_agg(x.stratum || ':' || x.k, ',' ORDER BY x.stratum COLLATE "C") INTO got
 FROM (SELECT s.stratum, count(*) AS k FROM public.context_placement_sample('2031-03-15 04:00Z', 6) s GROUP BY 1) x;
 IF got IS DISTINCT FROM 'custody:1,luna:1,single_open:3,thread:1' THEN RAISE EXCEPTION 'placement contract: a sample of 6 allocates %', got; END IF;
 -- 120 of 72: every row once.
 IF (SELECT count(*) FROM public.context_placement_sample('2031-03-15 04:00Z')) <> 72
  OR EXISTS (SELECT 1 FROM public.context_placement_sample('2031-03-15 04:00Z') s WHERE s.drawn <> 72) THEN
  RAISE EXCEPTION 'placement contract: a sample larger than the population does not take every row';
 END IF;
 -- One sample id draws the same rows: the instant is truncated to the second; a seed is a different sample.
 SELECT array_agg(s.event_id ORDER BY s.pos) INTO v_a FROM public.context_placement_sample('2031-03-15 04:00:00.9Z', 20) s;
 SELECT array_agg(s.event_id ORDER BY s.pos) INTO v_b FROM public.context_placement_sample('2031-03-15 04:00:00Z', 20) s;
 IF v_a IS DISTINCT FROM v_b THEN RAISE EXCEPTION 'placement contract: one sample id drew different rows'; END IF;
 SELECT array_agg(s.event_id ORDER BY s.pos) INTO v_b FROM public.context_placement_sample('2031-03-15 04:00:00Z', 20, 'b2') s;
 IF v_a = v_b OR (SELECT min(s.sample_id) FROM public.context_placement_sample('2031-03-15 04:00:00Z', 20, 'b2') s)
    <> 'placement-cf-20310315t040000z-n20-d30-b2' THEN
  RAISE EXCEPTION 'placement contract: a seeded sample is not its own sample';
 END IF;
 -- The Xero and quotes population (row 3's second clause): the scorecard's xero_and_quotes lane, any audience.
 SELECT string_agg(s.event_id::text || ':' || s.stratum, ',' ORDER BY s.event_id) || '|' || min(s.sample_id) || '|' || min(s.drawn)
         || '|' || min(s.population_rows) || '|' || min(s.population_all)
 INTO got FROM public.context_placement_sample('2031-03-15 04:00Z', 20, NULL, 30, 'xero_and_quotes') s;
 IF got IS DISTINCT FROM 'a7c00000-0000-4000-8009-000000000005:custody,a7c00000-0000-4000-8009-000000000008:no_words,'
   'a7c00000-0000-4000-8009-000000000009:custody,a7c00000-0000-4000-8009-00000000000a:custody'
   '|placement-xq-20310315t040000z-n20-d30|4|4|5' THEN
  RAISE EXCEPTION 'placement contract: the Xero and quotes draw reads %', got;
 END IF;
 -- Ids, codes and counts only: no column of the sample carries words.
 IF EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames, p.proargmodes::text[]) a(n, m)
            WHERE p.oid = 'public.context_placement_sample(timestamptz,integer,text,integer,text)'::regprocedure AND a.m = 't'
              AND a.n NOT IN ('sample_id', 'population', 'as_of', 'pos', 'event_id', 'placed_job_id', 'stratum', 'stratum_rows',
                              'stratum_drawn', 'drawn', 'population_rows', 'population_all', 'draw_digest', 'lane', 'captured_at')) THEN
  RAISE EXCEPTION 'placement contract: the sample returns a column beyond ids, codes, counts and instants';
 END IF;
 -- Bad arguments refuse by name.
 BEGIN PERFORM * FROM public.context_placement_sample('2031-03-15 04:00Z', 0);
  RAISE EXCEPTION 'placement contract: a sample of 0 was drawn';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_placement_sample: p_size%' THEN RAISE; END IF; END;
 BEGIN PERFORM * FROM public.context_placement_sample('2031-03-15 04:00Z', 1001);
  RAISE EXCEPTION 'placement contract: a sample of 1001 was drawn';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_placement_sample: p_size%' THEN RAISE; END IF; END;
 BEGIN PERFORM * FROM public.context_placement_sample('2031-03-15 04:00Z', 20, 'Bad seed');
  RAISE EXCEPTION 'placement contract: a malformed seed was taken';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_placement_sample: p_seed%' THEN RAISE; END IF; END;
 BEGIN PERFORM * FROM public.context_placement_sample('2031-03-15 04:00Z', 20, NULL, 0);
  RAISE EXCEPTION 'placement contract: a window of 0 days was taken';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_placement_sample: p_days%' THEN RAISE; END IF; END;
 BEGIN PERFORM * FROM public.context_placement_sample('2031-03-15 04:00Z', 20, NULL, 30, 'texts');
  RAISE EXCEPTION 'placement contract: an unknown population was drawn';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'context_placement_sample: p_population%' THEN RAISE; END IF; END;
END $$;
ROLLBACK;

-- 7. The newest sample of a population, as the scorecard reads it.
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.pg_jobs();
SET LOCAL session_replication_role = origin;
-- Sample B (drawn as of 15 Mar, stored 16 Mar; 5 drawn of 67 placed and 100 in all): single_open 2 right 1 wrong
-- and one drawn item never graded (a stratum of 60, 4 drawn), custody 1 right (a stratum of 7, 1 drawn).
SELECT pg_temp.pg_insert(jsonb_build_object('event_id', 'a7c00000-0000-4000-8005-00000000000' || g, 'drawn', 5,
 'population_rows', 67, 'population_all', 100, 'stratum_drawn', 4,
 'verdict', CASE WHEN g = 3 THEN 'wrong' ELSE 'right' END, 'reason', CASE WHEN g = 3 THEN 'other_job' END,
 'right_job_id', CASE WHEN g = 3 THEN 'a7c00000-0000-4000-8000-0000000000b2' END))
FROM generate_series(1, 3) g;
SELECT pg_temp.pg_insert(jsonb_build_object('event_id', 'a7c00000-0000-4000-8005-000000000004', 'pos', 5, 'drawn', 5,
 'population_rows', 67, 'population_all', 100, 'stratum', 'custody', 'stratum_rows', 7, 'stratum_drawn', 1));
-- Sample A (drawn earlier, 10 Mar, but graded and stored later, 20 Mar): 2 right, 1 unsure, drawn whole.
SELECT pg_temp.pg_insert(jsonb_build_object('sample_id', 'placement-cf-20310310t040000z-n120-d30', 'as_of', '2031-03-10 04:00Z',
 'event_id', 'a7c00000-0000-4000-8006-00000000000' || g, 'drawn', 3, 'stratum_drawn', 3,
 'verdict', CASE WHEN g = 3 THEN 'unsure' ELSE 'right' END,
 'reason', CASE WHEN g = 3 THEN 'not_enough_evidence' END, 'graded_at', '2031-03-20 00:00Z', 'created_at', '2031-03-20 00:05Z'))
FROM generate_series(1, 3) g;
-- Sample C (drawn 21 Mar, stored 22 Mar; 2 drawn of 60 placed and 80 in all): 1 right, 1 unsure.
SELECT pg_temp.pg_insert(jsonb_build_object('sample_id', 'placement-cf-20310321t040000z-n120-d30', 'as_of', '2031-03-21 04:00Z',
 'event_id', 'a7c00000-0000-4000-8007-00000000000' || g, 'drawn', 2, 'population_rows', 60, 'population_all', 80, 'stratum_drawn', 2,
 'verdict', CASE WHEN g = 2 THEN 'unsure' ELSE 'right' END,
 'reason', CASE WHEN g = 2 THEN 'several_jobs' END, 'graded_at', '2031-03-22 00:00Z', 'created_at', '2031-03-22 00:05Z'))
FROM generate_series(1, 2) g;
-- Sample D (Xero and quotes, drawn 22 Mar, stored 23 Mar): 1 of 1 right, 40 placed of 50.
SELECT pg_temp.pg_insert(jsonb_build_object('sample_id', 'placement-xq-20310322t040000z-n120-d30', 'population', 'xero_and_quotes',
 'as_of', '2031-03-22 04:00Z', 'event_id', 'a7c00000-0000-4000-8008-000000000009', 'drawn', 1, 'population_rows', 40,
 'population_all', 50, 'stratum', 'custody', 'stratum_rows', 30, 'stratum_drawn', 1,
 'graded_at', '2031-03-23 00:00Z', 'created_at', '2031-03-23 00:05Z'));
SET LOCAL ROLE service_role;
DO $$
DECLARE n record;
BEGIN
 -- Newest by the instant drawn, among a population's grades stored by the instant read: C.
 SELECT * INTO n FROM public.context_placement_grades_newest('2031-03-25Z');
 IF n.sample_id IS DISTINCT FROM 'placement-cf-20310321t040000z-n120-d30' OR n.population <> 'customer_facing' OR n.samples <> 3
  OR n.graded <> 2 OR n.drawn <> 2 OR n.missing <> 0 THEN
  RAISE EXCEPTION 'placement contract: the newest sample on 25 Mar is %', to_jsonb(n);
 END IF;
 -- An unsure verdict is never right.
 IF n.right_count <> 1 OR n.unsure_count <> 1 OR n.right_share IS DISTINCT FROM 0.5000 OR n.weighted_right_share IS DISTINCT FROM 0.5000 THEN
  RAISE EXCEPTION 'placement contract: an unsure verdict counted as right: %', to_jsonb(n);
 END IF;
 -- Right of all: the right share times the placed share at the draw (60 of 80): 0.5 x 0.75.
 IF n.placed_share IS DISTINCT FROM 0.7500 OR n.right_of_all IS DISTINCT FROM 0.3750 THEN
  RAISE EXCEPTION 'placement contract: the placed share and right of all read % and %, expected 0.7500 and 0.3750', n.placed_share, n.right_of_all;
 END IF;
 -- Before C is stored, B (drawn 15 Mar) outranks A (drawn 10 Mar) although A was graded later.
 SELECT * INTO n FROM public.context_placement_grades_newest('2031-03-21 12:00Z');
 IF n.sample_id IS DISTINCT FROM 'placement-cf-20310315t040000z-n120-d30' OR n.samples <> 2 OR n.as_of <> '2031-03-15 04:00Z'
  OR n.graded_at <> '2031-03-16 00:00Z' OR n.graded <> 4 OR n.right_count <> 3 OR n.wrong_count <> 1 OR n.unsure_count <> 0 THEN
  RAISE EXCEPTION 'placement contract: the newest sample on 21 Mar is %', to_jsonb(n);
 END IF;
 -- A drawn item never graded is never right: 3 right of 5 drawn (not of 4 graded); single_open 2 of its 4 drawn,
 -- custody 1 of 1, weighted (60 x 2/4 + 7 x 1/1) / 67 = 37/67; placed 67 of 100; right of all least(0.6, 37/67)
 -- x 0.67 = 0.37; every share rounded DOWN to 4 places.
 IF n.drawn <> 5 OR n.missing <> 1 OR n.right_share IS DISTINCT FROM 0.6000 OR n.weighted_right_share IS DISTINCT FROM 0.5522
  OR n.placed_share IS DISTINCT FROM 0.6700 OR n.right_of_all IS DISTINCT FROM 0.3700 THEN
  RAISE EXCEPTION 'placement contract: a partly graded draw reads %', to_jsonb(n);
 END IF;
 IF n.strata IS DISTINCT FROM '{"custody":{"drawn":1,"graded":1,"right":1,"wrong":0,"unsure":0,"stratum_rows":7},"single_open":{"drawn":4,"graded":3,"right":2,"wrong":1,"unsure":0,"stratum_rows":60}}'::jsonb THEN
  RAISE EXCEPTION 'placement contract: the strata are %', n.strata;
 END IF;
 -- Only grades stored by the instant read count.
 SELECT * INTO n FROM public.context_placement_grades_newest('2031-03-17Z');
 IF n.sample_id IS DISTINCT FROM 'placement-cf-20310315t040000z-n120-d30' OR n.samples <> 1 THEN
  RAISE EXCEPTION 'placement contract: a grade stored after the instant read counted: %', to_jsonb(n);
 END IF;
 -- Each population reads its own samples: D for Xero and quotes (1 of 1 right, 40 placed of 50).
 SELECT * INTO n FROM public.context_placement_grades_newest('2031-03-25Z', 'xero_and_quotes');
 IF n.sample_id IS DISTINCT FROM 'placement-xq-20310322t040000z-n120-d30' OR n.population <> 'xero_and_quotes' OR n.samples <> 1
  OR n.drawn <> 1 OR n.right_share IS DISTINCT FROM 1.0000 OR n.placed_share IS DISTINCT FROM 0.8000 OR n.right_of_all IS DISTINCT FROM 0.8000 THEN
  RAISE EXCEPTION 'placement contract: the Xero and quotes sample reads %', to_jsonb(n);
 END IF;
 -- Nothing stored yet: one row, zeros and nulls.
 SELECT * INTO n FROM public.context_placement_grades_newest('2031-03-15 12:00Z');
 IF n.sample_id IS NOT NULL OR n.as_of IS NOT NULL OR n.graded <> 0 OR n.drawn IS NOT NULL OR n.right_count <> 0 OR n.right_share IS NOT NULL
  OR n.weighted_right_share IS NOT NULL OR n.right_of_all IS NOT NULL OR n.strata <> '{}'::jsonb OR n.samples <> 0 THEN
  RAISE EXCEPTION 'placement contract: an empty read is %', to_jsonb(n);
 END IF;
 IF (SELECT count(*) FROM public.context_placement_grades_newest('2031-03-15 12:00Z')) <> 1 THEN
  RAISE EXCEPTION 'placement contract: the newest read is not always one row';
 END IF;
END $$;
ROLLBACK;

-- 8. The grader's card: the words, the record, the jobs as they stood, never how the ladder placed it.
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.pg_jobs();
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, metadata, payload, occurred_at,
 recorded_at, context_captured_at, event_at, attribution_status, attribution_step, match_method, body_preview, thread_key) VALUES
 ('a7c00000-0000-4000-8008-000000000001', 'a7c00000-0000-4000-8000-0000000000b2', 'client.reply', 'ghl-message-reconcile', 'sms', 'inbound', 'ctPGCb',
  '{"placement_rule":"single_open","party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}',
  '{"body":"Is SWF-PGC03 the patio one? Please confirm the date."}',
  '2031-03-05 01:00Z', '2031-03-05 01:00Z', '2031-03-05 01:00Z', NULL, 'single_open', 3, 'contact_id', 'Is SWF-PGC03 the patio one?', NULL),
 ('a7c00000-0000-4000-8008-000000000002', 'a7c00000-0000-4000-8000-0000000000b2', 'client.sms_out', 'ghl-message-reconcile', 'sms', 'outbound', 'ctPGCb',
  '{"party_roles":{"sender_role":"staff","recipient_role":"customer","audience":"customer"}}', '{"body":"Yes, booked for Monday."}',
  '2031-03-05 02:00Z', '2031-03-05 02:00Z', '2031-03-05 02:00Z', NULL, 'single_open', 3, 'contact_id', 'Yes, booked', NULL),
 ('a7c00000-0000-4000-8008-000000000003', 'a7c00000-0000-4000-8000-0000000000b2', 'client.sms_out', 'ghl-message-reconcile', 'sms', 'outbound', 'ctPGCb',
  '{}', '{"body":"Another customer thread a month later"}',
  '2031-04-10 02:00Z', '2031-04-10 02:00Z', '2031-04-10 02:00Z', NULL, 'single_open', 3, 'contact_id', 'later', NULL),
 -- An email with no contact on the row: the card recovers the customer from the sender's own email key.
 ('a7c00000-0000-4000-8008-000000000004', 'a7c00000-0000-4000-8000-0000000000b1', 'client.email_in', 'outlook-mail-capture', 'email', 'inbound', NULL,
  '{"party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}',
  '{"from":"Fixture Owner A <owner.a@pgc.example.test>","subject":"Gate latch","body":"The latch is loose again."}',
  '2031-03-06 01:00Z', '2031-03-06 01:00Z', '2031-03-06 01:00Z', NULL, 'thread', 2, 'contact_id', 'The latch', 'outlook:pgc-card-4'),
 -- A Xero invoice: the card shows the invoice's own number, reference, contact and line words.
 ('a7c00000-0000-4000-8008-000000000005', 'a7c00000-0000-4000-8000-0000000000b1', 'invoice.raised', 'xero-history', NULL, NULL, NULL,
  '{}', '{"xero_invoice_id":"xero-pgc-inv-1","invoice_number":"INV-PGC1","total":1100}',
  '2031-03-07 01:00Z', '2031-03-07 01:00Z', '2031-03-07 01:00Z', NULL, 'direct', 1, 'direct_job_id', NULL, NULL);
INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, invoice_number, invoice_type, status, total, reference, contact_name, line_items, invoice_date)
VALUES ('a7c00000-0000-4000-800f-000000000001', '00000000-0000-4000-8000-0000000000aa', 'xero-pgc-inv-1', 'INV-PGC1', 'ACCREC', 'AUTHORISED', 1100, 'SWF-PGC01 deposit',
 'Fixture Owner A', '[{"Description":"Deposit for the front fence"}]', '2031-03-07');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE service_role;
DO $$
DECLARE c jsonb;
BEGIN
 c := public.context_placement_grade_card('a7c00000-0000-4000-8008-000000000001', 'a7c00000-0000-4000-8000-0000000000b2');
 IF c->>'version' <> 'context-placement-grade-card-v2' OR NOT (c->>'found')::boolean OR c->>'lane' <> 'texts'
  OR c->>'text' <> 'Is SWF-PGC03 the patio one? Please confirm the date.' OR c->>'contact_id' <> 'ctPGCb'
  OR c->>'sender_role' <> 'customer' OR c->>'direction' <> 'inbound' OR (c->>'at')::timestamptz <> '2031-03-05 01:00Z'
  OR c->'placed'->>'job_number' <> 'SWF-PGC02' OR (c->'placed'->>'holding_job')::boolean OR (c->>'moved_since_draw')::boolean
  OR c->'record' IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'placement contract: the card is wrong: %', c;
 END IF;
 -- The customer's two jobs, both live at the message time; the job the words name; the reply nearby (the
 -- message a month later is outside the 14 days).
 IF jsonb_array_length(c->'customer_jobs_at_message') <> 2
  OR (SELECT string_agg((x->>'job_number') || ':' || (x->>'live_at_message'), ',' ORDER BY x->>'job_number' COLLATE "C")
      FROM jsonb_array_elements(c->'customer_jobs_at_message') x) <> 'SWF-PGC02:true,SWF-PGC03:true'
  OR (SELECT string_agg(x->>'job_number', ',') FROM jsonb_array_elements(c->'named_jobs') x) IS DISTINCT FROM 'SWF-PGC03'
  OR (SELECT string_agg(x->>'event_id', ',') FROM jsonb_array_elements(c->'nearby_messages') x)
     IS DISTINCT FROM 'a7c00000-0000-4000-8008-000000000002'
  OR (SELECT x->>'text' FROM jsonb_array_elements(c->'nearby_messages') x) <> 'Yes, booked for Monday.' THEN
  RAISE EXCEPTION 'placement contract: the card''s jobs or neighbours are wrong: %', c;
 END IF;
 -- It never says how the ladder placed the message.
 IF c::text ~ '"(attribution_status|attribution_step|attribution_confidence|placement_rule|match_method|match_status|match_confidence|candidate_job_ids)"'
    OR c::text LIKE '%single_open%' THEN
  RAISE EXCEPTION 'placement contract: the card says how the message was placed: %', c;
 END IF;
 -- The drawn job, when it differs from where the row sits now.
 c := public.context_placement_grade_card('a7c00000-0000-4000-8008-000000000001', 'a7c00000-0000-4000-8000-0000000000b3');
 IF c->'placed'->>'job_number' <> 'SWF-PGC03' OR NOT (c->>'moved_since_draw')::boolean
  OR c->>'job_now' <> 'a7c00000-0000-4000-8000-0000000000b2' THEN
  RAISE EXCEPTION 'placement contract: a moved message reads %', c;
 END IF;
 c := public.context_placement_grade_card('a7c00000-0000-4000-8008-0000000000ff');
 IF (c->>'found')::boolean OR c ? 'text' THEN RAISE EXCEPTION 'placement contract: a missing message reads %', c; END IF;
 -- No contact on the row and none in its payload: the one contact its sender's email key names, said so.
 c := public.context_placement_grade_card('a7c00000-0000-4000-8008-000000000004');
 IF c->>'contact_id' IS DISTINCT FROM 'ctPGCa' OR c->>'contact_basis' IS DISTINCT FROM 'email_key'
  OR c->>'sender' IS DISTINCT FROM 'Fixture Owner A <owner.a@pgc.example.test>' OR c->>'subject' IS DISTINCT FROM 'Gate latch'
  OR (SELECT string_agg(x->>'job_number', ',') FROM jsonb_array_elements(c->'customer_jobs_at_message') x) IS DISTINCT FROM 'SWF-PGC01' THEN
  RAISE EXCEPTION 'placement contract: an email with no contact reads %', c;
 END IF;
 c := public.context_placement_grade_card('a7c00000-0000-4000-8008-000000000001', 'a7c00000-0000-4000-8000-0000000000b2');
 IF c->>'contact_basis' IS DISTINCT FROM 'row' THEN RAISE EXCEPTION 'placement contract: a row''s own contact reads %', c->>'contact_basis'; END IF;
 -- A Xero item: the invoice's own record, never the job a sync linked it to.
 c := public.context_placement_grade_card('a7c00000-0000-4000-8008-000000000005', 'a7c00000-0000-4000-8000-0000000000b1');
 IF c->>'lane' <> 'xero' OR c->'record'->>'kind' <> 'invoice' OR c->'record'->>'invoice_number' <> 'INV-PGC1'
  OR c->'record'->>'reference' <> 'SWF-PGC01 deposit' OR c->'record'->>'contact_name' <> 'Fixture Owner A'
  OR c->'record'->'lines' <> '["Deposit for the front fence"]'::jsonb OR (c->'record'->>'total')::numeric <> 1100
  OR c->'record' ? 'job_id' OR c::text LIKE '%direct_job_id%' THEN
  RAISE EXCEPTION 'placement contract: a Xero item reads %', c;
 END IF;
END $$;
ROLLBACK;

-- 9. The copy check and the misfile plan: the ladder's own judgement in preview, the copies already saved, writing nothing.
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE pgc_counts_before ON COMMIT DROP AS SELECT public.context_placement_misfile_counts('2031-03-20Z') AS c;
SELECT pg_temp.pg_jobs();
INSERT INTO public.business_events (id, job_id, event_type, source, channel, direction, contact_id, metadata, payload, occurred_at,
 recorded_at, context_captured_at, event_at, attribution_status, attribution_step, match_method, match_status, attribution_confidence,
 match_confidence, provider_message_id) VALUES
 -- The old text cache put these texts on the holding job, each naming the job it guessed.
 -- move: the customer's one live job at the time is the job named, and no other row holds the message.
 ('a7c00000-0000-4000-800a-000000000001', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"sender_role":"unknown","recipient_role":"staff","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCa","ghl_message_id":"pgc-m1","job_id":"a7c00000-0000-4000-8000-0000000000b1","body":"Thanks, see you Monday","direction":"inbound"}',
  '2031-03-01 02:00Z', '2031-03-01 02:05Z', '2031-03-01 02:05Z', '2031-03-01 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL),
 -- review: two live jobs at the time.
 ('a7c00000-0000-4000-800a-000000000002', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"sender_role":"unknown","recipient_role":"staff","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCb","ghl_message_id":"pgc-m2","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"Which day works?","direction":"inbound"}',
  '2031-03-02 02:00Z', '2031-03-02 02:05Z', '2031-03-02 02:05Z', '2031-03-02 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL),
 -- review, the ladder disagreeing: the customer's live job is not the job named (finished months before).
 ('a7c00000-0000-4000-800a-000000000003', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', 'sms', 'inbound', NULL,
  '{"party_roles":{"sender_role":"customer","recipient_role":"staff","audience":"customer"}}',
  '{"ghl_contact_id":"ctPGCc","ghl_message_id":"pgc-m3","job_id":"a7c00000-0000-4000-8000-0000000000b5","body":"Can you quote the side fence too?","direction":"inbound"}',
  '2031-03-03 02:00Z', '2031-03-03 02:05Z', '2031-03-03 02:05Z', '2031-03-03 02:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL),
 -- leave: a mismatch that is not on a holding job is never touched by this plan.
 ('a7c00000-0000-4000-800a-000000000004', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, 'ctPGCa',
  '{}', '{"ghl_contact_id":"ctPGCa","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"ok"}',
  '2031-03-04 02:00Z', '2031-03-04 02:05Z', '2031-03-04 02:05Z', '2031-03-04 02:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, NULL),
 -- duplicate, twin placed: the history load already saved this text under its ghl: key on the job named.
 ('a7c00000-0000-4000-800a-000000000005', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"sender_role":"unknown","recipient_role":"staff","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCa","ghl_message_id":"pgc-m5","job_id":"a7c00000-0000-4000-8000-0000000000b1","body":"See you at eight","direction":"inbound"}',
  '2031-03-01 03:00Z', '2031-03-01 03:05Z', '2031-03-01 03:05Z', '2031-03-01 03:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL),
 -- duplicate, twin queued: the keyed copy waits for review, so this one leaves the placeholder and every queue.
 ('a7c00000-0000-4000-800a-000000000006', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"sender_role":"unknown","recipient_role":"staff","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCb","ghl_message_id":"pgc-m6","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"Both quotes please","direction":"inbound"}',
  '2031-03-02 03:00Z', '2031-03-02 03:05Z', '2031-03-02 03:05Z', '2031-03-02 03:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL),
 -- review: another row names the same GHL id with other words, so it is not this message's twin.
 ('a7c00000-0000-4000-800a-000000000007', 'a7c00000-0000-4000-8000-0000000000b0', 'client.reply', 'ghl_sms_cache_backfill', NULL, NULL, NULL,
  '{"party_roles":{"sender_role":"unknown","recipient_role":"staff","audience":"unknown"}}',
  '{"ghl_contact_id":"ctPGCb","ghl_message_id":"pgc-m7","job_id":"a7c00000-0000-4000-8000-0000000000b2","body":"Call me back","direction":"inbound"}',
  '2031-03-02 04:00Z', '2031-03-02 04:05Z', '2031-03-02 04:05Z', '2031-03-02 04:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL),
 -- The twins: the history load's keyed rows (placed on b1, queued) and a key-less row with other words.
 ('a7c00000-0000-4000-800e-000000000005', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl-history-load', 'sms', 'inbound', 'ctPGCa',
  '{"capture_mode":"backfill"}', '{"body":"See you at eight"}',
  '2031-03-01 03:00Z', '2031-03-05 00:00Z', '2031-03-05 00:00Z', '2031-03-01 03:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, 'ghl:pgc-m5'),
 ('a7c00000-0000-4000-800e-000000000006', NULL, 'client.reply', 'ghl-history-load', 'sms', 'inbound', 'ctPGCb',
  '{"capture_mode":"backfill"}', '{"body":"Both quotes please"}',
  '2031-03-02 03:00Z', '2031-03-05 00:00Z', '2031-03-05 00:00Z', '2031-03-02 03:00Z', 'pending_luna', 5, 'none', 'unresolved', NULL, NULL, 'ghl:pgc-m6'),
 ('a7c00000-0000-4000-800e-000000000007', 'a7c00000-0000-4000-8000-0000000000b2', 'client.reply', 'ghl-proxy', 'sms', 'inbound', 'ctPGCb',
  '{}', '{"ghl_message_id":"pgc-m7","body":"Please call me back tomorrow"}',
  '2031-03-02 04:00Z', '2031-03-02 04:00Z', '2031-03-02 04:00Z', '2031-03-02 04:00Z', 'direct', 1, 'direct_job_id', 'matched', 1, 1, NULL),
 -- Outside the misfiles: a bucket row whose only twin is itself marked a copy of another row.
 ('a7c00000-0000-4000-800c-000000000009', NULL, 'client.reply', 'ghl-proxy', 'sms', 'inbound', 'ctPGCa',
  '{}', '{"ghl_message_id":"pgc-m9","body":"Hello there"}',
  '2031-03-03 05:00Z', '2031-03-03 05:00Z', '2031-03-03 05:00Z', '2031-03-03 05:00Z', 'admin_bucket', 6, 'none', 'unresolved', NULL, NULL, NULL),
 ('a7c00000-0000-4000-800e-000000000009', 'a7c00000-0000-4000-8000-0000000000b1', 'client.reply', 'ghl-history-load', 'sms', 'inbound', 'ctPGCa',
  '{"duplicate_of":"a7c00000-0000-4000-800e-000000000099"}', '{"body":"Hello there"}',
  '2031-03-03 05:00Z', '2031-03-05 00:00Z', '2031-03-05 00:00Z', '2031-03-03 05:00Z', 'single_open', 3, 'contact_id', 'matched', 1, 1, 'ghl:pgc-m9');
INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at, source_event_id) VALUES
 ('outlook:pgc-live-on-holding', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-03-01Z', 'a7c00000-0000-4000-800a-000000000001');
INSERT INTO public.event_threads (thread_key, job_id, bound_by, bound_at, source_event_id, retired_at, retired_reason) VALUES
 ('outlook:pgc-retired-on-holding', 'a7c00000-0000-4000-8000-0000000000b0', 'ladder', '2031-03-01Z', NULL, '2031-03-02Z', 'conflict');
SET LOCAL session_replication_role = origin;
CREATE TEMP TABLE pgc_before ON COMMIT DROP AS
 SELECT md5(string_agg(to_jsonb(b)::text, '|' ORDER BY b.id)) AS ev,
        (SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.thread_key COLLATE "C")) FROM public.event_threads t) AS th
 FROM public.business_events b;
SET LOCAL ROLE service_role;
DO $$
DECLARE r record; got text; e public.business_events;
BEGIN
 -- The copy check: the keyed row placed on the job, then the keyed row waiting; a row naming the same id with
 -- other words, a copy marked as one, a row on a holding job and the row itself never stand in.
 SELECT string_agg(right(b.id::text, 1) || ':' || coalesce(right(w.twin_id::text, 2), '-') || ':' || coalesce(w.twin_state, '-')
         || ':' || coalesce(w.twin_keyed::text, '-'), ',' ORDER BY b.id) INTO got
 FROM public.business_events b LEFT JOIN LATERAL public.context_placement_message_twin(b) w ON true
 WHERE b.id::text LIKE 'a7c00000-0000-4000-800a-%';
 IF got IS DISTINCT FROM '1:-:-:-,2:-:-:-,3:-:-:-,4:-:-:-,5:05:placed:true,6:06:queued:true,7:-:-:-' THEN
  RAISE EXCEPTION 'placement contract: the copy check reads %', got;
 END IF;
 SELECT * INTO e FROM public.business_events b WHERE b.id = 'a7c00000-0000-4000-800e-000000000005';
 IF (SELECT w.twin_id FROM public.context_placement_message_twin(e) w) IS NOT NULL THEN
  RAISE EXCEPTION 'placement contract: a copy on a holding job stood in for a placed row';
 END IF;
 SELECT * INTO e FROM public.business_events b WHERE b.id = 'a7c00000-0000-4000-800c-000000000009';
 IF (SELECT w.twin_id FROM public.context_placement_message_twin(e) w) IS NOT NULL THEN
  RAISE EXCEPTION 'placement contract: a row marked a copy stood in for another';
 END IF;
 SELECT string_agg(right(p.event_id::text, 1) || ':' || p.plan || ':' || coalesce(right(p.to_job_id::text, 2), '-') || ':'
         || coalesce((SELECT string_agg(right(x::text, 2), '+' ORDER BY x) FROM unnest(p.candidate_job_ids) x), '-') || ':'
         || coalesce(right(p.duplicate_of::text, 2), '-') || ':' || p.set_aside_payload_job::text || ':'
         || coalesce(p.contact_id, '-') || ':' || coalesce(p.decided->>'attribution_status', '-') || ':' || coalesce(p.decided->>'placement_rule', '-'),
         ',' ORDER BY p.event_id)
 INTO got FROM public.context_placement_misfile_plan() p WHERE p.event_id::text LIKE 'a7c00000-0000-4000-800a-%';
 IF got IS DISTINCT FROM '1:move:b1:-:-:false:ctPGCa:single_open:single_open,'
   '2:review:-:b2+b3:-:true:ctPGCb:unplaced:review_several,'
   '3:review:-:b4+b5:-:true:ctPGCc:single_open:single_open,'
   '4:leave_not_on_holding_job:-:-:-:false:ctPGCa:-:-,'
   '5:duplicate:b1:-:05:false:ctPGCa:single_open:single_open,'
   '6:duplicate:-:-:06:true:ctPGCb:unplaced:review_several,'
   '7:review:-:b2+b3:-:true:ctPGCb:unplaced:review_several' THEN
  RAISE EXCEPTION 'placement contract: the misfile plan is %', got;
 END IF;
 SELECT * INTO r FROM public.context_placement_misfile_plan() p WHERE p.event_id = 'a7c00000-0000-4000-800a-000000000001';
 IF r.from_job_id <> 'a7c00000-0000-4000-8000-0000000000b0' OR r.payload_job_id <> 'a7c00000-0000-4000-8000-0000000000b1'
  OR r.mismatch_class <> 'not_contact_rule' OR NOT r.on_holding_job
  OR r.decided->>'match_method' <> 'contact_id' OR (r.decided->>'attribution_step')::int <> 3
  OR NOT (r.decided->>'payload_job_guess')::boolean OR r.decided->'job_id' IS DISTINCT FROM to_jsonb('a7c00000-0000-4000-8000-0000000000b1'::text)
  OR r.decided->'twin' IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'placement contract: the move row reads %', to_jsonb(r);
 END IF;
 SELECT * INTO r FROM public.context_placement_misfile_plan() p WHERE p.event_id = 'a7c00000-0000-4000-800a-000000000006';
 IF r.decided->'twin'->>'id' <> 'a7c00000-0000-4000-800e-000000000006' OR r.decided->'twin'->>'state' <> 'queued'
  OR r.decided->'twin'->>'source' <> 'ghl-history-load' OR r.to_job_id IS NOT NULL THEN
  RAISE EXCEPTION 'placement contract: the queued-twin row reads %', to_jsonb(r);
 END IF;
END $$;
RESET ROLE;
DO $$
DECLARE c jsonb; b jsonb := (SELECT x.c FROM pgc_counts_before x);
BEGIN
 -- Writing nothing: every business row and binding is byte for byte as it was.
 IF (SELECT md5(string_agg(to_jsonb(e)::text, '|' ORDER BY e.id)) FROM public.business_events e) IS DISTINCT FROM (SELECT ev FROM pgc_before)
  OR (SELECT md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.thread_key COLLATE "C")) FROM public.event_threads t) IS DISTINCT FROM (SELECT th FROM pgc_before) THEN
  RAISE EXCEPTION 'placement contract: the misfile plan wrote a row';
 END IF;
 -- The counts move by exactly the fixtures: six misfiles on the holding job, one elsewhere, one customer-facing
 -- row on it in the 30 days, one live binding to it.
 c := public.context_placement_misfile_counts('2031-03-20Z');
 IF (c->>'payload_mismatch')::int - (b->>'payload_mismatch')::int <> 7
  OR (c->>'payload_mismatch_on_holding_job')::int - (b->>'payload_mismatch_on_holding_job')::int <> 6
  OR (c->>'holding_jobs')::int - (b->>'holding_jobs')::int <> 1
  OR (c->>'on_holding_job')::int - (b->>'on_holding_job')::int <> 6
  OR (c->>'on_holding_job_customer_facing_30d')::int - (b->>'on_holding_job_customer_facing_30d')::int <> 1
  OR (c->>'live_bindings_to_holding_job')::int - (b->>'live_bindings_to_holding_job')::int <> 1
  OR (c->'payload_mismatch_by_class'->>'not_contact_rule')::int - coalesce((b->'payload_mismatch_by_class'->>'not_contact_rule')::int, 0) <> 6
  OR (c->'payload_mismatch_by_class'->>'payload_job_guess')::int - coalesce((b->'payload_mismatch_by_class'->>'payload_job_guess')::int, 0) <> 1 THEN
  RAISE EXCEPTION 'placement contract: the misfile counts moved % from %', c, b;
 END IF;
END $$;
ROLLBACK;

-- 10. Re-apply is a no-op: the same bodies, a stored grade kept.
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT pg_temp.pg_jobs();
SET LOCAL session_replication_role = origin;
SELECT pg_temp.pg_insert('{}'::jsonb);
CREATE TEMP TABLE pgc_bodies ON COMMIT DROP AS
 SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'context_placement_%';
\ir ../../../migrations/20261007070000_context_placement_grades.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM public.context_placement_grades WHERE event_id = 'a7c00000-0000-4000-8000-0000000000e1') <> 1 THEN
  RAISE EXCEPTION 'placement contract: a re-apply lost a stored grade';
 END IF;
 IF (SELECT count(*) FROM pgc_bodies) <> 10 OR EXISTS (SELECT 1 FROM pgc_bodies b JOIN pg_proc p ON p.oid = to_regprocedure(b.sig)
     WHERE md5(p.prosrc) <> b.body) THEN
  RAISE EXCEPTION 'placement contract: a re-apply moved a body';
 END IF;
END $$;
ROLLBACK;
