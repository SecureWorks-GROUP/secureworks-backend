-- The saved job story: a short written story of each job, kept in the
-- database, and the queue that asks the Luna context worker to write or
-- rewrite it (job overview, owner's approved design of 9 Oct 2026).
--
-- Why. The ops dashboard's new job Overview leads with "the story": where the
-- job is at, whose move it is, how it got here and what to watch out for, in
-- five short plain sections a non-technical owner can read. The story card
-- (context_job_story, job-story-v1) already holds every fact, cited; this
-- slice keeps the WRITTEN story beside it, says whether it is still current,
-- and lets staff ask for a rewrite. The worker (secureworks-jarvis, the story
-- writer phase) writes the words from the card and the live AI notes only,
-- checks every amount and date against them, and saves through here.
--
-- What it adds:
--  1. context_job_story_text_policy(): every number (calls a Perth day, lease,
--     the 10-minute rewrite floor, the quiet time, the enqueue cap, attempts,
--     retry waits). Changed only by migration.
--  2. context_job_story_requests: the queue. At most one open request a job.
--     A request is 'asked' (staff, from the job page) or 'job_changed' (the
--     worker's own sweep, context_job_story_enqueue_changed). A claim leases it
--     (context_job_story_claim); the worker closes it by saving a story
--     (context_job_story_text_save) or with context_job_story_request_finish
--     (unchanged, failed, or released for a retry).
--  3. context_job_story_texts: the written stories. At most one current per
--     job; a newer one supersedes it. sections holds exactly headline,
--     the_job, how_we_got_here, where_it_is_at and watch_out, plain strings with
--     no dashes (context_job_story_sections_problem); checks holds the writer's
--     own fact check as codes and counts only (context_job_story_checks_problem).
--  4. Freshness. card_hash is context_job_story_card_hash(card), the md5 of the
--     card's stable facts (digest story-digest-v1): job status; the now line's
--     phase, since, whose move and follow-up state; each loop's key, status,
--     owner, counterparty, due date and what it blocks; money amounts per party
--     and per invoice (status, totals, paid, owing, due, paid on, overdue or
--     not), job value and not yet invoiced; timeline rows (instant, kind,
--     record, state, amount); checks (rule and cited rows); agreements; events;
--     phase notes counted per phase; who; which messages are the last
--     exchange; and the ledger status. It leaves out everything that moves with
--     the clock or is prose: as_of, built_at, age_days, days_overdue, every
--     line, what and why, cites of loops, handling, not_known and changes.
--     Numbers are rounded to 2 places and every array is sorted in C order, so
--     a JSON round trip (0.00 read back as 0) gives the same hash. A story is
--     fresh while its card_hash equals the hash of the card now, else stale.
--  5. context_job_story_text_get(job, card, check): the current story and
--     fresh, stale, none or unchecked, plus the writer's state (on, the open
--     request, the last failure). ops-api passes the card it has just read, so
--     a page view builds the card once.
--  6. context_job_story_request(job, by, reason): idempotent and rate limited:
--     off while the switch is off; already_open while a request is open;
--     recent while the current story is under 10 minutes old and still fresh.
--  7. context_job_story_enqueue_changed(limit): the one rule for "something new
--     happened" (cheap signals, then the lead rule): queues job_changed for at
--     most 5 live, monitored jobs a call.
--  8. context_job_story_claim(limit), context_job_story_writer_input(job),
--     context_job_story_text_save(...), context_job_story_request_finish(...),
--     context_job_story_budget(): the worker's side.
--  9. The model call budget. A story call reserves through
--     reserve_context_model_call with the new phase 'story' and no run (the
--     phase list on context_model_call_reservations is widened): only while the
--     switch is on (story_off), at most calls_per_day story calls a Perth day,
--     and never inside the ledger's live reserve lines (story_budget). Every
--     other phase takes exactly the path it took before. Story calls count in
--     the owner's 1,000-call day and in the heartbeat.
-- 10. feature_flags.context_job_story_text_v1, created OFF. While it is off no
--     request is queued, nothing is claimed and no model call is admitted.
--     Turning it on needs the owner's word.
--
-- Writes nothing else: no request, story, cron job or trigger, and no grant or
-- policy for anon or authenticated. Both tables: RLS on with no policy, the
-- service role reads, every write goes through the functions above.
--
-- Replaces one function: reserve_context_model_call(text,uuid,uuid) (live md5
-- 0d741538d7874ce63d48e54d8645d18c, the 20261006060000 body), with the story
-- branch added; and widens one CHECK (the reservations' phase list).
--
-- Rollback: supabase/rollbacks/20261009100000_context_job_story_text_down.sql
-- (the admission back byte for byte, the phase list narrowed, NOT VALID while
-- story reservations remain; the tables, functions and the flag row dropped).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard. Reports every problem at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; x record; cols text; chk text; f text; t text;
BEGIN
 -- Read, never replaced.
 FOREACH f IN ARRAY ARRAY['public.context_job_story(uuid,timestamptz,uuid,timestamptz,boolean)',
   'public.context_job_story_ledger(uuid,uuid,timestamptz)', 'public.context_lead_monitored_jobs(uuid[],timestamptz)',
   'public.automation_lane_enabled(text)', 'public.context_cadence_policy()'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['jobs.status', 'jobs.metadata', 'feature_flags.flag_name', 'feature_flags.enabled', 'feature_flags.description',
   'context_ledger_settings.live_reserve_calls', 'context_ledger_settings.live_reserve_calls_morning',
   'context_ledger_generations.job_id', 'context_ledger_generations.status', 'context_ledger_generations.evidence_until',
   'context_ledger_generations.promoted_at', 'context_ledger_generations.created_at',
   'context_model_call_reservations.run_date', 'context_model_call_reservations.phase', 'context_model_call_reservations.ordinal',
   'xero_invoices.job_id', 'xero_invoices.invoice_type', 'xero_invoices.status', 'xero_invoices.total', 'xero_invoices.amount_due',
   'xero_invoices.amount_paid', 'xero_invoices.fully_paid_on', 'xero_invoices.due_date', 'xero_invoices.invoice_number',
   'xero_invoices.updated_at', 'job_documents.job_id', 'job_documents.type', 'job_documents.sent_at', 'job_documents.accepted_at',
   'job_documents.declined_at', 'job_documents.superseded_at', 'business_events.job_id', 'business_events.event_type',
   'business_events.channel', 'business_events.metadata', 'business_events.recorded_at', 'business_events.occurred_at'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- The one replaced function: the live call budget body, or this migration's (a re-apply).
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.reserve_context_model_call(text,uuid,uuid)');
 IF live IS NULL OR live NOT IN ('0d741538d7874ce63d48e54d8645d18c', '25a5b5f208af726d47e952f98cecef56') THEN
  problems := problems || format('public.reserve_context_model_call(text,uuid,uuid) md5 %s', coalesce(live, '<missing>'));
 END IF;
 -- The reservations' phase list: the ledger store's (20261006013000), narrowed
 -- NOT VALID by this migration's rollback, or already this migration's.
 SELECT string_agg(pg_get_constraintdef(c.oid), ' | ' ORDER BY c.conname) INTO chk FROM pg_constraint c
 WHERE c.conrelid = to_regclass('public.context_model_call_reservations') AND c.contype = 'c'
   AND pg_get_constraintdef(c.oid) LIKE '%phase = ANY%';
 IF chk IS NULL OR chk NOT IN (
   $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$c$,
   $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text]))) NOT VALID$c$,
   $c$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text, 'story'::text])))$c$) THEN
  problems := problems || format('context_model_call_reservations phase check is %s', coalesce(chk, '<missing>'));
 END IF;
 -- The two tables: absent, or exactly this migration's (a re-apply).
 IF to_regclass('public.context_job_story_requests') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_job_story_requests'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF coalesce(obj_description('public.context_job_story_requests'::regclass, 'pg_class'), '') NOT LIKE 'Job story text (20261009100000)%'
   OR cols IS DISTINCT FROM 'id:uuid,job_id:uuid,requested_at:timestamp with time zone,requested_by:text,reason:text,'
     'picked_at:timestamp with time zone,lease_token:uuid,lease_expires_at:timestamp with time zone,attempts:smallint,'
     'next_attempt_at:timestamp with time zone,claimed_state:jsonb,done_at:timestamp with time zone,outcome:text,error:text' THEN
   problems := problems || format('public.context_job_story_requests exists and is not this migration''s (columns %s)', cols);
  END IF;
 END IF;
 IF to_regclass('public.context_job_story_texts') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_job_story_texts'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF coalesce(obj_description('public.context_job_story_texts'::regclass, 'pg_class'), '') NOT LIKE 'Job story text (20261009100000)%'
   OR cols IS DISTINCT FROM 'id:uuid,job_id:uuid,request_id:uuid,written_at:timestamp with time zone,checked_at:timestamp with time zone,'
     'evidence_until:timestamp with time zone,generation_id:uuid,job_status:text,record_sig:text,card_hash:text,model:text,'
     'prompt_sha256:text,sections:jsonb,checks:jsonb,status:text,superseded_at:timestamp with time zone' THEN
   problems := problems || format('public.context_job_story_texts exists and is not this migration''s (columns %s)', cols);
  END IF;
 ELSIF to_regclass('public.feature_flags') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1' AND enabled IS TRUE) THEN
  -- On before the store exists: the writer would start at merge with nowhere to write.
  problems := problems || 'feature flag context_job_story_text_v1 is already on before the first apply'::text;
 END IF;
 -- The functions: every overload of these names is absent or this migration's.
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('context_job_story_text_policy', 'context_job_story_text_on',
   'context_job_story_sections_problem', 'context_job_story_checks_problem', 'context_job_story_digest_num',
   'context_job_story_digest_at', 'context_job_story_card_hash', 'context_job_story_reading', 'context_job_story_record_sig',
   'context_job_story_claim_state', 'context_job_story_budget', 'context_job_story_text_get', 'context_job_story_request',
   'context_job_story_enqueue_changed', 'context_job_story_claim', 'context_job_story_writer_input',
   'context_job_story_text_save', 'context_job_story_request_finish') LOOP
  IF x.c NOT LIKE 'Job story text (20261009100000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_job_story_text_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The reservations' phase list admits 'story' (drop and re-add only the expected definition).
