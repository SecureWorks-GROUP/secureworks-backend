-- Contract for 20261006080000_context_jev_decisions: the Jev shadow log, its
-- agreement read and its calls-today read. Every fixture write is rolled back.
-- Ids are made up; no row holds words.

-- 1. Shape: the table, its exact columns, RLS on, its indexes, the two
-- functions with this migration's comments, and the flag row created off.
DO $$
DECLARE cols text;
BEGIN
 IF to_regclass('public.context_jev_decisions') IS NULL THEN RAISE EXCEPTION 'jev contract: context_jev_decisions is missing'; END IF;
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_jev_decisions'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'id:uuid,decision_point:text,job_id:uuid,row_table:text,row_id:uuid,requested_model:text,model:text,'
   'jev_outcome:text,jev_job_id:uuid,jev_confidence:numeric(5,4),jev_answer:jsonb,current_outcome:text,current_job_id:uuid,'
   'current_answer:jsonb,latency_ms:integer,input_tokens:integer,output_tokens:integer,attempts:smallint,error_code:text,'
   'created_at:timestamp with time zone' THEN
  RAISE EXCEPTION 'jev contract: unexpected columns %', cols;
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_jev_decisions'::regclass) THEN
  RAISE EXCEPTION 'jev contract: row level security is off';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.context_jev_decisions'::regclass) THEN
  RAISE EXCEPTION 'jev contract: the log carries a policy';
 END IF;
 IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'context_jev_decisions'
     AND indexname IN ('context_jev_decisions_point_time', 'context_jev_decisions_time', 'context_jev_decisions_job', 'context_jev_decisions_row')) <> 4 THEN
  RAISE EXCEPTION 'jev contract: an index is missing';
 END IF;
 IF coalesce(obj_description(to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)'), 'pg_proc'), '') NOT LIKE 'Context Jev decisions (20261006080000)%'
  OR coalesce(obj_description(to_regprocedure('public.context_jev_calls_today()'), 'pg_proc'), '') NOT LIKE 'Context Jev decisions (20261006080000)%' THEN
  RAISE EXCEPTION 'jev contract: a function is missing or not this migration''s';
 END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1') <> 1
  OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1') IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'jev contract: the flag row is not exactly one row created off';
 END IF;
END $$;

-- 2. Access: service role reads and inserts the log and nothing else; anon and
-- authenticated may do nothing; the two reads are service role only.
DO $$
DECLARE r text; p text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
   IF has_table_privilege(r, 'public.context_jev_decisions', p) THEN RAISE EXCEPTION 'jev contract: % may % the log', r, p; END IF;
  END LOOP;
  IF has_function_privilege(r, 'public.context_jev_agreement(timestamptz,timestamptz)', 'EXECUTE')
   OR has_function_privilege(r, 'public.context_jev_calls_today()', 'EXECUTE') THEN
   RAISE EXCEPTION 'jev contract: % may run a Jev read', r;
  END IF;
 END LOOP;
 IF NOT has_table_privilege('service_role', 'public.context_jev_decisions', 'SELECT')
  OR NOT has_table_privilege('service_role', 'public.context_jev_decisions', 'INSERT') THEN
  RAISE EXCEPTION 'jev contract: service_role cannot read and insert the log';
 END IF;
 FOREACH p IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
  IF has_table_privilege('service_role', 'public.context_jev_decisions', p) THEN RAISE EXCEPTION 'jev contract: service_role may % the log', p; END IF;
 END LOOP;
 IF NOT has_function_privilege('service_role', 'public.context_jev_agreement(timestamptz,timestamptz)', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'public.context_jev_calls_today()', 'EXECUTE') THEN
  RAISE EXCEPTION 'jev contract: service_role cannot run the Jev reads';
 END IF;
END $$;

-- An insert of one row as built by the worker: answer fields by default, any field overridden by p.
CREATE FUNCTION pg_temp.jv_row(p jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('decision_point', 'ledger_update_gate', 'job_id', '0f000000-0000-4000-8000-0000000000a1',
  'requested_model', 'jev-1.13.0', 'model', 'jev-1.13.0', 'jev_outcome', 'no_change', 'jev_confidence', 0.95,
  'jev_answer', '{"nouls":{"opens":0.02}}'::jsonb, 'current_outcome', 'no_change', 'current_answer', '{"items":0}'::jsonb,
  'latency_ms', 310, 'input_tokens', 812, 'output_tokens', 20, 'attempts', 1) || p
$$;
CREATE FUNCTION pg_temp.jv_insert(p jsonb) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.context_jev_decisions (decision_point, job_id, row_table, row_id, requested_model, model, jev_outcome, jev_job_id,
  jev_confidence, jev_answer, current_outcome, current_job_id, current_answer, latency_ms, input_tokens, output_tokens, attempts, error_code, created_at)
 SELECT r.decision_point, r.job_id, r.row_table, r.row_id, r.requested_model, r.model, r.jev_outcome, r.jev_job_id, r.jev_confidence,
  coalesce(r.jev_answer, '{}'::jsonb), r.current_outcome, r.current_job_id, coalesce(r.current_answer, '{}'::jsonb), r.latency_ms, r.input_tokens,
  r.output_tokens, coalesce(r.attempts, 1), r.error_code, coalesce(r.created_at, now())
 FROM jsonb_populate_record(NULL::public.context_jev_decisions, pg_temp.jv_row(p)) r
 RETURNING id
$$;
-- The SQLSTATE an insert fails with, or null when it is taken (and then undone).
CREATE FUNCTION pg_temp.jv_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  PERFORM pg_temp.jv_insert(p);
  RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'taken';
 EXCEPTION WHEN SQLSTATE 'P0099' THEN RETURN NULL;
 WHEN OTHERS THEN RETURN SQLSTATE;
 END;
END $$;

-- 3. The checks keep words, wrong outcomes and half answers out of the log.
DO $$
DECLARE c record; got text;
BEGIN
 IF pg_temp.jv_refused('{}'::jsonb) IS NOT NULL THEN RAISE EXCEPTION 'jev contract: a well formed gate row is refused'; END IF;
 IF pg_temp.jv_refused(jsonb_build_object('decision_point', 'placement', 'job_id', NULL, 'row_table', 'business_events',
   'row_id', '0f000000-0000-4000-8000-0000000000b1', 'jev_outcome', 'job', 'jev_job_id', '0f000000-0000-4000-8000-0000000000c1',
   'current_outcome', 'none')) IS NOT NULL THEN
  RAISE EXCEPTION 'jev contract: a well formed placement row is refused';
 END IF;
 IF pg_temp.jv_refused(jsonb_build_object('jev_outcome', NULL, 'jev_confidence', NULL, 'model', NULL, 'error_code', 'jev_timeout', 'attempts', 3))
  IS NOT NULL THEN
  RAISE EXCEPTION 'jev contract: a well formed failure row is refused';
 END IF;
 FOR c IN SELECT * FROM (VALUES
  ('an unknown decision point', '{"decision_point":"triage"}'),
  ('a placement on an inbox row', '{"decision_point":"placement","row_table":"inbox_events","row_id":"0f000000-0000-4000-8000-0000000000b1","jev_outcome":"none","current_outcome":"none"}'),
  ('a placement with no row', '{"decision_point":"placement","jev_outcome":"none","current_outcome":"none"}'),
  ('a gate with no job', '{"job_id":null,"row_table":"business_events","row_id":"0f000000-0000-4000-8000-0000000000b1"}'),
  ('a reply owed with no row', '{"decision_point":"ledger_reply_owed","jev_outcome":"owed","current_outcome":"owed"}'),
  ('a gate answer on a placement', '{"decision_point":"placement","row_table":"business_events","row_id":"0f000000-0000-4000-8000-0000000000b1","current_outcome":"none"}'),
  ('a reply answer as the gate''s current answer', '{"current_outcome":"owed"}'),
  ('a job pick with no job', '{"decision_point":"placement","row_table":"business_events","row_id":"0f000000-0000-4000-8000-0000000000b1","jev_outcome":"job","current_outcome":"none"}'),
  ('a job id on a pick of none', '{"decision_point":"placement","row_table":"business_events","row_id":"0f000000-0000-4000-8000-0000000000b1","jev_outcome":"none","jev_job_id":"0f000000-0000-4000-8000-0000000000c1","current_outcome":"none"}'),
  ('today''s job with no job id', '{"decision_point":"placement","row_table":"business_events","row_id":"0f000000-0000-4000-8000-0000000000b1","jev_outcome":"none","current_outcome":"job"}'),
  ('an answer and an error', '{"error_code":"jev_timeout"}'),
  ('neither an answer nor an error', '{"jev_outcome":null,"jev_confidence":null}'),
  ('an answer with no confidence', '{"jev_confidence":null}'),
  ('a confidence above 1', '{"jev_confidence":1.5}'),
  ('an answer with no model', '{"model":null}'),
  ('an answer that is not an object', '{"jev_answer":["words"]}'),
  ('an answer over 8 kB', jsonb_build_object('jev_answer', jsonb_build_object('pad', repeat('x', 9000)))::text),
  ('a malformed requested model', '{"requested_model":"Jev Latest!"}'),
  ('a malformed error code', '{"jev_outcome":null,"jev_confidence":null,"error_code":"Timed out!"}'),
  ('zero attempts', '{"attempts":0}'),
  ('a negative latency', '{"latency_ms":-1}'),
  ('a row table with no row id', '{"row_table":"business_events"}')
 ) v(label, body) LOOP
  got := pg_temp.jv_refused(c.body::jsonb);
  IF got IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'jev contract: % was not refused by a check (got %)', c.label, coalesce(got, 'taken'); END IF;
 END LOOP;
END $$;

-- 4. Roles at work: anon and authenticated are refused; service_role inserts and reads but never updates or deletes.
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_temp.jv_insert('{}'::jsonb) IS NOT NULL AS service_role_inserted \gset
DO $$
BEGIN
 IF (SELECT count(*) FROM public.context_jev_decisions) <> 1 THEN RAISE EXCEPTION 'jev contract: service_role cannot read its own row'; END IF;
 BEGIN
  UPDATE public.context_jev_decisions SET attempts = 2;
  RAISE EXCEPTION 'jev contract: service_role updated the log';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  DELETE FROM public.context_jev_decisions;
  RAISE EXCEPTION 'jev contract: service_role deleted from the log';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 PERFORM * FROM public.context_jev_agreement();
 PERFORM public.context_jev_calls_today();
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
 BEGIN
  PERFORM pg_temp.jv_insert('{}'::jsonb);
  RAISE EXCEPTION 'jev contract: authenticated wrote the log';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM 1 FROM public.context_jev_decisions;
  RAISE EXCEPTION 'jev contract: authenticated read the log';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM * FROM public.context_jev_agreement();
  RAISE EXCEPTION 'jev contract: authenticated ran the agreement read';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE anon;
DO $$
BEGIN
 BEGIN
  PERFORM pg_temp.jv_insert('{}'::jsonb);
  RAISE EXCEPTION 'jev contract: anon wrote the log';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM public.context_jev_calls_today();
  RAISE EXCEPTION 'jev contract: anon ran the calls read';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;

-- 5. Agreement by decision point and confidence band, over a fixed window. The
-- fixture: placements (P), gate reads (G) and reply-owed candidates (R).
BEGIN;
DO $$
DECLARE
 t0 timestamptz := '2026-10-01 00:00:00+00'; t1 timestamptz := '2026-10-02 00:00:00+00';
 j1 text := '0f000000-0000-4000-8000-0000000000c1'; j2 text := '0f000000-0000-4000-8000-0000000000c2';
 pl jsonb := '{"decision_point":"placement","job_id":null,"row_table":"business_events","row_id":"0f000000-0000-4000-8000-0000000000b1"}';
 rp jsonb := '{"decision_point":"ledger_reply_owed","row_table":"business_events","row_id":"0f000000-0000-4000-8000-0000000000b2"}';
 got record; expected jsonb; actual jsonb;
BEGIN
 -- P1 agreed; P2 another job (unsafe); P3 none and none; P4 Jev places where Luna did not (unsafe); P5 several and
 -- several; P6 Jev says none where Luna placed (not unsafe); P7 failed; P8 answered with no current answer; P9 and P10
 -- outside the window.
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'job', 'jev_job_id', j1, 'jev_confidence', 0.95, 'current_outcome', 'job', 'current_job_id', j1, 'created_at', t0));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'job', 'jev_job_id', j1, 'jev_confidence', 0.92, 'current_outcome', 'job', 'current_job_id', j2, 'created_at', t0 + interval '1 minute'));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'none', 'jev_confidence', 0.85, 'current_outcome', 'none', 'created_at', t0 + interval '2 minutes'));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'job', 'jev_job_id', j1, 'jev_confidence', 0.60, 'current_outcome', 'none', 'created_at', t0 + interval '3 minutes'));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'several', 'jev_confidence', 0.30, 'current_outcome', 'several', 'created_at', t0 + interval '4 minutes'));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'none', 'jev_confidence', 0.95, 'current_outcome', 'job', 'current_job_id', j1, 'created_at', t0 + interval '5 minutes'));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', NULL, 'jev_confidence', NULL, 'model', NULL, 'error_code', 'jev_timeout', 'current_outcome', 'none', 'created_at', t0 + interval '6 minutes'));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'job', 'jev_job_id', j1, 'jev_confidence', 0.99, 'current_outcome', NULL, 'created_at', t0 + interval '7 minutes'));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'job', 'jev_job_id', j1, 'jev_confidence', 0.95, 'current_outcome', 'job', 'current_job_id', j2, 'created_at', t1));
 PERFORM pg_temp.jv_insert(pl || jsonb_build_object('jev_outcome', 'job', 'jev_job_id', j1, 'jev_confidence', 0.95, 'current_outcome', 'job', 'current_job_id', j2, 'created_at', t0 - interval '1 microsecond'));
 -- G1 a safe skip; G2 an unsafe skip; G3 read and changed, at the 0.50 boundary; G4 read for nothing; G5 overloaded.
 PERFORM pg_temp.jv_insert(jsonb_build_object('jev_outcome', 'no_change', 'jev_confidence', 0.96, 'current_outcome', 'no_change', 'created_at', t0));
 PERFORM pg_temp.jv_insert(jsonb_build_object('jev_outcome', 'no_change', 'jev_confidence', 0.91, 'current_outcome', 'change', 'created_at', t0));
 PERFORM pg_temp.jv_insert(jsonb_build_object('jev_outcome', 'change', 'jev_confidence', 0.50, 'current_outcome', 'change', 'created_at', t0));
 PERFORM pg_temp.jv_insert(jsonb_build_object('jev_outcome', 'change', 'jev_confidence', 0.20, 'current_outcome', 'no_change', 'created_at', t0));
 PERFORM pg_temp.jv_insert(jsonb_build_object('jev_outcome', NULL, 'jev_confidence', NULL, 'model', NULL, 'error_code', 'jev_http_529', 'created_at', t0));
 -- R1 an owed reply called not owed (unsafe), at the 0.90 boundary; R2 agreed at the 0.80 boundary; R3 agreed just under 0.50.
 PERFORM pg_temp.jv_insert(rp || jsonb_build_object('jev_outcome', 'not_owed', 'jev_confidence', 0.90, 'current_outcome', 'owed', 'created_at', t0));
 PERFORM pg_temp.jv_insert(rp || jsonb_build_object('jev_outcome', 'owed', 'jev_confidence', 0.80, 'current_outcome', 'owed', 'created_at', t0));
 PERFORM pg_temp.jv_insert(rp || jsonb_build_object('jev_outcome', 'not_owed', 'jev_confidence', 0.4999, 'current_outcome', 'not_owed', 'created_at', t0));

 SELECT jsonb_agg(jsonb_build_array(a.decision_point, a.confidence_band, a.answered, a.compared, a.agreed, a.agreement, a.unsafe, a.failed, a.pairs)
  ORDER BY n) INTO actual
 FROM (SELECT x.*, row_number() OVER () AS n FROM public.context_jev_agreement(t0, t1) x) a;
 expected := '[
  ["placement","all",7,6,3,0.5000,2,1,{"job>job":1,"job>none":1,"job>other_job":1,"none>job":1,"none>none":1,"several>several":1}],
  ["placement","0.90-1.00",4,3,1,0.3333,1,0,{"job>job":1,"job>other_job":1,"none>job":1}],
  ["placement","0.80-0.90",1,1,1,1.0000,0,0,{"none>none":1}],
  ["placement","0.50-0.80",1,1,0,0.0000,1,0,{"job>none":1}],
  ["placement","0.00-0.50",1,1,1,1.0000,0,0,{"several>several":1}],
  ["ledger_update_gate","all",4,4,2,0.5000,1,1,{"change>change":1,"change>no_change":1,"no_change>change":1,"no_change>no_change":1}],
  ["ledger_update_gate","0.90-1.00",2,2,1,0.5000,1,0,{"no_change>change":1,"no_change>no_change":1}],
  ["ledger_update_gate","0.80-0.90",0,0,0,null,0,0,{}],
  ["ledger_update_gate","0.50-0.80",1,1,1,1.0000,0,0,{"change>change":1}],
  ["ledger_update_gate","0.00-0.50",1,1,0,0.0000,0,0,{"change>no_change":1}],
  ["ledger_reply_owed","all",3,3,2,0.6667,1,0,{"not_owed>not_owed":1,"not_owed>owed":1,"owed>owed":1}],
  ["ledger_reply_owed","0.90-1.00",1,1,0,0.0000,1,0,{"not_owed>owed":1}],
  ["ledger_reply_owed","0.80-0.90",1,1,1,1.0000,0,0,{"owed>owed":1}],
  ["ledger_reply_owed","0.50-0.80",0,0,0,null,0,0,{}],
  ["ledger_reply_owed","0.00-0.50",1,1,1,1.0000,0,0,{"not_owed>not_owed":1}]
 ]'::jsonb;
 IF actual IS DISTINCT FROM expected THEN
  FOR got IN SELECT e.value AS want, a.value AS have FROM jsonb_array_elements(expected) WITH ORDINALITY e(value, n)
   FULL JOIN jsonb_array_elements(actual) WITH ORDINALITY a(value, n) ON a.n = e.n WHERE e.value IS DISTINCT FROM a.value LOOP
   RAISE NOTICE 'want % have %', got.want, got.have;
  END LOOP;
  IF actual->1->6 IS DISTINCT FROM expected->1->6 OR actual->1->4 IS DISTINCT FROM expected->1->4 THEN
   RAISE EXCEPTION 'jev contract: a placement on another job is counted as agreed';
  END IF;
  RAISE EXCEPTION 'jev contract: the agreement read is wrong';
 END IF;
