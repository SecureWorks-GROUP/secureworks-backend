-- Contract for 20261007090000_context_grades: the published catalogue of
-- ledger item kinds, the grades table, its verdict check and pass rule, and
-- the two reads. Every fixture write is rolled back and every time is pinned,
-- so nothing here reads the wall clock. Ids are made up; no row holds words.

-- 1. Shape: the table, its exact columns and constraints, RLS on with no
-- policy and no trigger, its indexes, and the five functions with this
-- migration's comments, volatility and settings.
DO $$
DECLARE cols text; x record;
BEGIN
 IF to_regclass('public.context_grades') IS NULL THEN RAISE EXCEPTION 'grades contract: context_grades is missing'; END IF;
 SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM 'id:uuid,kind:text,sample_id:text,job_id:uuid,unit:text,generation_id:uuid,reading_model:text,'
   'item_type:text,stratum:text,gated:boolean,verdicts:jsonb,grader:text,as_of:timestamp with time zone,'
   'graded_at:timestamp with time zone,created_at:timestamp with time zone' THEN
  RAISE EXCEPTION 'grades contract: unexpected columns %', cols;
 END IF;
 SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid = 'public.context_grades'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull;
 IF cols IS DISTINCT FROM 'id,kind,sample_id,job_id,unit,gated,verdicts,grader,as_of,graded_at,created_at' THEN
  RAISE EXCEPTION 'grades contract: unexpected not-null columns %', cols;
 END IF;
 SELECT string_agg(c.conname || ':' || c.contype::text, ',' ORDER BY c.conname COLLATE "C") INTO cols
 FROM pg_constraint c WHERE c.conrelid = 'public.context_grades'::regclass;
 IF cols IS DISTINCT FROM 'context_grades_grader:c,context_grades_item_type:c,context_grades_job_id_fkey:f,context_grades_kind:c,'
   'context_grades_pkey:p,context_grades_reading:c,context_grades_sample_id:c,context_grades_stratum:c,context_grades_times:c,'
   'context_grades_unit:c,context_grades_unit_once:u,context_grades_verdicts:c' THEN
  RAISE EXCEPTION 'grades contract: unexpected constraints %', cols;
 END IF;
 IF (SELECT confrelid FROM pg_constraint WHERE conname = 'context_grades_job_id_fkey' AND conrelid = 'public.context_grades'::regclass)
    IS DISTINCT FROM 'public.jobs'::regclass THEN
  RAISE EXCEPTION 'grades contract: job_id does not reference jobs';
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_grades'::regclass) THEN
  RAISE EXCEPTION 'grades contract: row level security is off';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.context_grades'::regclass) THEN
  RAISE EXCEPTION 'grades contract: the table carries a policy';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.context_grades'::regclass AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'grades contract: the table carries a trigger';
 END IF;
 IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'context_grades'
     AND indexname IN ('context_grades_job', 'context_grades_kind_graded')) <> 2 THEN
  RAISE EXCEPTION 'grades contract: an index is missing';
 END IF;
 IF coalesce(obj_description('public.context_grades'::regclass, 'pg_class'), '') NOT LIKE 'Context grades (20261007090000)%' THEN
  RAISE EXCEPTION 'grades contract: the table comment is not this migration''s';
 END IF;
 FOR x IN SELECT * FROM (VALUES
   ('public.context_item_kinds()', 's', true),
   ('public.context_grade_verdicts_problem(text,text,jsonb)', 'i', false),
   ('public.context_grade_passed(text,text,jsonb)', 'i', false),
   ('public.context_grade_samples(timestamptz)', 's', true),
   ('public.context_grades_newest(timestamptz)', 's', true)) AS v(sig, vol, has_path) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN RAISE EXCEPTION 'grades contract: % is missing', x.sig; END IF;
  IF coalesce(obj_description(to_regprocedure(x.sig), 'pg_proc'), '') NOT LIKE 'Context grades (20261007090000)%' THEN
   RAISE EXCEPTION 'grades contract: % is not this migration''s', x.sig;
  END IF;
  IF (SELECT p.provolatile::text FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)) IS DISTINCT FROM x.vol
   OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig))
   OR ((SELECT p.proconfig FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)) IS NOT NULL) IS DISTINCT FROM x.has_path THEN
   RAISE EXCEPTION 'grades contract: % has the wrong volatility, security or settings', x.sig;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
     AND p.proname IN ('context_item_kinds', 'context_grade_verdicts_problem', 'context_grade_passed',
                       'context_grade_samples', 'context_grades_newest')) <> 5 THEN
  RAISE EXCEPTION 'grades contract: a function has a second overload';
 END IF;
END $$;

-- 2. Access: the service role reads and inserts the grades and runs the five
-- functions; it may not change or delete a grade; anon, authenticated and
-- PUBLIC may do nothing.
DO $$
DECLARE r text; p text; f text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
   IF has_table_privilege(r, 'public.context_grades', p) THEN RAISE EXCEPTION 'grades contract: % may % the grades', r, p; END IF;
  END LOOP;
 END LOOP;
 IF NOT has_table_privilege('service_role', 'public.context_grades', 'SELECT')
  OR NOT has_table_privilege('service_role', 'public.context_grades', 'INSERT') THEN
  RAISE EXCEPTION 'grades contract: service_role cannot read and insert the grades';
 END IF;
 FOREACH p IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE'] LOOP
  IF has_table_privilege('service_role', 'public.context_grades', p) THEN RAISE EXCEPTION 'grades contract: service_role may % the grades', p; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.context_item_kinds()', 'public.context_grade_verdicts_problem(text,text,jsonb)',
   'public.context_grade_passed(text,text,jsonb)', 'public.context_grade_samples(timestamptz)', 'public.context_grades_newest(timestamptz)'] LOOP
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
   RAISE EXCEPTION 'grades contract: anon or authenticated may run %', f;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc pr CROSS JOIN LATERAL aclexplode(pr.proacl) a
             WHERE pr.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
   OR (SELECT pr.proacl FROM pg_proc pr WHERE pr.oid = to_regprocedure(f)) IS NULL THEN
   RAISE EXCEPTION 'grades contract: PUBLIC may run %', f;
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN RAISE EXCEPTION 'grades contract: service_role cannot run %', f; END IF;
 END LOOP;
END $$;