DO $chk$
DECLARE c record;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) IN (
    $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text])))$d$,
    $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text]))) NOT VALID$d$) LOOP
  EXECUTE format('ALTER TABLE public.context_model_call_reservations DROP CONSTRAINT %I', c.conname);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c'
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text, 'story'::text])))$d$) THEN
  ALTER TABLE public.context_model_call_reservations ADD CONSTRAINT context_model_call_reservations_phase_check
   CHECK (phase IN ('attribution','extraction','bucket','vision','ledger','story'));
 END IF;
END $chk$;

-- 2. Every number, in one place.
CREATE OR REPLACE FUNCTION public.context_job_story_text_policy()
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $fn$
 SELECT jsonb_build_object(
  'flag', 'context_job_story_text_v1',
  -- story model calls a Perth day (one per write, one more for a strict retry)
  'calls_per_day', 80,
  -- a claimed request is the worker's for this long
  'lease_minutes', 15,
  -- a story under this age that is still fresh is not rewritten (asked or not),
  -- and the sweep leaves a story this young alone
  'min_rewrite_minutes', 10,
  -- with no live AI reading, a new message wakes a rewrite only after this quiet time
  'quiet_minutes', 15,
  -- job_changed requests the sweep queues a call, at most
  'enqueue_per_call', 5,
  -- counted attempts before a request closes failed (max_attempts)
  'max_attempts', 3,
  -- the wait after the first and the second counted failure, in minutes
  'retry_minutes', jsonb_build_array(30, 120),
  -- the digest of the card the freshness hash reads (context_job_story_card_hash)
  'digest', 'story-digest-v1',
  -- who a job_changed request is requested by
  'writer', 'luna-story-writer')
$fn$;
COMMENT ON FUNCTION public.context_job_story_text_policy() IS
 'Job story text (20261009100000): every number of the saved job story: calls_per_day 80 (story model calls a Perth day), lease_minutes 15, min_rewrite_minutes 10, quiet_minutes 15, enqueue_per_call 5, max_attempts 3, retry_minutes [30, 120], digest story-digest-v1, writer luna-story-writer. Changed only by migration. Service role only.';

-- 3. The switch: feature_flags.context_job_story_text_v1; missing or unreadable is off.
CREATE OR REPLACE FUNCTION public.context_job_story_text_on()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v boolean;
BEGIN
 SELECT bool_and(f.enabled) INTO v FROM public.feature_flags f WHERE f.flag_name = 'context_job_story_text_v1';
 RETURN coalesce(v, false);
EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
 RETURN false;
END $fn$;
COMMENT ON FUNCTION public.context_job_story_text_on() IS
 'Job story text (20261009100000): whether the saved job story is switched on (feature_flags.context_job_story_text_v1; a missing row or table, or more than one row not all on, reads as off). Service role only.';

-- 4. The shape checks the tables enforce. Null when good, else what is wrong.
CREATE OR REPLACE FUNCTION public.context_job_story_sections_problem(p_sections jsonb)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE k text; v jsonb; s text;
 keys constant text[] := ARRAY['headline', 'how_we_got_here', 'the_job', 'watch_out', 'where_it_is_at'];