END $$;
ROLLBACK;

-- 6. The default window is the 14 days before now; the calls read counts attempts since Perth midnight only.
BEGIN;
DO $$
DECLARE midnight timestamptz := ((now() AT TIME ZONE 'Australia/Perth')::date)::timestamp AT TIME ZONE 'Australia/Perth'; got jsonb; n bigint;
BEGIN
 PERFORM pg_temp.jv_insert(jsonb_build_object('created_at', now() - interval '13 days'));
 PERFORM pg_temp.jv_insert(jsonb_build_object('created_at', now() - interval '15 days'));
 SELECT a.answered INTO n FROM public.context_jev_agreement() a WHERE a.decision_point = 'ledger_update_gate' AND a.confidence_band = 'all';
 IF n IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'jev contract: the default window is not the last 14 days (answered %)', n; END IF;
 DELETE FROM public.context_jev_decisions;
 PERFORM pg_temp.jv_insert(jsonb_build_object('attempts', 1, 'created_at', midnight));
 PERFORM pg_temp.jv_insert(jsonb_build_object('jev_outcome', NULL, 'jev_confidence', NULL, 'model', NULL, 'error_code', 'jev_timeout', 'attempts', 3, 'created_at', now()));
 PERFORM pg_temp.jv_insert(jsonb_build_object('attempts', 2, 'created_at', midnight - interval '1 microsecond'));
 got := public.context_jev_calls_today();
 IF got->>'calls' IS DISTINCT FROM '4' OR got->>'decisions' IS DISTINCT FROM '2'
  OR got->>'perth_date' IS DISTINCT FROM ((now() AT TIME ZONE 'Australia/Perth')::date)::text THEN
  RAISE EXCEPTION 'jev contract: calls today is %', got;
 END IF;
END $$;
ROLLBACK;