-- 3. The catalogue: every kind the store accepts, each with its meaning, in
-- order; it is exactly the store's own check, and the store's item check
-- agrees with each kind's statuses and needs.
DO $$
DECLARE got text; want text; x record; chk jsonb;
BEGIN
 SELECT string_agg(k.item_type || ':' || k.ord || ':' || k.accepted || ':' || array_to_string(k.statuses, '/') || ':'
                   || array_to_string(k.needs, '/'), ',' ORDER BY k.ord) INTO got
 FROM public.context_item_kinds() k;
 want := 'commitment:1:true:open/closed/declined/superseded:,request:2:true:open/closed/declined/superseded:,'
  'claim:3:true:open/closed/declined/superseded:,issue:4:true:open/closed/declined/superseded:,'
  'constraint:5:true:open/closed/declined/superseded:,dependency:6:true:open/closed/declined/superseded:,'
  'agreement:7:true:open/closed/declined/superseded/info:modality,event:8:true:info:,phase_note:9:true:info:phase';
 IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'grades contract: the catalogue is %', got; END IF;
 IF EXISTS (SELECT 1 FROM public.context_item_kinds() k
            WHERE k.meaning IS NULL OR length(k.meaning) NOT BETWEEN 40 AND 300
               OR position(chr(8212) IN k.meaning) > 0 OR position(chr(8211) IN k.meaning) > 0) THEN
  RAISE EXCEPTION 'grades contract: a meaning is missing, the wrong length, or carries a dash staff must not see';
 END IF;
 -- Exactly the store's check: the IN list on context_ledger_items.item_type, kind for kind.
 SELECT string_agg(m[1], ',' ORDER BY m[1] COLLATE "C") INTO got
 FROM pg_constraint c CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') AS m
 WHERE c.conrelid = 'public.context_ledger_items'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%item_type = ANY%';
 SELECT string_agg(k.item_type, ',' ORDER BY k.item_type COLLATE "C") INTO want FROM public.context_item_kinds() k;
 IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'grades contract: the catalogue (%) is not the store''s check (%)', want, got; END IF;
 -- The store's item check (20261006013000) on a person's citation-free item: a kind takes open exactly when
 -- the catalogue lists open, and info exactly when it lists info; the needed field is needed.
 FOR x IN SELECT k.item_type, s.status, s.status = ANY (k.statuses) AS listed, k.needs
          FROM public.context_item_kinds() k CROSS JOIN (VALUES ('open'), ('info')) AS s(status) LOOP
  chk := public.context_ledger_check_item('0f000000-0000-4000-8000-0000000000a1'::uuid,
   jsonb_build_object('item_type', x.item_type, 'status', x.status, 'from_role', 'customer', 'what', 'a made up line')
   || CASE WHEN 'modality' = ANY (x.needs) THEN '{"modality": "agreed"}'::jsonb ELSE '{}'::jsonb END
   || CASE WHEN 'phase' = ANY (x.needs) THEN '{"phase": "quote"}'::jsonb ELSE '{}'::jsonb END,
   'person', '0f000000-0000-4000-8000-0000000000e1'::uuid, 'a made up note');
  IF (chk ->> 'ok')::boolean IS DISTINCT FROM x.listed THEN
   RAISE EXCEPTION 'grades contract: the store answers % for % %, the catalogue says %', chk - 'item', x.item_type, x.status, x.listed;
  END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES ('agreement', 'open', 'modality'), ('phase_note', 'info', 'phase')) AS v(item_type, status, field) LOOP
  chk := public.context_ledger_check_item('0f000000-0000-4000-8000-0000000000a1'::uuid,
   jsonb_build_object('item_type', x.item_type, 'status', x.status, 'from_role', 'customer', 'what', 'a made up line'),
   'person', '0f000000-0000-4000-8000-0000000000e1'::uuid, 'a made up note');
  IF (chk ->> 'ok')::boolean OR chk ->> 'detail' IS DISTINCT FROM x.field THEN
   RAISE EXCEPTION 'grades contract: % without its % is not refused for it (%)', x.item_type, x.field, chk - 'item';
  END IF;
 END LOOP;
 chk := public.context_ledger_check_item('0f000000-0000-4000-8000-0000000000a1'::uuid,
  '{"item_type": "promise", "status": "open", "from_role": "customer", "what": "a made up line"}'::jsonb,
  'person', '0f000000-0000-4000-8000-0000000000e1'::uuid, 'a made up note');
 IF (chk ->> 'ok')::boolean OR chk ->> 'detail' IS DISTINCT FROM 'item_type' THEN
  RAISE EXCEPTION 'grades contract: the store takes a kind the catalogue does not list (%)', chk - 'item';
 END IF;
END $$;

-- 3b. The catalogue reads the store live: a kind the store starts accepting is
-- listed with no meaning, one it stops accepting is listed not accepted, and a
-- check that is not an IN list leaves nothing accepted (fails closed).
BEGIN;
DO $$
DECLARE c text; got text;
BEGIN
 SELECT conname INTO c FROM pg_constraint
 WHERE conrelid = 'public.context_ledger_items'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%item_type = ANY%';
 EXECUTE format('ALTER TABLE public.context_ledger_items DROP CONSTRAINT %I', c);
 ALTER TABLE public.context_ledger_items ADD CONSTRAINT grades_contract_item_type CHECK (item_type IN
  ('commitment', 'request', 'issue', 'constraint', 'dependency', 'agreement', 'event', 'phase_note', 'promise')) NOT VALID;
 SELECT string_agg(k.item_type || ':' || k.ord || ':' || k.accepted || ':' || (k.meaning IS NOT NULL), ',' ORDER BY k.ord, k.item_type COLLATE "C") INTO got
 FROM public.context_item_kinds() k;
 IF got IS DISTINCT FROM 'commitment:1:true:true,request:2:true:true,claim:3:false:true,issue:4:true:true,constraint:5:true:true,'
   'dependency:6:true:true,agreement:7:true:true,event:8:true:true,phase_note:9:true:true,promise:100:true:false' THEN
  RAISE EXCEPTION 'grades contract: the catalogue does not follow the store''s check (%)', got;
 END IF;
 ALTER TABLE public.context_ledger_items ADD CONSTRAINT grades_contract_not_event CHECK (item_type <> 'event') NOT VALID;
 IF EXISTS (SELECT 1 FROM public.context_item_kinds() k WHERE k.accepted) THEN
  RAISE EXCEPTION 'grades contract: a check that is not an IN list still leaves kinds accepted';
 END IF;