BEGIN
 IF p_sections IS NULL OR jsonb_typeof(p_sections) IS DISTINCT FROM 'object' THEN
  RETURN 'sections must be an object';
 END IF;
 IF (SELECT array_agg(x ORDER BY x COLLATE "C") FROM jsonb_object_keys(p_sections) x) IS DISTINCT FROM keys THEN
  RETURN 'sections must hold exactly headline, the_job, how_we_got_here, where_it_is_at and watch_out';
 END IF;
 FOREACH k IN ARRAY keys LOOP
  v := p_sections -> k;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN k || ' must be a string'; END IF;
  s := v #>> '{}';
  IF s = '' OR s <> btrim(s, E' \n') THEN RETURN k || ' must be trimmed and not empty'; END IF;
  IF char_length(s) > (CASE WHEN k = 'headline' THEN 200 ELSE 700 END) THEN
   RETURN k || ' is longer than ' || (CASE WHEN k = 'headline' THEN 200 ELSE 700 END) || ' characters';
  END IF;
  -- no em or en dash (the owner's rule for any text a person reads)
  IF strpos(s, chr(8212)) > 0 OR strpos(s, chr(8211)) > 0 THEN RETURN k || ' holds a dash'; END IF;
  IF replace(s, E'\n', '') ~ '[[:cntrl:]]' THEN RETURN k || ' holds a control character'; END IF;
 END LOOP;
 RETURN NULL;
END $fn$;
COMMENT ON FUNCTION public.context_job_story_sections_problem(jsonb) IS
 'Job story text (20261009100000): the check on context_job_story_texts.sections. Null when the sections are an object with exactly headline, the_job, how_we_got_here, where_it_is_at and watch_out, each a trimmed, non-empty string (headline at most 200 characters, the others at most 700) with no em or en dash and no control character but a line break; else what is wrong (names the key, never the words). Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_checks_problem(p_checks jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE
  WHEN p_checks IS NULL OR jsonb_typeof(p_checks) IS DISTINCT FROM 'object' THEN 'checks must be an object'
  WHEN octet_length(p_checks::text) > 8192 THEN 'checks must be at most 8192 bytes'
  WHEN EXISTS (SELECT 1 FROM jsonb_path_query(p_checks, 'strict $.**') v
               WHERE (jsonb_typeof(v) = 'string' AND (v #>> '{}') !~ '^[^[:space:]]{0,80}$')
                  OR (jsonb_typeof(v) = 'object' AND EXISTS (SELECT 1 FROM jsonb_object_keys(v) k WHERE k !~ '^[A-Za-z0-9_]{1,64}$')))
   THEN 'checks hold codes and counts only'
 END
$fn$;
COMMENT ON FUNCTION public.context_job_story_checks_problem(jsonb) IS
 'Job story text (20261009100000): the check on context_job_story_texts.checks (the writer''s own fact check). Null when it is an object of at most 8192 bytes whose keys are codes (letters, digits, underscores, 1 to 64) and whose values are numbers, booleans, nulls, codes (no spaces, at most 80 characters), arrays or objects of the same: codes and counts only, never words. Else what is wrong. Service role only.';

-- 5. The freshness digest (story-digest-v1). Two inlinable helpers and the hash.
CREATE OR REPLACE FUNCTION public.context_job_story_digest_num(p jsonb)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE WHEN jsonb_typeof(p) = 'number' THEN round((p #>> '{}')::numeric, 2) END
$fn$;
COMMENT ON FUNCTION public.context_job_story_digest_num(jsonb) IS
 'Job story text (20261009100000): a card number as the digest reads it: rounded to 2 places (so 0 and 0.00 are one value after a JSON round trip); null for anything that is not a number. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_digest_at(p jsonb)
RETURNS text
LANGUAGE sql STABLE
AS $fn$
 SELECT CASE
  WHEN jsonb_typeof(p) = 'string' AND (p #>> '{}') ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$'
   THEN to_char(((p #>> '{}')::timestamptz) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  WHEN jsonb_typeof(p) = 'string' THEN p #>> '{}'
 END
$fn$;
COMMENT ON FUNCTION public.context_job_story_digest_at(jsonb) IS
 'Job story text (20261009100000): a card instant as the digest reads it: an ISO time with an offset in UTC to the microsecond (so the session time zone that rendered the card never moves the hash); any other string as it is; null otherwise. Service role only.';

CREATE OR REPLACE FUNCTION public.context_job_story_card_hash(p_card jsonb)
RETURNS text
LANGUAGE sql STABLE STRICT
AS $fn$
 WITH c AS (SELECT p_card AS card)
 SELECT md5(jsonb_build_object(
  'digest', 'story-digest-v1',
  'job', jsonb_build_object('id', c.card #>> '{job,id}', 'status', c.card #>> '{job,status}'),
  'now', jsonb_build_object('phase', c.card #>> '{now,phase}', 'phase_since', c.card #>> '{now,phase_since}',
          'whose_move', c.card #>> '{now,whose_move}', 'monitored', c.card #> '{now,monitored}',
          'not_followed_up_since', c.card #>> '{now,not_followed_up_since}'),
  'loops', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
            SELECT jsonb_build_object('key', l.value ->> 'key', 'status', l.value ->> 'status', 'owner', l.value ->> 'owner',
                   'counterparty', l.value ->> 'counterparty', 'due', l.value ->> 'due', 'blocks', l.value ->> 'blocks') AS o
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card -> 'loops') = 'array' THEN c.card -> 'loops' ELSE '[]'::jsonb END) l) x),
  'money', jsonb_build_object(
   'job_value', public.context_job_story_digest_num(c.card #> '{money,job_value,amount}'),
   'not_yet_invoiced', public.context_job_story_digest_num(c.card #> '{money,not_yet_invoiced,amount}'),
   'parties', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
               SELECT jsonb_build_object('party', m.value ->> 'party', 'xero_contact_id', m.value ->> 'xero_contact_id',
                      'invoiced', public.context_job_story_digest_num(m.value -> 'invoiced'),
                      'paid', public.context_job_story_digest_num(m.value -> 'paid'),
                      'credited', public.context_job_story_digest_num(m.value -> 'credited'),
                      'owing', public.context_job_story_digest_num(m.value -> 'owing'),
                      'drafts', public.context_job_story_digest_num(m.value -> 'drafts'),
                      'draft_total', public.context_job_story_digest_num(m.value -> 'draft_total'),
                      'invoices', (SELECT coalesce(jsonb_agg(y.o ORDER BY y.o::text COLLATE "C"), '[]'::jsonb) FROM (
                                   SELECT jsonb_build_object('number', i.value ->> 'number', 'status', i.value ->> 'status',
                                          'total', public.context_job_story_digest_num(i.value -> 'total'),
                                          'paid', public.context_job_story_digest_num(i.value -> 'paid'),
                                          'owing', public.context_job_story_digest_num(i.value -> 'owing'),
                                          'due_date', i.value ->> 'due_date', 'fully_paid_on', i.value ->> 'fully_paid_on',
                                          'overdue', i.value -> 'overdue') AS o
                                   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.value -> 'invoices') = 'array' THEN m.value -> 'invoices' ELSE '[]'::jsonb END) i) y)) AS o
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card #> '{money,parties}') = 'array' THEN c.card #> '{money,parties}' ELSE '[]'::jsonb END) m) x),
   'placed_on_no_job', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
                        SELECT jsonb_build_object('number', u.value ->> 'number', 'owing', public.context_job_story_digest_num(u.value -> 'owing'),
                               'due_date', u.value ->> 'due_date') AS o
                        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card #> '{money,placed_on_no_job}') = 'array'
                                                       THEN c.card #> '{money,placed_on_no_job}' ELSE '[]'::jsonb END) u) x),
   'supplier_bills', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
                      SELECT jsonb_build_object('number', s.value ->> 'number', 'status', s.value ->> 'status',
                             'total', public.context_job_story_digest_num(s.value -> 'total')) AS o
                      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card #> '{money,supplier_bills}') = 'array'
                                                     THEN c.card #> '{money,supplier_bills}' ELSE '[]'::jsonb END) s) x)),
  'timeline', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
               SELECT jsonb_build_object('at', public.context_job_story_digest_at(t.value -> 'at'), 'kind', t.value ->> 'kind',
                      'source_table', t.value ->> 'source_table', 'source_id', t.value ->> 'source_id', 'state', t.value ->> 'state',
                      'amount', public.context_job_story_digest_num(t.value -> 'amount')) AS o
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card -> 'timeline') = 'array' THEN c.card -> 'timeline' ELSE '[]'::jsonb END) t) x),
  'checks', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
             SELECT jsonb_build_object('rule', k.value ->> 'rule',
                    'cites', (SELECT coalesce(jsonb_agg(z.v ORDER BY z.v COLLATE "C"), '[]'::jsonb) FROM (
                              SELECT concat_ws(':', q.value ->> 't', q.value ->> 'id') AS v
                              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(k.value -> 'cites') = 'array' THEN k.value -> 'cites' ELSE '[]'::jsonb END) q) z)) AS o
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card -> 'checks') = 'array' THEN c.card -> 'checks' ELSE '[]'::jsonb END) k) x),
  'agreements', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
                 SELECT jsonb_build_object('key', a.value ->> 'key', 'status', a.value ->> 'status', 'modality', a.value ->> 'modality') AS o
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card -> 'agreements') = 'array' THEN c.card -> 'agreements' ELSE '[]'::jsonb END) a) x),
  'events', (SELECT coalesce(jsonb_agg(x.v ORDER BY x.v COLLATE "C"), '[]'::jsonb) FROM (
             SELECT coalesce(e.value ->> 'key', '') AS v
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card -> 'events') = 'array' THEN c.card -> 'events' ELSE '[]'::jsonb END) e) x),
  'phase_notes', (SELECT coalesce(jsonb_object_agg(x.phase, x.n), '{}'::jsonb) FROM (
                  SELECT coalesce(pn.value ->> 'phase', '') AS phase, count(*) AS n
                  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card -> 'phase_notes') = 'array' THEN c.card -> 'phase_notes' ELSE '[]'::jsonb END) pn
                  GROUP BY 1) x),
  'who', (SELECT coalesce(jsonb_agg(x.o ORDER BY x.o::text COLLATE "C"), '[]'::jsonb) FROM (
          SELECT jsonb_build_object('role', w.value ->> 'role', 'name', w.value ->> 'name') AS o
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.card -> 'who') = 'array' THEN c.card -> 'who' ELSE '[]'::jsonb END) w) x),
  'last', jsonb_build_object(
   'customer', concat_ws(':', c.card #>> '{last_exchange,customer_said,table}', c.card #>> '{last_exchange,customer_said,id}'),
   'us', concat_ws(':', c.card #>> '{last_exchange,we_told_customer,table}', c.card #>> '{last_exchange,we_told_customer,id}'),
   'us_automated', concat_ws(':', c.card #>> '{last_exchange,we_told_customer,newer_automated,table}',
                   c.card #>> '{last_exchange,we_told_customer,newer_automated,id}'),
   'internal', concat_ws(':', c.card #>> '{last_exchange,internal,table}', c.card #>> '{last_exchange,internal,id}')),
  'ledger', c.card #>> '{meta,ledger,status}')::text)
 FROM c
$fn$;
COMMENT ON FUNCTION public.context_job_story_card_hash(jsonb) IS
 'Job story text (20261009100000): the md5 of a job-story-v1 card''s stable facts (digest story-digest-v1): job id and status; now phase, phase_since, whose_move, monitored and not_followed_up_since; loops (key, status, owner, counterparty, due, blocks); money (job value and not yet invoiced amounts; per party invoiced, paid, credited, owing, drafts, draft_total and each invoice''s number, status, total, paid, owing, due_date, fully_paid_on and overdue; placed_on_no_job number, owing and due_date; supplier bills number, status and total); timeline (at in UTC, kind, source_table, source_id, state, amount); checks (rule and cited rows); agreements (key, status, modality); events (key); phase notes counted per phase; who (role, name); the last exchange''s rows (customer, us, our newer automated send, internal); meta.ledger.status. Nothing that moves with the clock or is prose: as_of, meta.built_at, age_days, days_overdue, every line, what and why, a loop''s cites, handling, not_known, changes. Numbers rounded to 2 places, arrays sorted in C order, so the same facts give the same hash after a JSON round trip. Null for a null card. Service role only.';

-- 6. The job's reading as the story shows it: the newest promoted generation (live or retired).
CREATE OR REPLACE FUNCTION public.context_job_story_reading(p_job_id uuid)
RETURNS TABLE(generation_id uuid, evidence_until timestamptz)
LANGUAGE sql STABLE
AS $fn$
 SELECT g.id, g.evidence_until
 FROM public.context_ledger_generations g
 WHERE g.job_id = p_job_id AND g.status IN ('live', 'retired') AND g.promoted_at OPERATOR(pg_catalog.<=) pg_catalog.now()
 ORDER BY g.promoted_at DESC NULLS LAST, g.created_at DESC
 LIMIT 1
$fn$;
COMMENT ON FUNCTION public.context_job_story_reading(uuid) IS
 'Job story text (20261009100000): the job''s AI reading as the story card shows it now (context_job_story_ledger''s rule: the newest generation promoted by now, live or retired): generation_id and evidence_until; no row when there is none. Inlinable (no SET). Service role only.';

-- 7. The records a job's story is written from that change without the card being rebuilt:
-- its customer invoices' money state and its quotes' send, accept, decline and supersede times.
CREATE OR REPLACE FUNCTION public.context_job_story_record_sig(p_job_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT md5(concat_ws('|', 'record-sig-v1',
  (SELECT string_agg(concat_ws(',', x.id::text, upper(coalesce(x.status, '')), x.total::text, x.amount_due::text, x.amount_paid::text,
          to_char(x.fully_paid_on, 'YYYY-MM-DD'), to_char(x.due_date, 'YYYY-MM-DD'), x.invoice_number), ';' ORDER BY x.id)
   FROM public.xero_invoices x
   WHERE x.job_id = p_job_id AND upper(coalesce(x.invoice_type, 'ACCREC')) = 'ACCREC'),
  (SELECT string_agg(concat_ws(',', d.id::text,
          to_char(d.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), to_char(d.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'),
          to_char(d.declined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), to_char(d.superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')),
          ';' ORDER BY d.id)
   FROM public.job_documents d
   WHERE d.job_id = p_job_id AND d.type = 'quote')))
$fn$;
COMMENT ON FUNCTION public.context_job_story_record_sig(uuid) IS
 'Job story text (20261009100000): md5 of the job''s customer (ACCREC) invoices'' money state (status, total, amount due, amount paid, paid on, due date, number) and its quote documents'' sent, accepted, declined and superseded times (record-sig-v1). A Xero sync that rewrites a row without changing these leaves it alone, so only a real change wakes a rewrite. Service role only.';

-- 8. What the job looked like when a request was claimed (copied to the story it closes with).
CREATE OR REPLACE FUNCTION public.context_job_story_claim_state(p_job_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
 SELECT jsonb_build_object(
  'job_status', (SELECT jb.status::text FROM public.jobs jb WHERE jb.id = p_job_id),
  'record_sig', public.context_job_story_record_sig(p_job_id),
  'generation_id', (SELECT r.generation_id FROM public.context_job_story_reading(p_job_id) r),
  'evidence_until', (SELECT r.evidence_until FROM public.context_job_story_reading(p_job_id) r))
$fn$;
COMMENT ON FUNCTION public.context_job_story_claim_state(uuid) IS
 'Job story text (20261009100000): the job as a claim finds it: {job_status, record_sig (context_job_story_record_sig), generation_id and evidence_until (context_job_story_reading)}. Kept on the request; the story saved or confirmed unchanged by it carries these, so the sweep wakes only for what changed after the claim. Service role only.';

-- 9. Story calls left now, as the admission's story branch would answer.
CREATE OR REPLACE FUNCTION public.context_job_story_budget()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_pol jsonb; v_spol jsonb := public.context_job_story_text_policy(); v_now timestamptz := clock_timestamp(); v_local timestamp;
 v_date date; v_midnight timestamptz; v_on boolean; v_total integer; v_max integer; v_story integer; v_reserve_day integer;
 v_reserve_morning integer; r_cap integer; r_day integer; r_live integer; r_morning integer; v_left integer; v_reason text;
 v_resets timestamptz;
BEGIN
 v_local := v_now AT TIME ZONE 'Australia/Perth';
 v_date := v_local::date;
 v_midnight := (v_date + 1)::timestamp AT TIME ZONE 'Australia/Perth';
 v_on := public.context_job_story_text_on();
 IF NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('on', v_on, 'lane_on', false, 'calls_left', 0, 'reason', 'lane_off', 'resets_at', NULL, 'run_date', v_date,
   'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
 END IF;
 v_pol := public.context_cadence_policy();
 SELECT count(*)::integer, coalesce(max(m.ordinal), 0)::integer, (count(*) FILTER (WHERE m.phase = 'story'))::integer
 INTO v_total, v_max, v_story FROM public.context_model_call_reservations m WHERE m.run_date = v_date;
 r_cap := (v_pol ->> 'model_call_cap')::integer - v_max;
 IF r_cap <= 0 THEN
  RETURN jsonb_build_object('on', v_on, 'lane_on', true, 'calls_left', 0, 'reason', 'cap', 'resets_at', v_midnight, 'run_date', v_date,
   'story_calls_today', v_story, 'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
 END IF;
 IF NOT v_on THEN
  RETURN jsonb_build_object('on', false, 'lane_on', true, 'calls_left', 0, 'reason', 'story_off', 'resets_at', NULL, 'run_date', v_date,
   'story_calls_today', v_story, 'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
 END IF;
 -- the ledger's live reserve lines, read as plain values (a missing settings row leaves nothing)
 SELECT st.live_reserve_calls, st.live_reserve_calls_morning INTO v_reserve_day, v_reserve_morning
 FROM public.context_ledger_settings st WHERE st.id;
 r_day := (v_spol ->> 'calls_per_day')::integer - v_story;
 r_live := CASE WHEN v_reserve_day IS NULL THEN 0 ELSE ((v_pol ->> 'model_call_cap')::integer - v_reserve_day) - v_total END;
 IF v_local::time < (v_pol ->> 'morning_until')::time THEN
  r_morning := CASE WHEN v_reserve_morning IS NULL THEN 0 ELSE ((v_pol ->> 'morning_cap')::integer - v_reserve_morning) - v_total END;
 END IF;
 v_left := greatest(0, least(r_cap, r_day, r_live, coalesce(r_morning, r_cap)));
 v_reason := CASE WHEN r_day <= 0 THEN 'story_calls_per_day' WHEN r_live <= 0 THEN 'live_reserve'
  WHEN r_morning <= 0 THEN 'live_reserve_morning' END;
 v_resets := CASE WHEN r_morning IS NOT NULL AND r_morning <= least(r_cap, r_day, r_live)
  THEN (v_date + (v_pol ->> 'morning_until')::time) AT TIME ZONE 'Australia/Perth' ELSE v_midnight END;
 RETURN jsonb_build_object('on', true, 'lane_on', true, 'calls_left', v_left, 'reason', v_reason, 'resets_at', v_resets, 'run_date', v_date,
  'story_calls_today', v_story, 'calls_per_day', (v_spol ->> 'calls_per_day')::integer);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_budget() IS
 'Job story text (20261009100000): story model calls left now, as reserve_context_model_call''s story branch would answer: {on, lane_on, calls_left, reason, resets_at, run_date, story_calls_today, calls_per_day}. calls_left is the smallest of what is left under the day''s cap (context_cadence_policy model_call_cap), the story''s calls_per_day (context_job_story_text_policy), the ledger''s live reserve line (model_call_cap less context_ledger_settings.live_reserve_calls) and, before morning_until, its morning line (morning_cap less live_reserve_calls_morning). reason, when nothing is left, in the admission''s order: lane_off, cap, story_off, story_calls_per_day, live_reserve, live_reserve_morning; null while calls are left. resets_at: morning_until when the morning line binds, else the next Perth midnight; null when switched off. Service role only.';

-- 10. The admission: the 20261006060000 body plus the story branch (marked
-- "story"). A story call carries no run, as vision does, and runs on the
-- extraction lane. Every other phase takes exactly the path it took before.
CREATE OR REPLACE FUNCTION public.reserve_context_model_call(p_phase text,p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_now timestamptz; v_date date; v_ordinal integer; v_id uuid; r public.context_extraction_runs;
 v_ledger_mode text; v_ledger_calls integer; v_pol jsonb; v_calls integer; v_reserve_day integer; v_reserve_morning integer;
 v_story_calls integer;
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN ('attribution','extraction','bucket','vision','ledger','story')
 OR (p_run_id IS NULL) <> (p_lease_token IS NULL)
 OR (p_phase IN ('extraction','ledger') AND p_run_id IS NULL)
 OR (p_phase IN ('vision','story') AND p_run_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Invalid model call identity';
 END IF;
 PERFORM pg_advisory_xact_lock(20260911,1);
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger','story') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 PERFORM 1 FROM public.automation_switches WHERE id=1 FOR SHARE;
 IF NOT public.automation_lane_enabled(CASE WHEN p_phase IN ('extraction','vision','ledger','story') THEN 'extraction' ELSE 'attribution' END)
 OR (p_phase='vision' AND NOT public.automation_lane_enabled('capture'))
 THEN RETURN jsonb_build_object('outcome','paused'); END IF;
 IF p_run_id IS NOT NULL THEN
  SELECT * INTO r FROM public.context_extraction_runs WHERE id=p_run_id FOR UPDATE;
 END IF;
 v_now := clock_timestamp();
 v_date := (v_now AT TIME ZONE 'Australia/Perth')::date;
 IF p_run_id IS NOT NULL AND (r.id IS NULL OR r.lease_token IS DISTINCT FROM p_lease_token
 OR r.phase IS DISTINCT FROM p_phase OR r.status <> 'running'
 OR r.lease_expires_at IS NULL OR r.lease_expires_at <= v_now OR r.run_date <> v_date)
 THEN RETURN jsonb_build_object('outcome','stale'); END IF;
 -- call budget (20261006060000): the day's cap and attribution's share are the
 -- policy's numbers (owner ruling 6 Oct 2026: 1,000 calls, 300 for placement).
 v_pol := public.context_cadence_policy();
 SELECT coalesce(max(ordinal),0)+1 INTO v_ordinal FROM public.context_model_call_reservations WHERE run_date=v_date;
 IF v_ordinal>(v_pol->>'model_call_cap')::integer THEN RETURN jsonb_build_object('outcome','cap'); END IF;
 -- A1: attribution may use at most attribution_calls_day of the day's calls.
 IF p_phase='attribution' AND (SELECT count(*) FROM public.context_model_call_reservations
   WHERE run_date=v_date AND phase='attribution')>=(v_pol->>'attribution_calls_day')::integer
 THEN RETURN jsonb_build_object('outcome','attribution_budget','run_date',v_date,'limit',(v_pol->>'attribution_calls_day')::integer); END IF;
 -- ledger: only while the lane is switched on, within its own daily ceiling,
 -- and never inside its own live reserve (context_ledger_settings, all day and
 -- before noon), whatever reserve the fact backlog keeps.
 IF p_phase='ledger' THEN
  -- plain variables, read only here: no other phase depends on the ledger table
  SELECT st.mode, st.calls_per_day, st.live_reserve_calls, st.live_reserve_calls_morning
  INTO v_ledger_mode, v_ledger_calls, v_reserve_day, v_reserve_morning FROM public.context_ledger_settings st WHERE st.id;
  IF v_ledger_mode IS NULL OR v_ledger_mode='off' THEN RETURN jsonb_build_object('outcome','ledger_off'); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='ledger')>=v_ledger_calls
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','ledger_calls_per_day','run_date',v_date,'limit',v_ledger_calls); END IF;
  SELECT count(*) INTO v_calls FROM public.context_model_call_reservations WHERE run_date=v_date;
  IF v_calls>=(v_pol->>'model_call_cap')::integer-v_reserve_day
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve','run_date',v_date,
   'ceiling',(v_pol->>'model_call_cap')::integer-v_reserve_day); END IF;
  IF (v_now AT TIME ZONE 'Australia/Perth')::time<(v_pol->>'morning_until')::time
   AND v_calls>=(v_pol->>'morning_cap')::integer-v_reserve_morning
  THEN RETURN jsonb_build_object('outcome','ledger_budget','reason','live_reserve_morning','run_date',v_date,
   'ceiling',(v_pol->>'morning_cap')::integer-v_reserve_morning); END IF;
 END IF;
 -- story (20261009100000): the saved job story writer, only while its switch
 -- (feature_flags.context_job_story_text_v1) is on, within its own daily
 -- ceiling (context_job_story_text_policy calls_per_day), and never inside the
 -- ledger's live reserve lines (context_ledger_settings, all day and before
 -- noon), read as plain values so no other phase depends on either table.
 IF p_phase='story' THEN
  IF NOT public.context_job_story_text_on() THEN RETURN jsonb_build_object('outcome','story_off'); END IF;
  v_story_calls := (public.context_job_story_text_policy()->>'calls_per_day')::integer;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='story')>=v_story_calls
  THEN RETURN jsonb_build_object('outcome','story_budget','reason','story_calls_per_day','run_date',v_date,'limit',v_story_calls); END IF;
  SELECT st.live_reserve_calls, st.live_reserve_calls_morning
  INTO v_reserve_day, v_reserve_morning FROM public.context_ledger_settings st WHERE st.id;
  SELECT count(*) INTO v_calls FROM public.context_model_call_reservations WHERE run_date=v_date;
  IF v_reserve_day IS NULL OR v_calls>=(v_pol->>'model_call_cap')::integer-v_reserve_day
  THEN RETURN jsonb_build_object('outcome','story_budget','reason','live_reserve','run_date',v_date,
   'ceiling',(v_pol->>'model_call_cap')::integer-coalesce(v_reserve_day,(v_pol->>'model_call_cap')::integer)); END IF;
  IF (v_now AT TIME ZONE 'Australia/Perth')::time<(v_pol->>'morning_until')::time
   AND (v_reserve_morning IS NULL OR v_calls>=(v_pol->>'morning_cap')::integer-v_reserve_morning)
  THEN RETURN jsonb_build_object('outcome','story_budget','reason','live_reserve_morning','run_date',v_date,
   'ceiling',(v_pol->>'morning_cap')::integer-coalesce(v_reserve_morning,(v_pol->>'morning_cap')::integer)); END IF;
 END IF;
 -- B-5b: vision only while the job reads keep their share, and within its own daily cap.
 IF p_phase='vision' THEN
  IF v_ordinal>(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer
  THEN RETURN jsonb_build_object('outcome','vision_reserve','run_date',v_date,
   'ceiling',(public.context_document_vision_policy()->>'shared_calls_ceiling')::integer); END IF;
  IF (SELECT count(*) FROM public.context_model_call_reservations WHERE run_date=v_date AND phase='vision')
   >=public.context_document_vision_daily_cap()
  THEN RETURN jsonb_build_object('outcome','vision_budget','run_date',v_date,'limit',public.context_document_vision_daily_cap()); END IF;
 END IF;
 INSERT INTO public.context_model_call_reservations(run_date,ordinal,phase,run_id,lease_token,reserved_at)
 VALUES(v_date,v_ordinal,p_phase,p_run_id,p_lease_token,v_now) RETURNING id INTO v_id;
 RETURN jsonb_build_object('outcome','reserved','reservation_id',v_id,'run_date',v_date,'ordinal',v_ordinal);
END $$;
REVOKE ALL ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) TO service_role;
COMMENT ON FUNCTION public.reserve_context_model_call(text,uuid,uuid) IS
 'The one admission for every context model call: model_call_cap a Perth day (1000 since the call budget, 20261006060000; was 400). Attribution at most attribution_calls_day (300; was 60); both read from context_cadence_policy(). Vision within its share and daily cap (20261006001000); ledger (20261006013000) only while context_ledger_settings.mode is not off, under calls_per_day, and never inside its own live reserve (model_call_cap less context_ledger_settings.live_reserve_calls; before morning_until morning_cap less live_reserve_calls_morning), apart from the fact backlog''s context_cadence_settings. Outcomes reserved, paused, stale, cap, attribution_budget, vision_reserve, vision_budget, ledger_off, ledger_budget. Story (20261009100000): the saved job story writer (phase story, no run, the extraction lane) only while feature_flags.context_job_story_text_v1 is on (else story_off), under context_job_story_text_policy() calls_per_day story calls a Perth day (else story_budget, reason story_calls_per_day) and never inside the ledger''s live reserve lines (model_call_cap less context_ledger_settings.live_reserve_calls; before morning_until morning_cap less live_reserve_calls_morning; else story_budget, reason live_reserve or live_reserve_morning; no settings row leaves nothing). Every other phase as before. Outcomes also story_off, story_budget.';

-- 11. The queue and the stories.
CREATE TABLE IF NOT EXISTS public.context_job_story_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 requested_at timestamptz NOT NULL DEFAULT now(),
 -- who asked: user:<id> from the verified session, a server caller's actor, or the writer's own sweep
 requested_by text NOT NULL,
 reason text NOT NULL,
 picked_at timestamptz,
 lease_token uuid,
 lease_expires_at timestamptz,
 attempts smallint NOT NULL DEFAULT 0,
 next_attempt_at timestamptz,
 -- the job as the claim found it (context_job_story_claim_state)
 claimed_state jsonb,
 done_at timestamptz,
 outcome text,
 error text,
 CONSTRAINT context_job_story_requests_by CHECK (requested_by ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
 CONSTRAINT context_job_story_requests_reason CHECK (reason IN ('asked', 'job_changed')),
 CONSTRAINT context_job_story_requests_lease CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)
  AND (lease_token IS NULL OR picked_at IS NOT NULL)),
 CONSTRAINT context_job_story_requests_done CHECK (done_at IS NULL OR lease_token IS NULL),
 CONSTRAINT context_job_story_requests_outcome CHECK ((done_at IS NULL) = (outcome IS NULL)
  AND (outcome IS NULL OR outcome IN ('written', 'unchanged', 'failed'))
  AND (outcome IS DISTINCT FROM 'failed' OR error IS NOT NULL)),
 CONSTRAINT context_job_story_requests_error CHECK (error IS NULL OR error ~ '^[a-z0-9_]{1,64}$'),
 CONSTRAINT context_job_story_requests_attempts CHECK (attempts BETWEEN 0 AND 100),
 CONSTRAINT context_job_story_requests_claimed CHECK (claimed_state IS NULL
  OR (jsonb_typeof(claimed_state) = 'object' AND octet_length(claimed_state::text) <= 2048))
);
CREATE UNIQUE INDEX IF NOT EXISTS context_job_story_requests_one_open ON public.context_job_story_requests (job_id) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS context_job_story_requests_due ON public.context_job_story_requests (next_attempt_at, requested_at) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS context_job_story_requests_job ON public.context_job_story_requests (job_id, requested_at DESC);
ALTER TABLE public.context_job_story_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_job_story_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_job_story_requests TO service_role;
COMMENT ON TABLE public.context_job_story_requests IS
 'Job story text (20261009100000): requests to write or rewrite a job''s saved story. reason asked (staff, ops-api request_job_story) or job_changed (the writer''s sweep, context_job_story_enqueue_changed). At most one open (done_at null) a job. A claim leases it (picked_at, lease_token, lease_expires_at; claimed_state: the job as the claim found it); it closes written (context_job_story_text_save), unchanged or failed with an error code (context_job_story_request_finish), or is released for a retry (attempts, next_attempt_at). Codes only, never words. RLS on with no policy; the service role reads; written only through the functions.';

CREATE TABLE IF NOT EXISTS public.context_job_story_texts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 request_id uuid REFERENCES public.context_job_story_requests(id) ON DELETE SET NULL,
 written_at timestamptz NOT NULL DEFAULT now(),
 -- the instant the story is known to cover: its claim's picked_at, moved on by an unchanged check
 checked_at timestamptz NOT NULL,
 -- the newest evidence the story covers and the AI reading it read (the card's meta.ledger)
 evidence_until timestamptz,
 generation_id uuid,
 -- the job's status and record signature at checked_at (the sweep's cheap signals)
 job_status text,
 record_sig text,
 card_hash text NOT NULL,
 model text NOT NULL,
 prompt_sha256 text,
 sections jsonb NOT NULL,
 checks jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL DEFAULT 'current',
 superseded_at timestamptz,
 CONSTRAINT context_job_story_texts_card_hash CHECK (card_hash ~ '^[0-9a-f]{32}$'),
 CONSTRAINT context_job_story_texts_record_sig CHECK (record_sig IS NULL OR record_sig ~ '^[0-9a-f]{32}$'),
 CONSTRAINT context_job_story_texts_model CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
 CONSTRAINT context_job_story_texts_prompt CHECK (prompt_sha256 IS NULL OR prompt_sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT context_job_story_texts_sections CHECK (public.context_job_story_sections_problem(sections) IS NULL),
 CONSTRAINT context_job_story_texts_checks CHECK (public.context_job_story_checks_problem(checks) IS NULL),
 CONSTRAINT context_job_story_texts_status CHECK (status IN ('current', 'superseded')
  AND (status = 'superseded') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS context_job_story_texts_one_current ON public.context_job_story_texts (job_id) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS context_job_story_texts_job ON public.context_job_story_texts (job_id, written_at DESC);
ALTER TABLE public.context_job_story_texts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_job_story_texts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.context_job_story_texts TO service_role;
COMMENT ON TABLE public.context_job_story_texts IS
 'Job story text (20261009100000): the saved, written story of a job (five plain sections: headline, the_job, how_we_got_here, where_it_is_at, watch_out), written by the Luna context worker from the job''s story card and live AI notes only and fact checked against them. At most one current a job; a newer one supersedes it (superseded_at). card_hash is context_job_story_card_hash of the card it was written from; fresh while it equals the hash of the card now (context_job_story_text_get). checked_at: the instant it is known to cover. checks: the writer''s fact check, codes and counts only. Holds customer details: RLS on with no policy, the service role reads (ops-api job_overview, staff only), written only through context_job_story_text_save.';

-- 12. The staff read: the current story, whether it is still current, and the writer's state.
CREATE OR REPLACE FUNCTION public.context_job_story_text_get(p_job_id uuid, p_card jsonb DEFAULT NULL, p_check boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE t public.context_job_story_texts; r public.context_job_story_requests; v_card jsonb; v_hash text; v_status text;
 v_fail_error text; v_fail_at timestamptz;
BEGIN
 IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RETURN NULL;
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 IF coalesce(p_check, true) THEN
  -- the card the caller just read, else built now (only when there is a story to compare)
  v_card := coalesce(p_card, CASE WHEN t.id IS NOT NULL THEN public.context_job_story(p_job_id, now()) END);
  -- a card that is not this job's is no answer
  IF v_card IS NOT NULL AND (v_card #>> '{job,id}') IS DISTINCT FROM p_job_id::text THEN
   v_card := NULL;
  END IF;
  v_hash := public.context_job_story_card_hash(v_card);
 END IF;
 v_status := CASE WHEN t.id IS NULL THEN 'none' WHEN v_hash IS NULL THEN 'unchecked'
                  WHEN v_hash = t.card_hash THEN 'fresh' ELSE 'stale' END;
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.job_id = p_job_id AND q.done_at IS NULL;
 SELECT q.error, q.done_at INTO v_fail_error, v_fail_at FROM public.context_job_story_requests q
 WHERE q.job_id = p_job_id AND q.outcome = 'failed' AND q.done_at > coalesce(t.written_at, '-infinity'::timestamptz)
 ORDER BY q.done_at DESC, q.id DESC LIMIT 1;
 RETURN jsonb_build_object(
  'version', 'job-story-text-v1',
  'job_id', p_job_id,
  'status', v_status,
  'card_hash', v_hash,
  'text', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('id', t.id, 'written_at', t.written_at, 'checked_at', t.checked_at,
           'evidence_until', t.evidence_until, 'generation_id', t.generation_id, 'card_hash', t.card_hash, 'model', t.model,
           'sections', t.sections,
           'inputs', CASE WHEN jsonb_typeof(t.checks -> 'inputs') = 'object' THEN t.checks -> 'inputs' ELSE '{}'::jsonb END) END,
  'writer', jsonb_build_object(
   'on', public.context_job_story_text_on(),
   'open_request', CASE WHEN r.id IS NOT NULL THEN jsonb_build_object('id', r.id, 'reason', r.reason, 'requested_at', r.requested_at,
                    'picked_at', r.picked_at, 'attempts', r.attempts, 'next_attempt_at', r.next_attempt_at) END,
   'last_failure', CASE WHEN v_fail_at IS NOT NULL THEN jsonb_build_object('error', v_fail_error, 'at', v_fail_at) END));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_text_get(uuid, jsonb, boolean) IS
 'Job story text (20261009100000): the saved story of one job for the staff door (ops-api job_overview): {version job-story-text-v1, job_id, status, card_hash, text, writer}. status: none (no story), fresh (its card_hash equals the hash of the card now), stale, or unchecked (not compared: p_check false, or no card of this job). p_card: the job-story-v1 card the caller has just read (hashed as it is; a card of another job is ignored); null builds context_job_story(job, now()) when there is a story to compare. text: {id, written_at, checked_at, evidence_until, generation_id, card_hash, model, sections, inputs (the writer''s input counts)} or null. writer: {on (the switch), open_request {id, reason, requested_at, picked_at, attempts, next_attempt_at} or null, last_failure {error, at} newer than the story, or null}. NULL for an unknown job. Read only. Service role only.';

-- 13. Ask for a story (staff), idempotent and rate limited.
CREATE OR REPLACE FUNCTION public.context_job_story_request(p_job_id uuid, p_by text, p_reason text DEFAULT 'asked')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); r public.context_job_story_requests; t public.context_job_story_texts;
 v_card jsonb; v_monitored boolean; v_id uuid; v_at timestamptz;
BEGIN
 IF p_job_id IS NULL OR p_by IS NULL OR p_by !~ '^[A-Za-z0-9_.:@-]{1,128}$' OR p_reason IS NULL OR p_reason NOT IN ('asked', 'job_changed')
  OR NOT EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id) THEN
  RAISE EXCEPTION 'context_job_story_request_invalid' USING ERRCODE = '22023';
 END IF;
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off');
 END IF;
 -- one decision at a time per job
 PERFORM pg_advisory_xact_lock(20261009, hashtext(p_job_id::text));
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.job_id = p_job_id AND q.done_at IS NULL;
 IF r.id IS NOT NULL THEN
  RETURN jsonb_build_object('outcome', 'already_open', 'request_id', r.id, 'requested_at', r.requested_at, 'reason', r.reason);
 END IF;
 IF p_reason = 'job_changed' THEN
  SELECT m.monitored INTO v_monitored FROM public.context_lead_monitored_jobs(ARRAY[p_job_id], now()) m;
  IF NOT coalesce(v_monitored, false) OR EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = p_job_id
     AND (jb.status::text IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
          OR coalesce(jb.metadata ->> 'do_not_schedule', '') IN ('true', '1'))) THEN
   RETURN jsonb_build_object('outcome', 'not_live');
  END IF;
 END IF;
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 IF t.id IS NOT NULL AND t.written_at > now() - make_interval(mins => (pol ->> 'min_rewrite_minutes')::integer) THEN
  v_card := public.context_job_story(p_job_id, now());
  IF v_card IS NOT NULL AND public.context_job_story_card_hash(v_card) = t.card_hash THEN
   RETURN jsonb_build_object('outcome', 'recent', 'text_id', t.id, 'written_at', t.written_at);
  END IF;
 END IF;
 INSERT INTO public.context_job_story_requests (job_id, requested_by, reason) VALUES (p_job_id, p_by, p_reason)
 RETURNING id, requested_at INTO v_id, v_at;
 RETURN jsonb_build_object('outcome', 'queued', 'request_id', v_id, 'requested_at', v_at, 'reason', p_reason);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_request(uuid, text, text) IS
 'Job story text (20261009100000): asks for a job''s story to be written or rewritten: {outcome queued|already_open|recent|off|not_live, request_id, requested_at, reason}. off while the switch is off (nothing written); already_open returns the open request (idempotent; one open a job); recent while the current story is under min_rewrite_minutes old and its card_hash still equals the hash of the card now (the card is built once, only then); job_changed only for a live, monitored job (context_lead_monitored_jobs; else not_live), asked on any job. p_by: user:<id> from the verified session, or a server caller''s actor (letters, digits and _ . : @ -, 1 to 128). Raises context_job_story_request_invalid for bad arguments or an unknown job. Takes the job''s advisory lock (20261009). Service role only.';

-- 14. The writer's sweep: the one rule for "something new happened".
CREATE OR REPLACE FUNCTION public.context_job_story_enqueue_changed(p_limit integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); v_cap integer; v_limit integer; v_rewrite interval; v_quiet interval;
 v_cand uuid[]; v_jobs uuid[]; v_ids jsonb;
BEGIN
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off', 'queued', 0, 'job_ids', '[]'::jsonb);
 END IF;
 v_cap := (pol ->> 'enqueue_per_call')::integer;
 v_limit := least(greatest(coalesce(p_limit, v_cap), 0), v_cap);
 IF v_limit = 0 THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 v_rewrite := make_interval(mins => (pol ->> 'min_rewrite_minutes')::integer);
 v_quiet := make_interval(mins => (pol ->> 'quiet_minutes')::integer);
 -- 1. Cheap signals first: a current story older than the rewrite floor, no open request, a live job, and
 --    something newer than the story covers: the job's status, its AI reading (a new generation, or the
 --    same one read further), its customer invoices' money or its quotes' times (only when a row was
 --    touched since, then confirmed by the record signature), or, with no AI reading at all, a message
 --    row recorded since that has been quiet for quiet_minutes. Oldest checked first.
 SELECT array_agg(c.job_id ORDER BY c.checked_at, c.job_id) INTO v_cand
 FROM (
  SELECT t.job_id, t.checked_at
  FROM public.context_job_story_texts t
  JOIN public.jobs jb ON jb.id = t.job_id
  LEFT JOIN LATERAL public.context_job_story_reading(t.job_id) lg ON true
  WHERE t.status = 'current'
    AND t.written_at <= now() - v_rewrite
    AND NOT EXISTS (SELECT 1 FROM public.context_job_story_requests q WHERE q.job_id = t.job_id AND q.done_at IS NULL)
    AND jb.status::text NOT IN ('cancelled', 'draft', 'archived', 'complete', 'completed', 'lost')
    AND coalesce(jb.metadata ->> 'do_not_schedule', '') NOT IN ('true', '1')
    AND (jb.status::text IS DISTINCT FROM t.job_status
         OR lg.generation_id IS DISTINCT FROM t.generation_id
         OR date_trunc('milliseconds', lg.evidence_until) IS DISTINCT FROM date_trunc('milliseconds', t.evidence_until)
         OR ((EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_id = t.job_id AND x.updated_at > t.checked_at)
              OR EXISTS (SELECT 1 FROM public.job_documents d WHERE d.job_id = t.job_id AND d.type = 'quote'
                         AND greatest(d.sent_at, d.accepted_at, d.declined_at, d.superseded_at) > t.checked_at))
             AND public.context_job_story_record_sig(t.job_id) IS DISTINCT FROM t.record_sig)
         OR (lg.generation_id IS NULL AND EXISTS (
              SELECT 1 FROM public.business_events e
              WHERE e.job_id = t.job_id
                AND (e.channel IN ('sms', 'email', 'call', 'note', 'whatsapp', 'chat')
                     OR e.event_type IN ('client.reply', 'client.email_in', 'client.email_out', 'client.sms_in', 'client.sms_out',
                       'client.call_complete', 'client.call_logged', 'call.transcript_completed', 'client.message_in',
                       'supplier.email_in', 'ghl.note_added', 'note.added'))
                AND e.metadata #>> '{duplicate_of}' IS NULL
                AND coalesce(e.recorded_at, e.occurred_at) > t.checked_at
                AND coalesce(e.recorded_at, e.occurred_at) <= now() - v_quiet)))
  ORDER BY t.checked_at, t.job_id
  LIMIT v_limit * 10
 ) c;
 IF v_cand IS NULL THEN
  RETURN jsonb_build_object('outcome', 'queued', 'queued', 0, 'job_ids', '[]'::jsonb, 'candidates', 0);
 END IF;
 -- 2. Then the lead rule, for the survivors only: a lead no longer followed up is never rewritten by itself.
 SELECT array_agg(m.job_id ORDER BY array_position(v_cand, m.job_id)) INTO v_jobs
 FROM public.context_lead_monitored_jobs(v_cand, now()) m WHERE m.monitored;
 WITH ins AS (
  INSERT INTO public.context_job_story_requests (job_id, requested_by, reason)
  SELECT j.job_id, pol ->> 'writer', 'job_changed'
  FROM unnest(coalesce(v_jobs, '{}'::uuid[])) WITH ORDINALITY AS j(job_id, ord)
  WHERE j.ord <= v_limit
  ON CONFLICT (job_id) WHERE done_at IS NULL DO NOTHING
  RETURNING job_id)
 SELECT coalesce(jsonb_agg(ins.job_id ORDER BY ins.job_id), '[]'::jsonb) INTO v_ids FROM ins;
 RETURN jsonb_build_object('outcome', 'queued', 'queued', jsonb_array_length(v_ids), 'job_ids', v_ids, 'candidates', cardinality(v_cand));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_enqueue_changed(integer) IS
 'Job story text (20261009100000): the one rule for "something new happened" (SQL decides what is due; the worker calls it each tick): queues reason job_changed, requested_by luna-story-writer, for at most p_limit (default and most enqueue_per_call, 5) jobs: a current story written more than min_rewrite_minutes ago, no open request, a live job (not cancelled, draft, archived, complete, completed or lost, never a holding job), monitored by the lead rule (context_lead_monitored_jobs, read only for the jobs the cheap signals keep), and something newer than the story covers: the job''s status differs from the story''s; its AI reading (context_job_story_reading) is another generation or reads to another evidence_until; a customer invoice or quote row was touched since checked_at and the record signature (context_job_story_record_sig) differs; or, with no AI reading, a message row (not a copy) recorded since checked_at and quiet for quiet_minutes. Oldest checked first. {outcome off|queued, queued, job_ids, candidates}. Service role only.';

-- 15. The worker's claim: lease due requests (asked first).
CREATE OR REPLACE FUNCTION public.context_job_story_claim(p_limit integer DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); b jsonb; v_limit integer; v_lease interval; v_out jsonb; v_closed integer;
BEGIN
 IF NOT public.context_job_story_text_on() THEN
  RETURN jsonb_build_object('outcome', 'off', 'reason', 'story_off', 'requests', '[]'::jsonb);
 END IF;
 IF NOT public.automation_lane_enabled('extraction') THEN
  RETURN jsonb_build_object('outcome', 'off', 'reason', 'lane_off', 'requests', '[]'::jsonb);
 END IF;
 b := public.context_job_story_budget();
 IF coalesce((b ->> 'calls_left')::integer, 0) < 1 THEN
  RETURN jsonb_build_object('outcome', 'budget', 'reason', b -> 'reason', 'resets_at', b -> 'resets_at', 'requests', '[]'::jsonb);
 END IF;
 -- A request that used its attempts closes failed (never while another worker holds its lease).
 WITH dead AS (
  SELECT q.id FROM public.context_job_story_requests q
  WHERE q.done_at IS NULL AND q.attempts >= (pol ->> 'max_attempts')::integer
    AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= now())
  FOR UPDATE SKIP LOCKED
 ), closed AS (
  UPDATE public.context_job_story_requests q SET done_at = now(), outcome = 'failed', error = 'max_attempts',
   lease_token = NULL, lease_expires_at = NULL
  FROM dead WHERE q.id = dead.id
  RETURNING q.id)
 SELECT count(*)::integer INTO v_closed FROM closed;
 v_limit := least(greatest(coalesce(p_limit, 1), 1), 5);
 v_lease := make_interval(mins => (pol ->> 'lease_minutes')::integer);
 -- Due: open, no live lease, its wait over. A lease that ran out with no answer counts as an attempt.
 WITH due AS (
  SELECT q.id FROM public.context_job_story_requests q
  WHERE q.done_at IS NULL AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= now())
    AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
  ORDER BY (q.reason = 'asked') DESC, q.requested_at, q.id
  LIMIT v_limit
  FOR UPDATE SKIP LOCKED
 ), upd AS (
  UPDATE public.context_job_story_requests q SET
   attempts = q.attempts + CASE WHEN q.lease_token IS NOT NULL THEN 1 ELSE 0 END,
   picked_at = now(), lease_token = gen_random_uuid(), lease_expires_at = now() + v_lease,
   claimed_state = public.context_job_story_claim_state(q.job_id)
  FROM due WHERE q.id = due.id
  RETURNING q.id, q.job_id, q.lease_token, q.lease_expires_at, q.reason, q.attempts, q.requested_at)
 SELECT coalesce(jsonb_agg(jsonb_build_object('request_id', u.id, 'job_id', u.job_id, 'lease_token', u.lease_token,
   'lease_expires_at', u.lease_expires_at, 'reason', u.reason, 'attempts', u.attempts)
   ORDER BY (u.reason = 'asked') DESC, u.requested_at, u.id), '[]'::jsonb) INTO v_out FROM upd u;
 IF jsonb_array_length(v_out) = 0 THEN
  RETURN jsonb_build_object('outcome', 'idle', 'closed', v_closed, 'requests', '[]'::jsonb);
 END IF;
 RETURN jsonb_build_object('outcome', 'claimed', 'closed', v_closed, 'requests', v_out);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_claim(integer) IS
 'Job story text (20261009100000): the writer''s claim. off (reason story_off: the switch; lane_off: the extraction lane) or budget (context_job_story_budget has no call left: reason and resets_at) with nothing claimed; else first closes any open request with attempts at max_attempts as failed (error max_attempts), then leases up to p_limit (1 to 5) due requests (open, no live lease, next_attempt_at passed) with FOR UPDATE SKIP LOCKED, asked first, then oldest: picked_at now, a new lease_token, lease_expires_at now plus lease_minutes, claimed_state (context_job_story_claim_state); a request whose earlier lease ran out with no answer counts that attempt. {outcome off|budget|idle|claimed, reason, resets_at, closed, requests [{request_id, job_id, lease_token, lease_expires_at, reason, attempts}]}. Service role only.';

-- 16. What the writer reads, from one snapshot.
CREATE OR REPLACE FUNCTION public.context_job_story_writer_input(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_status text; v_card jsonb; t public.context_job_story_texts;
BEGIN
 SELECT jb.status::text INTO v_status FROM public.jobs jb WHERE jb.id = p_job_id;
 IF NOT FOUND THEN
  RETURN NULL;
 END IF;
 v_card := public.context_job_story(p_job_id, now());
 SELECT * INTO t FROM public.context_job_story_texts x WHERE x.job_id = p_job_id AND x.status = 'current';
 RETURN jsonb_build_object(
  'version', 'story-writer-input-v1',
  'job_id', p_job_id,
  'as_of', now(),
  'job_status', v_status,
  'card', v_card,
  'card_hash', public.context_job_story_card_hash(v_card),
  'current', CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('text_id', t.id, 'card_hash', t.card_hash,
              'written_at', t.written_at, 'checked_at', t.checked_at) END,
  'notes', public.context_job_story_ledger(p_job_id, NULL, now()),
  -- call transcripts on the job: never prompt text (speakers unlabelled, names misheard)
  'transcript_row_ids', coalesce((SELECT jsonb_agg(e.id::text ORDER BY e.id) FROM public.business_events e
                                  WHERE e.job_id = p_job_id AND e.event_type = 'call.transcript_completed'), '[]'::jsonb));
END $fn$;
COMMENT ON FUNCTION public.context_job_story_writer_input(uuid) IS
 'Job story text (20261009100000): everything the story writer reads, from one snapshot (STABLE): {version story-writer-input-v1, job_id, as_of, job_status, card (context_job_story(job, now())), card_hash (context_job_story_card_hash of that card), current {text_id, card_hash, written_at, checked_at} or null, notes (context_job_story_ledger(job, null, now()): the live AI reading with every citation re-checked), transcript_row_ids (the job''s call.transcript_completed rows: their words are never prompt text)}. NULL for an unknown job. Read only. Service role only.';

-- 17. Save a written story: supersede the old one and close the request, in one transaction.
CREATE OR REPLACE FUNCTION public.context_job_story_text_save(p_request_id uuid, p_lease_token uuid, p_job_id uuid, p_sections jsonb,
 p_card_hash text, p_evidence_until timestamptz, p_generation_id uuid, p_model text, p_prompt_sha256 text, p_checks jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE r public.context_job_story_requests; v_problem text; v_old uuid; v_new uuid; v_checks jsonb := coalesce(p_checks, '{}'::jsonb);
BEGIN
 IF p_request_id IS NULL OR p_lease_token IS NULL OR p_job_id IS NULL THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'ids_required');
 END IF;
 -- the job's lock first (as a request takes it), then the request row
 PERFORM pg_advisory_xact_lock(20261009, hashtext(p_job_id::text));
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.id = p_request_id FOR UPDATE;
 IF r.id IS NULL OR r.done_at IS NOT NULL OR r.lease_token IS DISTINCT FROM p_lease_token
  OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 IF r.job_id <> p_job_id THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'job_mismatch');
 END IF;
 v_problem := public.context_job_story_sections_problem(p_sections);
 IF v_problem IS NOT NULL THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'sections_invalid', 'problem', v_problem);
 END IF;
 IF p_card_hash IS NULL OR p_card_hash !~ '^[0-9a-f]{32}$' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'card_hash_invalid');
 END IF;
 IF p_model IS NULL OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'model_invalid');
 END IF;
 IF p_prompt_sha256 IS NOT NULL AND p_prompt_sha256 !~ '^[0-9a-f]{64}$' THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'prompt_sha256_invalid');
 END IF;
 v_problem := public.context_job_story_checks_problem(v_checks);
 IF v_problem IS NOT NULL THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'checks_invalid', 'problem', v_problem);
 END IF;
 UPDATE public.context_job_story_texts SET status = 'superseded', superseded_at = now()
 WHERE job_id = p_job_id AND status = 'current'
 RETURNING id INTO v_old;
 INSERT INTO public.context_job_story_texts (job_id, request_id, checked_at, evidence_until, generation_id, job_status, record_sig,
  card_hash, model, prompt_sha256, sections, checks)
 VALUES (p_job_id, r.id, r.picked_at,
  coalesce(p_evidence_until, (r.claimed_state ->> 'evidence_until')::timestamptz),
  coalesce(p_generation_id, (r.claimed_state ->> 'generation_id')::uuid),
  coalesce(r.claimed_state ->> 'job_status', (SELECT jb.status::text FROM public.jobs jb WHERE jb.id = p_job_id)),
  r.claimed_state ->> 'record_sig',
  p_card_hash, p_model, p_prompt_sha256, p_sections, v_checks)
 RETURNING id INTO v_new;
 UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'written', error = NULL, lease_token = NULL, lease_expires_at = NULL
 WHERE id = r.id;
 RETURN jsonb_build_object('outcome', 'saved', 'text_id', v_new, 'superseded_id', v_old);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_text_save(uuid, uuid, uuid, jsonb, text, timestamptz, uuid, text, text, jsonb) IS
 'Job story text (20261009100000): saves a written story for a claimed request: {outcome saved, text_id, superseded_id} | {outcome lease_lost} (the request is not open, the token is not its lease, or the lease ran out) | {outcome refused, reason ids_required|job_mismatch|sections_invalid|card_hash_invalid|model_invalid|prompt_sha256_invalid|checks_invalid, problem}. In one transaction, under the job''s advisory lock and the request row''s lock: the current story becomes superseded, the new one is current (request_id; checked_at the claim''s picked_at; evidence_until and generation_id as given, else as the claim found them; job_status and record_sig as the claim found them), and the request closes written with its lease cleared. p_card_hash: context_job_story_card_hash of the card the words were written from (story-writer-input-v1 card_hash). Service role only.';

-- 18. Close or release a claimed request without saving a story.
CREATE OR REPLACE FUNCTION public.context_job_story_request_finish(p_request_id uuid, p_lease_token uuid, p_outcome text,
 p_error text DEFAULT NULL, p_retry_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE pol jsonb := public.context_job_story_text_policy(); r public.context_job_story_requests; v_stop boolean; v_attempts integer;
 v_retry timestamptz; v_waits jsonb; v_text uuid;
 stops constant text[] := ARRAY['story_off', 'story_budget', 'model_cap', 'cap', 'paused', 'model_admission_paused', 'switch_off',
  'rate_limited', 'auth_required', 'worker_stopping'];
BEGIN
 IF p_request_id IS NULL OR p_lease_token IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('unchanged', 'failed', 'released')
  OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,64}$') OR (p_outcome = 'failed' AND p_error IS NULL) THEN
  RAISE EXCEPTION 'context_job_story_finish_invalid' USING ERRCODE = '22023';
 END IF;
 SELECT * INTO r FROM public.context_job_story_requests q WHERE q.id = p_request_id FOR UPDATE;
 IF r.id IS NULL OR r.done_at IS NOT NULL OR r.lease_token IS DISTINCT FROM p_lease_token
  OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 IF p_outcome = 'unchanged' THEN
  -- the story still says what the card says: it now covers the claim, and the job as the claim found it
  UPDATE public.context_job_story_texts t SET
   checked_at = greatest(t.checked_at, r.picked_at),
   job_status = coalesce(r.claimed_state ->> 'job_status', t.job_status),
   record_sig = coalesce(r.claimed_state ->> 'record_sig', t.record_sig),
   generation_id = CASE WHEN r.claimed_state ? 'generation_id' THEN (r.claimed_state ->> 'generation_id')::uuid ELSE t.generation_id END,
   evidence_until = CASE WHEN r.claimed_state ? 'evidence_until' THEN (r.claimed_state ->> 'evidence_until')::timestamptz ELSE t.evidence_until END
  WHERE t.job_id = r.job_id AND t.status = 'current'
  RETURNING t.id INTO v_text;
  UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'unchanged', error = NULL, lease_token = NULL, lease_expires_at = NULL
  WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'closed', 'closed_as', 'unchanged', 'text_id', v_text);
 END IF;
 IF p_outcome = 'failed' THEN
  UPDATE public.context_job_story_requests SET done_at = now(), outcome = 'failed', error = p_error, lease_token = NULL, lease_expires_at = NULL
  WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'closed', 'closed_as', 'failed', 'error', p_error);
 END IF;
 -- released: a stop (the switch, the budget, a pause, a login, a rate limit, the worker stopping) is no
 -- attempt and waits 5 minutes unless told when; any other error counts and waits retry_minutes
 v_stop := p_error IS NOT NULL AND p_error = ANY (stops);
 v_attempts := r.attempts + CASE WHEN v_stop THEN 0 ELSE 1 END;
 v_waits := pol -> 'retry_minutes';
 v_retry := CASE
  WHEN p_retry_at IS NOT NULL THEN least(greatest(p_retry_at, now()), now() + interval '2 days')
  WHEN v_stop THEN now() + interval '5 minutes'
  ELSE now() + make_interval(mins => (v_waits ->> (least(greatest(v_attempts, 1), jsonb_array_length(v_waits)) - 1))::integer) END;
 UPDATE public.context_job_story_requests SET attempts = v_attempts, next_attempt_at = v_retry, error = p_error,
  lease_token = NULL, lease_expires_at = NULL
 WHERE id = r.id;
 RETURN jsonb_build_object('outcome', 'released', 'attempts', v_attempts, 'next_attempt_at', v_retry, 'counted', NOT v_stop);