END $$;
ROLLBACK;

-- 4. The verdict shapes: each kind's well-formed verdicts pass, and every
-- malformed one is named.
DO $$
DECLARE x record; got text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('ledger', '0f000000-0000-4000-8000-0000000001a1', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0}', NULL),
  ('ledger', '0f000000-0000-4000-8000-0000000001a1', '{"verbatim":"fail","parties":"pass","supported":"fail","unsafe":1,"unsafe_classes":[1,3],"rows":[{"t":"business_events","id":"0f000000-0000-4000-8000-0000000003a1"}]}', NULL),
  ('story', 'story', '{"first_line":"pass","unsafe":0}', NULL),
  ('story', 'story', '{"timeline":"pass","record_loops":"fail","recall":{"money":{"found":1,"total":2},"record":{"found":0,"total":0},"message":{"found":3,"total":4}},"precision":{"real":5,"shown":6},"first_line":"fail","first_line_set":"unseen","unsafe":2,"unsafe_classes":[2],"money":"pass","dates":"fail","honesty":"pass","orientation":3}', NULL),
  ('agent', 'where_at', '{"answer":"correct","unsafe":0}', NULL),
  ('agent', 'period', '{"answer":"wrong","unsafe":1,"unsafe_classes":[1],"action_cards":2,"story_tool":false}', NULL),
  ('agent', 'story', '{"loops":{"covered":1,"applicable":3},"unsafe":0,"story_tool":true}', NULL),
  ('agent', 'story', '{"loops":{"covered":0,"applicable":0},"unsafe":0}', NULL),
  -- malformed
  ('ledger', 'x', NULL, 'verdicts must be an object'),
  ('ledger', 'x', '[1]', 'verdicts must be an object'),
  ('ledger', 'x', jsonb_build_object('verbatim', 'pass', 'parties', 'pass', 'supported', 'pass', 'unsafe', 0,
     'pad', repeat('x', 4100))::text, 'verdicts are over 4096 bytes'),
  ('review', 'story', '{"first_line":"pass","unsafe":0}', 'no verdicts are defined for kind review unit story'),
  ('agent', 'brief', '{"answer":"correct","unsafe":0}', 'no verdicts are defined for kind agent unit brief'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"note":"the customer said"}', 'unknown verdict note'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","unsafe":0}', 'missing verdict supported'),
  ('story', 'story', '{"first_line":"pass"}', 'missing verdict unsafe'),
  ('agent', 'story', '{"answer":"correct","unsafe":0}', 'unknown verdict answer'),
  ('agent', 'owed', '{"loops":{"covered":1,"applicable":1},"unsafe":0}', 'unknown verdict loops'),
  ('ledger', 'x', '{"verbatim":"yes","parties":"pass","supported":"pass","unsafe":0}', 'verbatim must be pass or fail'),
  ('ledger', 'x', '{"verbatim":"pass","parties":null,"supported":"pass","unsafe":0}', 'parties must be pass or fail'),
  ('story', 'story', '{"first_line":true,"unsafe":0}', 'first_line must be pass or fail'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"honesty":"mostly"}', 'honesty must be pass or fail'),
  ('agent', 'last_told', '{"answer":"pass","unsafe":0}', 'answer must be correct or wrong'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"first_line_set":"other"}', 'first_line_set must be known or unseen'),
  ('agent', 'owed', '{"answer":"correct","unsafe":0,"story_tool":"yes"}', 'story_tool must be true or false'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":"0"}', 'unsafe must be a whole number from 0'),
  ('story', 'story', '{"first_line":"pass","unsafe":-1}', 'unsafe must be a whole number from 0'),
  ('story', 'story', '{"first_line":"pass","unsafe":1.5}', 'unsafe must be a whole number from 0'),
  ('agent', 'owed', '{"answer":"correct","unsafe":0,"action_cards":1000000}', 'action_cards must be a whole number from 0'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":2}', 'unsafe is 0 or 1 for one ledger item'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"orientation":6}', 'orientation must be a whole number from 1 to 5'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"orientation":"4"}', 'orientation must be a whole number from 1 to 5'),
  ('story', 'story', '{"first_line":"pass","unsafe":1,"unsafe_classes":[5]}', 'unsafe_classes must be distinct T8 classes from 1 to 4'),
  ('story', 'story', '{"first_line":"pass","unsafe":1,"unsafe_classes":[2,2]}', 'unsafe_classes must be distinct T8 classes from 1 to 4'),
  ('story', 'story', '{"first_line":"pass","unsafe":1,"unsafe_classes":[]}', 'unsafe_classes must be distinct T8 classes from 1 to 4'),
  ('story', 'story', '{"first_line":"pass","unsafe":1,"unsafe_classes":"1"}', 'unsafe_classes must be distinct T8 classes from 1 to 4'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"unsafe_classes":[1]}', 'unsafe_classes are given with unsafe 0'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"recall":[1]}', 'recall must be an object of money, record and message'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"recall":{}}', 'recall must be an object of money, record and message'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"recall":{"loops":{"found":1,"total":1}}}', 'recall must be an object of money, record and message'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"recall":{"money":{"found":3,"total":2}}}', 'recall.money must be {found, total}, whole numbers, found at most total'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"recall":{"record":{"found":1}}}', 'recall.record must be {found, total}, whole numbers, found at most total'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"recall":{"message":[1,2]}}', 'recall.message must be {found, total}, whole numbers, found at most total'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"precision":{"real":1,"shown":2,"extra":0}}', 'precision must be {real, shown}, whole numbers, real at most shown'),
  ('story', 'story', '{"first_line":"pass","unsafe":0,"precision":{"real":"1","shown":2}}', 'precision must be {real, shown}, whole numbers, real at most shown'),
  ('agent', 'story', '{"loops":{"covered":-1,"applicable":2},"unsafe":0}', 'loops must be {covered, applicable}, whole numbers, covered at most applicable'),
  ('agent', 'story', '{"loops":"all","unsafe":0}', 'loops must be {covered, applicable}, whole numbers, covered at most applicable'),
  ('agent', 'story', '{"loops":{"covered":1,"applicable":3},"missed":["rear-fence-quote"],"unsafe":0}', 'unknown verdict missed'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":[]}', 'rows must be 1 to 25 {t, id} row ids'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":{"t":"jobs","id":"a"}}', 'rows must be 1 to 25 {t, id} row ids'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":["jobs"]}', 'rows must be 1 to 25 {t, id} row ids'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":[{"t":"users","id":"a"}]}', 'rows must be 1 to 25 {t, id} row ids'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":[{"t":"jobs","id":"has spaces"}]}', 'rows must be 1 to 25 {t, id} row ids'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":[{"t":"jobs","id":"a","note":"b"}]}', 'rows must be 1 to 25 {t, id} row ids'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":[{"table":"jobs","id":"a"}]}', 'rows must be 1 to 25 {t, id} row ids'),
  ('ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"rows":[{"t":"jobs","id":7}]}', 'rows must be 1 to 25 {t, id} row ids')
 ) AS v(kind, unit, verdicts, problem) LOOP
  got := public.context_grade_verdicts_problem(x.kind, x.unit, x.verdicts::jsonb);
  IF got IS DISTINCT FROM x.problem THEN
   RAISE EXCEPTION 'grades contract: verdicts % for % % read as % (expected %)', x.verdicts, x.kind, x.unit, coalesce(got, 'well formed'), coalesce(x.problem, 'well formed');
  END IF;
 END LOOP;
END $$;

-- 5. The pass rule: one rule per kind, and malformed verdicts never pass.
DO $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('a clean ledger item', 'ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0}', true),
  ('an unsafe ledger item', 'ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":1}', false),
  ('a ledger item that is not verbatim', 'ledger', 'x', '{"verbatim":"fail","parties":"pass","supported":"pass","unsafe":0}', false),
  ('a ledger item with the wrong parties', 'ledger', 'x', '{"verbatim":"pass","parties":"fail","supported":"pass","unsafe":0}', false),
  ('an unsupported ledger item', 'ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"fail","unsafe":0}', false),
  ('a malformed ledger item', 'ledger', 'x', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"words":"x"}', false),
  ('a story graded on its first line alone', 'story', 'story', '{"first_line":"pass","unsafe":0}', true),
  ('a fully graded clean story', 'story', 'story', '{"timeline":"pass","record_loops":"pass","recall":{"money":{"found":2,"total":2},"record":{"found":1,"total":1},"message":{"found":3,"total":4}},"precision":{"real":5,"shown":6},"first_line":"pass","unsafe":0,"money":"pass","dates":"pass","honesty":"pass","orientation":2}', true),
  ('a story with a wrong first line', 'story', 'story', '{"first_line":"fail","unsafe":0}', false),
  ('a story with an unsafe line', 'story', 'story', '{"first_line":"pass","unsafe":1}', false),
  ('a story with a wrong timeline', 'story', 'story', '{"timeline":"fail","first_line":"pass","unsafe":0}', false),
  ('a story with wrong record loops', 'story', 'story', '{"record_loops":"fail","first_line":"pass","unsafe":0}', false),
  ('a story missing a money loop', 'story', 'story', '{"recall":{"money":{"found":1,"total":2}},"first_line":"pass","unsafe":0}', false),
  ('a story missing a record loop', 'story', 'story', '{"recall":{"record":{"found":0,"total":1}},"first_line":"pass","unsafe":0}', false),
  ('a story with money not to the cent', 'story', 'story', '{"first_line":"pass","unsafe":0,"money":"fail"}', false),
  ('a story with a wrong weekday', 'story', 'story', '{"first_line":"pass","unsafe":0,"dates":"fail"}', false),
  ('a story that hides its gaps', 'story', 'story', '{"first_line":"pass","unsafe":0,"honesty":"fail"}', false),
  ('a correct agent answer', 'agent', 'where_at', '{"answer":"correct","unsafe":0}', true),
  ('a wrong agent answer', 'agent', 'owed', '{"answer":"wrong","unsafe":0}', false),
  ('an agent answer with an unsafe line', 'agent', 'last_told', '{"answer":"correct","unsafe":1}', false),
  ('an agent answer that raised an action card', 'agent', 'where_at', '{"answer":"correct","unsafe":0,"action_cards":1}', false),
  ('an agent answer that skipped the story tool', 'agent', 'where_at', '{"answer":"correct","unsafe":0,"story_tool":false}', true),
  ('a story reply covering every loop', 'agent', 'story', '{"loops":{"covered":3,"applicable":3},"unsafe":0}', true),
  ('a story reply with no applicable loop', 'agent', 'story', '{"loops":{"covered":0,"applicable":0},"unsafe":0}', true),
  ('a story reply missing a loop', 'agent', 'story', '{"loops":{"covered":2,"applicable":3},"unsafe":0}', false),
  ('a malformed agent answer', 'agent', 'story', '{"answer":"correct","unsafe":0}', false),
  ('an unknown kind', 'review', 'story', '{"first_line":"pass","unsafe":0}', false)
 ) AS v(label, kind, unit, verdicts, want) LOOP
  IF public.context_grade_passed(x.kind, x.unit, x.verdicts::jsonb) IS DISTINCT FROM x.want THEN
   RAISE EXCEPTION 'grades contract: % reads as passed % (expected %)', x.label,
    public.context_grade_passed(x.kind, x.unit, x.verdicts::jsonb)::text, x.want::text;
  END IF;
 END LOOP;
 IF public.context_grade_passed('ledger', 'x', NULL) IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'grades contract: missing verdicts do not read as not passed';
 END IF;
END $$;

-- Fixtures for sections 6 and 7: four jobs and three readings (live, shadow,
-- retired); a fourth reading id is cited but does not exist.
CREATE FUNCTION pg_temp.gr_row(p jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('kind', 'ledger', 'sample_id', 'contract-1', 'job_id', '0f000000-0000-4000-8000-0000000000a1',
  'unit', '0f000000-0000-4000-8000-0000000001a1', 'generation_id', '0f000000-0000-4000-8000-0000000002a1',
  'reading_model', 'claude-opus-5-5', 'item_type', 'commitment', 'gated', true,
  'verdicts', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0}'::jsonb, 'grader', 'grader-1',
  'as_of', '2026-10-07T04:00:00Z', 'graded_at', '2026-10-07T05:00:00Z', 'created_at', '2026-10-07T06:00:00Z') || p