END $fn$;
COMMENT ON FUNCTION public.context_job_story_request_finish(uuid, uuid, text, text, timestamptz) IS
 'Job story text (20261009100000): ends a claimed request without a save. unchanged: the card''s hash equals the current story''s, so the story stays and now covers the claim (checked_at moves to picked_at; job_status, record_sig, generation_id and evidence_until become the claim''s), and the request closes unchanged. failed: closes with p_error (a code). released: clears the lease for a retry; a stop (story_off, story_budget, model_cap, cap, paused, model_admission_paused, switch_off, rate_limited, auth_required, worker_stopping) is not counted and waits 5 minutes, any other error counts an attempt and waits retry_minutes (30, then 120); p_retry_at, when given, is the wait (clamped to now .. now plus 2 days). {outcome closed|released|lease_lost, ...}. Raises context_job_story_finish_invalid for bad arguments. Service role only.';

-- 19. Access: service role only, every function.
DO $grants$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_job_story_text_policy()', 'public.context_job_story_text_on()',
   'public.context_job_story_sections_problem(jsonb)', 'public.context_job_story_checks_problem(jsonb)',
   'public.context_job_story_digest_num(jsonb)', 'public.context_job_story_digest_at(jsonb)', 'public.context_job_story_card_hash(jsonb)',
   'public.context_job_story_reading(uuid)', 'public.context_job_story_record_sig(uuid)', 'public.context_job_story_claim_state(uuid)',
   'public.context_job_story_budget()', 'public.context_job_story_text_get(uuid,jsonb,boolean)',
   'public.context_job_story_request(uuid,text,text)', 'public.context_job_story_enqueue_changed(integer)',
   'public.context_job_story_claim(integer)', 'public.context_job_story_writer_input(uuid)',
   'public.context_job_story_text_save(uuid,uuid,uuid,jsonb,text,timestamptz,uuid,text,text,jsonb)',
   'public.context_job_story_request_finish(uuid,uuid,text,text,timestamptz)'] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
 END LOOP;