$$;
CREATE FUNCTION pg_temp.gr_insert(p jsonb) RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.context_grades (kind, sample_id, job_id, unit, generation_id, reading_model, item_type, stratum, gated, verdicts,
  grader, as_of, graded_at, created_at)
 SELECT r.kind, r.sample_id, r.job_id, r.unit, r.generation_id, r.reading_model, r.item_type, r.stratum, coalesce(r.gated, true),
  r.verdicts, r.grader, r.as_of, r.graded_at, r.created_at
 FROM jsonb_populate_record(NULL::public.context_grades, pg_temp.gr_row(p)) r
 RETURNING id
$$;
-- The SQLSTATE an insert fails with, or null when it is taken (and then undone).
CREATE FUNCTION pg_temp.gr_refused(p jsonb) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  PERFORM pg_temp.gr_insert(p);
  RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'taken';
 EXCEPTION WHEN SQLSTATE 'P0099' THEN RETURN NULL;
 WHEN OTHERS THEN RETURN SQLSTATE;
 END;
END $$;
CREATE FUNCTION pg_temp.gr_fixture_jobs() RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.jobs (id, org_id, status, type, job_number, created_at) VALUES
  ('0f000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'GRD-1', '2026-09-01T00:00:00Z'),
  ('0f000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'GRD-2', '2026-09-01T00:00:00Z'),
  ('0f000000-0000-4000-8000-0000000000a3', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'GRD-3', '2026-09-01T00:00:00Z'),
  ('0f000000-0000-4000-8000-0000000000a4', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'GRD-4', '2026-09-01T00:00:00Z');
 INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, model, created_at, finished_at, promoted_at, retired_at, updated_at) VALUES
  ('0f000000-0000-4000-8000-0000000002a1', '0f000000-0000-4000-8000-0000000000a1', 'backfill', 'live', 'luna-ledger:v1', 'claude-opus-5-5',
   '2026-10-06T00:00:00Z', '2026-10-06T00:10:00Z', '2026-10-06T01:00:00Z', NULL, '2026-10-06T01:00:00Z'),
  ('0f000000-0000-4000-8000-0000000002a2', '0f000000-0000-4000-8000-0000000000a2', 'backfill', 'shadow', 'luna-ledger:v1', 'gpt-6-luna',
   '2026-10-06T00:00:00Z', '2026-10-06T00:10:00Z', NULL, NULL, '2026-10-06T00:10:00Z'),
  ('0f000000-0000-4000-8000-0000000002a3', '0f000000-0000-4000-8000-0000000000a3', 'backfill', 'retired', 'luna-ledger:v1', 'claude-opus-5-5',
   '2026-10-05T00:00:00Z', '2026-10-05T00:10:00Z', '2026-10-05T01:00:00Z', '2026-10-06T01:00:00Z', '2026-10-06T01:00:00Z');
$$;

-- 6. The table's checks: a well-formed row of each kind is taken; every other
-- row is refused by a check (23514), the unique key (23505) or the job (23503).
BEGIN;
SELECT pg_temp.gr_fixture_jobs();
DO $$
DECLARE x record; got text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('a ledger item', '{}'),
  ('a records-only story', '{"kind":"story","unit":"story","generation_id":null,"reading_model":null,"item_type":null,"verdicts":{"first_line":"pass","unsafe":0}}'),
  ('a story of a reading', '{"kind":"story","unit":"story","item_type":null,"stratum":"cloud","verdicts":{"first_line":"pass","unsafe":0}}'),
  ('an optional agent call', '{"kind":"agent","unit":"period","generation_id":null,"reading_model":null,"item_type":null,"gated":false,"verdicts":{"answer":"correct","unsafe":0},"grader":"person:0f000000-0000-4000-8000-0000000000e1"}'),
  ('a grade stored ten minutes before its grader finished', '{"graded_at":"2026-10-07T06:10:00Z"}'),
  ('a grade of the instant it was graded against', '{"as_of":"2026-10-07T05:00:00Z"}')
 ) AS v(label, body) LOOP
  got := pg_temp.gr_refused(x.body::jsonb);
  IF got IS NOT NULL THEN RAISE EXCEPTION 'grades contract: % is refused (%)', x.label, got; END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('an unknown kind', '{"kind":"review"}'),
  ('a one-letter sample id', '{"sample_id":"a"}'),
  ('a sample id with a space', '{"sample_id":"golive a"}'),
  ('a ledger unit that is not an item id', '{"unit":"story"}'),
  ('a story unit that is not story', '{"kind":"story","unit":"0f000000-0000-4000-8000-0000000001a1","item_type":null,"verdicts":{"first_line":"pass","unsafe":0}}'),
  ('an unknown agent question', '{"kind":"agent","unit":"brief","generation_id":null,"reading_model":null,"item_type":null,"verdicts":{"answer":"correct","unsafe":0}}'),
  ('a ledger item with no reading', '{"generation_id":null,"reading_model":null}'),
  ('a reading with no model', '{"reading_model":null}'),
  ('a model with no reading', '{"kind":"story","unit":"story","generation_id":null,"item_type":null,"verdicts":{"first_line":"pass","unsafe":0}}'),
  ('a malformed model', '{"reading_model":"Claude Opus"}'),
  ('a ledger item with no type', '{"item_type":null}'),
  ('a ledger item of an unknown type', '{"item_type":"promise"}'),
  ('a story with an item type', '{"kind":"story","unit":"story","verdicts":{"first_line":"pass","unsafe":0}}'),
  ('a malformed stratum', '{"stratum":"Claude Then Cloud"}'),
  ('malformed verdicts', '{"verdicts":{"verbatim":"pass","parties":"pass","supported":"pass"}}'),
  ('verdicts that carry words', '{"verdicts":{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":0,"note":"the customer said"}}'),
  ('a grader named in words', '{"grader":"Grader One"}'),
  ('a person grader with no id', '{"grader":"person:jan"}'),
  ('a grade before the instant it was graded against', '{"as_of":"2026-10-07T05:00:01Z"}'),
  ('a grade stored more than ten minutes before it was graded', '{"graded_at":"2026-10-07T06:10:01Z"}')
 ) AS v(label, body) LOOP
  got := pg_temp.gr_refused(x.body::jsonb);
  IF got IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'grades contract: % was not refused by a check (got %)', x.label, coalesce(got, 'taken'); END IF;
 END LOOP;
 IF pg_temp.gr_refused('{"job_id":"0f000000-0000-4000-8000-0000000000ff"}'::jsonb) IS DISTINCT FROM '23503' THEN
  RAISE EXCEPTION 'grades contract: a grade of a job that does not exist was not refused';
 END IF;
 PERFORM pg_temp.gr_insert('{}'::jsonb);
 IF pg_temp.gr_refused('{"grader":"critic"}'::jsonb) IS DISTINCT FROM '23505' THEN
  RAISE EXCEPTION 'grades contract: one unit was graded twice in one sample';
 END IF;
 IF pg_temp.gr_refused('{"kind":"ledger","sample_id":"contract-2"}'::jsonb) IS NOT NULL THEN
  RAISE EXCEPTION 'grades contract: the same unit cannot be graded in another sample';
 END IF;
END $$;
ROLLBACK;

-- 7. The reads. Two ledger samples (the newer wins), two story samples graded
-- at the same instant (the higher sample id wins), one agent run with optional
-- calls; and replays to instants before each load.
BEGIN;
SELECT pg_temp.gr_fixture_jobs();
DO $$
DECLARE n record; got text; s record;
BEGIN
 -- ledger-old: stored 5 Oct.
 PERFORM pg_temp.gr_insert(jsonb_build_object('sample_id', 'ledger-old', 'as_of', '2026-10-05T04:00:00Z', 'graded_at', '2026-10-05T05:00:00Z',
  'created_at', '2026-10-05T06:00:00Z'));
 -- ledger-new: stored 7 Oct. Gated: a pass, a wrong-party item, a pass on a retired reading. Optional: an unsafe item
 -- on the shadow reading, and a pass that cites a reading that does not exist.
 PERFORM pg_temp.gr_insert(jsonb_build_object('sample_id', 'ledger-new', 'unit', '0f000000-0000-4000-8000-0000000001b1'));
 PERFORM pg_temp.gr_insert(jsonb_build_object('sample_id', 'ledger-new', 'unit', '0f000000-0000-4000-8000-0000000001b2', 'item_type', 'request',
  'verdicts', '{"verbatim":"pass","parties":"fail","supported":"pass","unsafe":0}'::jsonb, 'graded_at', '2026-10-07T05:05:00Z'));
 PERFORM pg_temp.gr_insert(jsonb_build_object('sample_id', 'ledger-new', 'unit', '0f000000-0000-4000-8000-0000000001b3',
  'job_id', '0f000000-0000-4000-8000-0000000000a3', 'generation_id', '0f000000-0000-4000-8000-0000000002a3', 'item_type', 'event',
  'stratum', 'claude', 'grader', 'grader-2'));
 PERFORM pg_temp.gr_insert(jsonb_build_object('sample_id', 'ledger-new', 'unit', '0f000000-0000-4000-8000-0000000001b4',
  'job_id', '0f000000-0000-4000-8000-0000000000a2', 'generation_id', '0f000000-0000-4000-8000-0000000002a2', 'reading_model', 'gpt-6-luna',
  'item_type', 'claim', 'gated', false, 'verdicts', '{"verbatim":"pass","parties":"pass","supported":"pass","unsafe":1,"unsafe_classes":[3]}'::jsonb,
  'grader', 'critic'));
 PERFORM pg_temp.gr_insert(jsonb_build_object('sample_id', 'ledger-new', 'unit', '0f000000-0000-4000-8000-0000000001b5',
  'job_id', '0f000000-0000-4000-8000-0000000000a4', 'generation_id', '0f000000-0000-4000-8000-0000000002a9', 'item_type', 'phase_note',
  'gated', false, 'grader', 'critic', 'graded_at', '2026-10-07T05:20:00Z'));
 -- story-a and story-b: both graded last at 05:30 on 7 Oct.
 PERFORM pg_temp.gr_insert(jsonb_build_object('kind', 'story', 'sample_id', 'story-a', 'unit', 'story', 'item_type', NULL,
  'verdicts', '{"first_line":"pass","unsafe":0}'::jsonb, 'graded_at', '2026-10-07T05:30:00Z'));
 PERFORM pg_temp.gr_insert(jsonb_build_object('kind', 'story', 'sample_id', 'story-b', 'unit', 'story', 'item_type', NULL,
  'verdicts', '{"timeline":"pass","record_loops":"pass","recall":{"money":{"found":2,"total":2},"record":{"found":1,"total":1},"message":{"found":3,"total":4}},"precision":{"real":5,"shown":6},"first_line":"pass","first_line_set":"known","unsafe":0,"money":"pass","dates":"pass","honesty":"pass","orientation":4}'::jsonb));
 PERFORM pg_temp.gr_insert(jsonb_build_object('kind', 'story', 'sample_id', 'story-b', 'unit', 'story', 'item_type', NULL,
  'job_id', '0f000000-0000-4000-8000-0000000000a2', 'generation_id', '0f000000-0000-4000-8000-0000000002a2', 'reading_model', 'gpt-6-luna',
  'verdicts', '{"first_line":"fail","first_line_set":"unseen","unsafe":0,"orientation":2}'::jsonb, 'grader', 'grader-3'));
 PERFORM pg_temp.gr_insert(jsonb_build_object('kind', 'story', 'sample_id', 'story-b', 'unit', 'story', 'item_type', NULL,
  'job_id', '0f000000-0000-4000-8000-0000000000a3', 'generation_id', NULL, 'reading_model', NULL,
  'verdicts', '{"first_line":"pass","first_line_set":"known","unsafe":2,"unsafe_classes":[1,3]}'::jsonb, 'grader', 'grader-3'));
 PERFORM pg_temp.gr_insert(jsonb_build_object('kind', 'story', 'sample_id', 'story-b', 'unit', 'story', 'item_type', NULL,
  'job_id', '0f000000-0000-4000-8000-0000000000a4', 'generation_id', NULL, 'reading_model', NULL,
  'verdicts', '{"recall":{"money":{"found":1,"total":2}},"first_line":"pass","unsafe":0}'::jsonb, 'grader', 'grader-3',
  'graded_at', '2026-10-07T05:30:00Z'));
 -- t7-run-1: stored 7 Oct 09:00. Gated: three baseline questions and two story calls; optional: a story call and a period call.
 FOR s IN SELECT * FROM (VALUES
  ('0f000000-0000-4000-8000-0000000000a1', 'where_at', true, '{"answer":"correct","unsafe":0,"story_tool":true}'),
  ('0f000000-0000-4000-8000-0000000000a1', 'last_told', true, '{"answer":"wrong","unsafe":0}'),
  ('0f000000-0000-4000-8000-0000000000a1', 'owed', true, '{"answer":"correct","unsafe":0,"action_cards":1}'),
  ('0f000000-0000-4000-8000-0000000000a1', 'story', true, '{"loops":{"covered":3,"applicable":3},"unsafe":0}'),
  ('0f000000-0000-4000-8000-0000000000a2', 'story', true, '{"loops":{"covered":1,"applicable":2},"unsafe":0}'),
  ('0f000000-0000-4000-8000-0000000000a3', 'story', false, '{"loops":{"covered":2,"applicable":2},"unsafe":1}'),
  ('0f000000-0000-4000-8000-0000000000a4', 'period', false, '{"answer":"correct","unsafe":0,"story_tool":false}')) AS v(job, unit, gated, verdicts) LOOP
  PERFORM pg_temp.gr_insert(jsonb_build_object('kind', 'agent', 'sample_id', 't7-run-1', 'job_id', s.job, 'unit', s.unit, 'generation_id', NULL,
   'reading_model', NULL, 'item_type', NULL, 'gated', s.gated, 'verdicts', s.verdicts::jsonb, 'grader', 'grader-4',
   'as_of', '2026-10-07T07:00:00Z', 'graded_at', '2026-10-07T08:00:00Z', 'created_at', '2026-10-07T09:00:00Z'));
 END LOOP;

 -- The newest of each kind on 7 Oct, after every load.
 SELECT * INTO n FROM public.context_grades_newest('2026-10-07T10:00:00Z') g WHERE g.kind = 'ledger';
 IF (n.samples, n.sample_id, n.graded_at, n.as_of, n.units, n.passed, n.pass_pct, n.jobs, n.optional_units, n.optional_passed,
     n.unsafe_lines, n.graders)
    IS DISTINCT FROM (2, 'ledger-new'::text, '2026-10-07T05:20:00Z'::timestamptz, '2026-10-07T04:00:00Z'::timestamptz, 3, 2, 66.6::numeric,
     2, 2, 1, 1, ARRAY['critic', 'grader-1', 'grader-2']) THEN
  RAISE EXCEPTION 'grades contract: the newest ledger sample reads %', to_jsonb(n) - 'tests' - 'breakdown' - 'readings';
 END IF;
 IF n.tests IS DISTINCT FROM '{"verbatim":{"graded":3,"passed":3},"parties":{"graded":3,"passed":2},"supported":{"graded":3,"passed":3},"unsafe":{"units":1,"lines":1}}'::jsonb THEN
  RAISE EXCEPTION 'grades contract: the ledger tests read %', n.tests;
 END IF;
 IF n.breakdown IS DISTINCT FROM ('{"by_reader":{"claude-opus-5-5":{"units":3,"passed":2,"optional_units":1,"optional_passed":1},'
   '"gpt-6-luna":{"units":0,"passed":0,"optional_units":1,"optional_passed":0}},'
   '"by_stratum":{"claude":{"units":1,"passed":1,"optional_units":0,"optional_passed":0},"none":{"units":2,"passed":1,"optional_units":2,"optional_passed":1}},'
   '"by_type":{"commitment":{"units":1,"passed":1,"optional_units":0,"optional_passed":0},"request":{"units":1,"passed":0,"optional_units":0,"optional_passed":0},'
   '"event":{"units":1,"passed":1,"optional_units":0,"optional_passed":0},"claim":{"units":0,"passed":0,"optional_units":1,"optional_passed":0},'
   '"phase_note":{"units":0,"passed":0,"optional_units":1,"optional_passed":1}}}')::jsonb THEN
  RAISE EXCEPTION 'grades contract: the ledger breakdown reads %', n.breakdown;
 END IF;
 IF n.readings IS DISTINCT FROM '{"graded":4,"live":1,"shadow":1,"retired":1,"other":0,"missing":1}'::jsonb THEN
  RAISE EXCEPTION 'grades contract: the ledger readings read %', n.readings;
 END IF;

 SELECT * INTO n FROM public.context_grades_newest('2026-10-07T10:00:00Z') g WHERE g.kind = 'story';
 IF (n.samples, n.sample_id, n.units, n.passed, n.pass_pct, n.jobs, n.optional_units, n.unsafe_lines, n.graders)
    IS DISTINCT FROM (2, 'story-b'::text, 4, 1, 25.0::numeric, 4, 0, 2, ARRAY['grader-1', 'grader-3']) THEN
  RAISE EXCEPTION 'grades contract: the newest story sample reads %', to_jsonb(n) - 'tests' - 'breakdown' - 'readings';
 END IF;
 IF n.tests IS DISTINCT FROM ('{"timeline":{"graded":1,"passed":1},"record_loops":{"graded":1,"passed":1},'
   '"recall":{"money":{"graded":2,"found":3,"total":4},"record":{"graded":1,"found":1,"total":1},"message":{"graded":1,"found":3,"total":4}},'
   '"precision":{"graded":1,"real":5,"shown":6},'
   '"first_line":{"graded":4,"passed":3,"known":{"graded":2,"passed":2},"unseen":{"graded":1,"passed":0}},'
   '"money":{"graded":1,"passed":1},"dates":{"graded":1,"passed":1},"honesty":{"graded":1,"passed":1},'
   '"orientation":{"graded":2,"mean":3.0,"lowest":2},"unsafe":{"units":1,"lines":2}}')::jsonb THEN
  RAISE EXCEPTION 'grades contract: the story tests read %', n.tests;
 END IF;
 IF n.breakdown -> 'by_reader' IS DISTINCT FROM ('{"claude-opus-5-5":{"units":1,"passed":1,"optional_units":0,"optional_passed":0},'
   '"gpt-6-luna":{"units":1,"passed":0,"optional_units":0,"optional_passed":0},"none":{"units":2,"passed":0,"optional_units":0,"optional_passed":0}}')::jsonb
  OR n.breakdown ? 'by_type' OR n.breakdown ? 'by_question' THEN
  RAISE EXCEPTION 'grades contract: the story breakdown reads %', n.breakdown;
 END IF;
 IF n.readings IS DISTINCT FROM '{"graded":2,"live":1,"shadow":1,"retired":0,"other":0,"missing":0}'::jsonb THEN
  RAISE EXCEPTION 'grades contract: the story readings read %', n.readings;
 END IF;

 SELECT * INTO n FROM public.context_grades_newest('2026-10-07T10:00:00Z') g WHERE g.kind = 'agent';
 IF (n.samples, n.sample_id, n.units, n.passed, n.pass_pct, n.jobs, n.optional_units, n.optional_passed, n.unsafe_lines)
    IS DISTINCT FROM (1, 't7-run-1'::text, 5, 2, 40.0::numeric, 2, 2, 1, 1) THEN
  RAISE EXCEPTION 'grades contract: the newest agent run reads %', to_jsonb(n) - 'tests' - 'breakdown' - 'readings';
 END IF;
 IF n.tests IS DISTINCT FROM ('{"baseline":{"graded":3,"passed":1},"story":{"graded":2,"passed":1,"loops_covered":4,"loops_applicable":5},'
   '"optional_story":{"graded":1,"passed":0,"loops_covered":2,"loops_applicable":2},"period":{"graded":1,"passed":1},'
   '"story_tool_missed":1,"action_cards":1,"unsafe":{"units":1,"lines":1}}')::jsonb THEN
  RAISE EXCEPTION 'grades contract: the agent tests read %', n.tests;
 END IF;
 IF n.breakdown -> 'by_question' IS DISTINCT FROM ('{"where_at":{"units":1,"passed":1,"optional_units":0,"optional_passed":0},'
   '"last_told":{"units":1,"passed":0,"optional_units":0,"optional_passed":0},"owed":{"units":1,"passed":0,"optional_units":0,"optional_passed":0},'
   '"story":{"units":2,"passed":1,"optional_units":1,"optional_passed":0},"period":{"units":0,"passed":0,"optional_units":1,"optional_passed":1}}')::jsonb
  OR n.readings IS DISTINCT FROM '{"graded":0,"live":0,"shadow":0,"retired":0,"other":0,"missing":0}'::jsonb THEN
  RAISE EXCEPTION 'grades contract: the agent breakdown or readings read % %', n.breakdown, n.readings;
 END IF;

 -- Always three rows, in order.
 SELECT string_agg(g.kind, ',') INTO got FROM public.context_grades_newest('2026-10-07T10:00:00Z') g;
 IF got IS DISTINCT FROM 'ledger,story,agent' THEN RAISE EXCEPTION 'grades contract: the newest rows are %', got; END IF;
 -- Every sample, the newest of each kind marked, newest first within a kind.
 SELECT string_agg(g.kind || ':' || g.sample_id || ':' || g.newest, ',') INTO got FROM public.context_grade_samples('2026-10-07T10:00:00Z') g;
 IF got IS DISTINCT FROM 'agent:t7-run-1:true,ledger:ledger-new:true,ledger:ledger-old:false,story:story-b:true,story:story-a:false' THEN
  RAISE EXCEPTION 'grades contract: the samples read %', got;
 END IF;

 -- Replays: before the agent run was stored it is not there; before ledger-new, ledger-old is the newest; before
 -- anything was stored every kind reads empty.
 SELECT * INTO n FROM public.context_grades_newest('2026-10-07T08:59:59Z') g WHERE g.kind = 'agent';
 IF (n.samples, n.sample_id, n.units, n.passed, n.pass_pct, n.jobs, n.unsafe_lines, n.graders, n.tests, n.breakdown)
    IS DISTINCT FROM (0, NULL::text, 0, 0, NULL::numeric, 0, 0, '{}'::text[], '{}'::jsonb, '{}'::jsonb) THEN
  RAISE EXCEPTION 'grades contract: an agent run stored later is read %', to_jsonb(n);
 END IF;
 SELECT * INTO n FROM public.context_grades_newest('2026-10-06T00:00:00Z') g WHERE g.kind = 'ledger';
 IF (n.samples, n.sample_id, n.units, n.passed, n.pass_pct, n.jobs) IS DISTINCT FROM (1, 'ledger-old'::text, 1, 1, 100.0::numeric, 1) THEN
  RAISE EXCEPTION 'grades contract: the replay to 6 Oct reads %', to_jsonb(n) - 'tests' - 'breakdown';
 END IF;
 IF (SELECT count(*) FROM public.context_grades_newest('2026-10-04T00:00:00Z') g WHERE g.samples = 0 AND g.sample_id IS NULL AND g.units = 0) <> 3
  OR EXISTS (SELECT 1 FROM public.context_grade_samples('2026-10-04T00:00:00Z')) THEN
  RAISE EXCEPTION 'grades contract: a replay before any grade reads a sample';
 END IF;