END $grants$;

-- 20. The switch, created OFF. Turning it on needs the owner's word.
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'context_job_story_text_v1', false,
 'Saved job story (20261009100000): while on, the Luna context worker (secureworks-jarvis) writes the short story of each live job (five plain sections from the job card and live AI notes, every amount and date checked against them), rewrites it when something new happens, and staff can ask for a rewrite from the job page. Each story is one model call from the shared day (reserve_context_model_call phase story: at most context_job_story_text_policy() calls_per_day a Perth day, never inside the ledger''s live reserve). Off: nothing is queued, claimed or called, and the job page shows no saved story. Owner''s word to turn on.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1');

-- 21. Proof in the same transaction.
DO $verify$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid = 'public.reserve_context_model_call(text,uuid,uuid)'::regprocedure;
 IF live IS DISTINCT FROM '25a5b5f208af726d47e952f98cecef56' THEN
  RAISE EXCEPTION 'context_job_story_text_body_mismatch: reserve_context_model_call md5 %', live;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_model_call_reservations'::regclass AND contype = 'c' AND convalidated
   AND pg_get_constraintdef(oid) = $d$CHECK ((phase = ANY (ARRAY['attribution'::text, 'extraction'::text, 'bucket'::text, 'vision'::text, 'ledger'::text, 'story'::text])))$d$) THEN
  RAISE EXCEPTION 'context_job_story_text_check_mismatch: the reservations phase list does not admit story';
 END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_job_story_text_v1') <> 1 THEN
  RAISE EXCEPTION 'context_job_story_text_flag_mismatch: the flag is not exactly one row';
 END IF;
 IF public.context_job_story_card_hash('{"job":{"id":"x","status":"quoted"},"money":{"job_value":{"amount":0}}}'::jsonb)
    IS DISTINCT FROM public.context_job_story_card_hash('{"money":{"job_value":{"amount":0.00}},"job":{"status":"quoted","id":"x"},"as_of":"2026-10-09T00:00:00Z"}'::jsonb) THEN
  RAISE EXCEPTION 'context_job_story_text_digest_mismatch: the digest moves with a JSON round trip or the clock';
 END IF;
END $verify$;