END $$;
ROLLBACK;

-- 8. The rollback refuses while a grade is stored, and leaves everything as it was.
BEGIN;
SELECT pg_temp.gr_fixture_jobs();
SELECT pg_temp.gr_insert('{}'::jsonb) IS NOT NULL AS stored;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261007090000_context_grades_down.sql
\set ON_ERROR_STOP on
ROLLBACK;
SELECT position('context_grades_rollback_refused: 1 graded rows are stored' IN :'LAST_ERROR_MESSAGE') > 0 AS grades_rollback_refused \gset
\if :grades_rollback_refused
\else
DO $$ BEGIN RAISE EXCEPTION 'grades contract: the rollback did not refuse while a grade was stored'; END $$;
\endif
DO $$
BEGIN
 IF to_regclass('public.context_grades') IS NULL OR to_regprocedure('public.context_grades_newest(timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'grades contract: the refused rollback dropped something';
 END IF;
END $$;

-- 9. A re-apply is a no-op, and everything still answers.
\ir ../../../migrations/20261007090000_context_grades.sql
DO $$
BEGIN
 IF (SELECT count(*) FROM public.context_item_kinds() k WHERE k.accepted AND k.meaning IS NOT NULL) <> 9
  OR (SELECT count(*) FROM public.context_grades_newest('2026-10-07T10:00:00Z')) <> 3
  OR EXISTS (SELECT 1 FROM public.context_grades) THEN
  RAISE EXCEPTION 'grades contract: the re-apply changed something';
 END IF;
END $$;
