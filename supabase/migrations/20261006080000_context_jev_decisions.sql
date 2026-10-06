-- Jev in shadow: the log of what TypeSafe's decision model Jev answered beside
-- today's answer, and the read that says how often the two agreed (6 Oct 2026).
--
-- Why. On 6 Oct 2026 the owner asked for intelligent ways to bring in Jev
-- (TypeSafe AI's decision model, jev-1.13.0), built and working. Jev never
-- writes words: it picks one of a set of answers, or says yes or no, with a
-- probability. Before it decides anything for real, the context worker
-- (secureworks-jarvis src/automation/jev-shadow.ts) asks it in SHADOW: today's
-- answer is always the one used, and Jev's answer is only logged beside it,
-- here. Three decision points, each one where today's model only picks:
--
--   placement           which candidate job a waiting message is about: a Choice
--                       over the same candidate jobs Luna was shown, plus
--                       several and none, logged beside Luna's placement answer.
--   ledger_update_gate  before a ledger update read: do the new rows open,
--                       change or close any item (three yes/no questions,
--                       combined in code), logged beside what the full read
--                       then wrote. It measures how many full reads Jev could
--                       safely skip.
--   ledger_reply_owed   for each record candidate a ledger read decides (R5 the
--                       customer wrote last, C11 an old-inbox email with no
--                       reply, C6 the customer wrote after a booking): does the
--                       customer's message need a reply or an action from us,
--                       logged beside whether the read wrote an item with
--                       needs_reply on that row.
--
-- What it adds:
--  1. context_jev_decisions: one row per Jev request. The decision point; the
--     job or the row it was about; the model asked for and the model version
--     Jev named; Jev's outcome, pick, confidence and answer (probabilities);
--     today's outcome, pick and answer; latency, tokens, attempts; an error
--     code when Jev gave no answer. Ids, outcomes, numbers and codes only:
--     never message words. RLS on with no policy; service_role may read and
--     insert and nothing else; anon and authenticated may do nothing.
--  2. context_jev_agreement(p_since, p_until): read only. Per decision point and
--     confidence band: answers, answers compared with today's, agreed, the
--     agreement rate, the unsafe answers (those that would have done harm had
--     Jev decided) and the failures, over the window (default the last 14
--     days). Service role only.
--  3. context_jev_calls_today(): read only. Jev requests (attempts) logged
--     since Perth midnight; the worker reads it when it starts so its hard
--     daily cap holds across a restart. Service role only.
--  4. feature_flags.context_jev_shadow_v1, created OFF. The worker asks Jev
--     nothing while it is off or missing, or while TYPESAFE_API_KEY is unset.
--
-- Retention: the rows hold no message words, names, phone numbers or emails.
-- Keep 180 days. Nothing deletes them automatically; rows older than 180 days
-- may be deleted by hand (DELETE FROM public.context_jev_decisions WHERE
-- created_at < now() - interval '180 days').
--
-- Replaces no existing function, writes no business row, schedules no cron job
-- and adds no grant, policy or view for anon or authenticated.
--
-- Rollback: supabase/rollbacks/20261006080000_context_jev_decisions_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: feature_flags exists; the table is absent or exactly this
-- migration's; each function is absent or this migration's (a re-apply); and
-- the flag is not already on before the log exists (it would switch Jev on at
-- merge with nowhere to write).
DO $guard$
DECLARE problems text[] := '{}'; f text; cols text;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN problems := problems || 'public.feature_flags is missing'::text; END IF;
 IF to_regclass('public.context_jev_decisions') IS NOT NULL THEN
  SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid = 'public.context_jev_decisions'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id:uuid,decision_point:text,job_id:uuid,row_table:text,row_id:uuid,requested_model:text,model:text,'
    'jev_outcome:text,jev_job_id:uuid,jev_confidence:numeric(5,4),jev_answer:jsonb,current_outcome:text,current_job_id:uuid,'
    'current_answer:jsonb,latency_ms:integer,input_tokens:integer,output_tokens:integer,attempts:smallint,error_code:text,'
    'created_at:timestamp with time zone' THEN
   problems := problems || format('public.context_jev_decisions exists with columns %s', cols);
  END IF;
 ELSIF to_regclass('public.feature_flags') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1' AND enabled IS TRUE) THEN
  problems := problems || 'feature flag context_jev_shadow_v1 is already on before the first apply'::text;
 END IF;
 FOREACH f IN ARRAY ARRAY['public.context_jev_agreement(timestamptz,timestamptz)', 'public.context_jev_calls_today()'] LOOP
  IF to_regprocedure(f) IS NOT NULL AND coalesce(obj_description(to_regprocedure(f), 'pg_proc'), '')
     NOT LIKE 'Context Jev decisions (20261006080000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', f);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_jev_decisions_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The log. One row per Jev request. A row has either Jev's answer (outcome,
-- confidence, the model version it named) or an error code, never both.
CREATE TABLE IF NOT EXISTS public.context_jev_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 decision_point text NOT NULL,
 -- The ledger job (gate and reply owed); null for placement, whose job is the question.
 job_id uuid,
 -- The row the decision was about: the waiting message (placement) or the
 -- candidate's row (reply owed). business_events or inbox_events.
 row_table text,
 row_id uuid,
 -- The model id the worker asked for (pinned) and the versioned id Jev's answer named.
 requested_model text NOT NULL,
 model text,
 -- Jev's answer. jev_answer holds its probabilities and per-question values: ids, labels and numbers only.
 jev_outcome text,
 jev_job_id uuid,
 jev_confidence numeric(5,4),
 jev_answer jsonb NOT NULL DEFAULT '{}'::jsonb,
 -- Today's answer at the same point: Luna's placement, what the ledger read wrote. Null when today's answer
 -- failed (current_answer says why).
 current_outcome text,
 current_job_id uuid,
 current_answer jsonb NOT NULL DEFAULT '{}'::jsonb,
 latency_ms integer,
 input_tokens integer,
 output_tokens integer,
 attempts smallint NOT NULL DEFAULT 1,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT context_jev_decisions_point CHECK (decision_point IN ('placement', 'ledger_update_gate', 'ledger_reply_owed')),
 CONSTRAINT context_jev_decisions_subject CHECK (job_id IS NOT NULL OR row_id IS NOT NULL),
 CONSTRAINT context_jev_decisions_row CHECK ((row_table IS NULL) = (row_id IS NULL)
  AND (row_table IS NULL OR row_table IN ('business_events', 'inbox_events'))),
 -- A CASE, never an OR of comparisons: a null row_table must refuse, not pass as unknown.
 CONSTRAINT context_jev_decisions_point_subject CHECK (CASE decision_point
  WHEN 'placement' THEN row_table IS NOT DISTINCT FROM 'business_events' AND row_id IS NOT NULL
  WHEN 'ledger_update_gate' THEN job_id IS NOT NULL
  WHEN 'ledger_reply_owed' THEN job_id IS NOT NULL AND row_id IS NOT NULL
  ELSE false END),
 CONSTRAINT context_jev_decisions_models CHECK (requested_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  AND (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$')),
 CONSTRAINT context_jev_decisions_jev_outcome CHECK (jev_outcome IS NULL
  OR (decision_point = 'placement' AND jev_outcome IN ('job', 'several', 'none'))
  OR (decision_point = 'ledger_update_gate' AND jev_outcome IN ('change', 'no_change'))
  OR (decision_point = 'ledger_reply_owed' AND jev_outcome IN ('owed', 'not_owed'))),
 CONSTRAINT context_jev_decisions_current_outcome CHECK (current_outcome IS NULL
  OR (decision_point = 'placement' AND current_outcome IN ('job', 'several', 'none'))
  OR (decision_point = 'ledger_update_gate' AND current_outcome IN ('change', 'no_change'))
  OR (decision_point = 'ledger_reply_owed' AND current_outcome IN ('owed', 'not_owed'))),
 CONSTRAINT context_jev_decisions_jev_job CHECK ((jev_outcome IS NOT DISTINCT FROM 'job') = (jev_job_id IS NOT NULL)),
 CONSTRAINT context_jev_decisions_current_job CHECK ((current_outcome IS NOT DISTINCT FROM 'job') = (current_job_id IS NOT NULL)),
 -- An answer or an error, never both and never neither; an answer carries its confidence and the model that gave it.
 CONSTRAINT context_jev_decisions_answer_or_error CHECK ((jev_outcome IS NULL) <> (error_code IS NULL)),
 CONSTRAINT context_jev_decisions_confidence CHECK ((jev_outcome IS NULL) = (jev_confidence IS NULL)
  AND (jev_confidence IS NULL OR jev_confidence BETWEEN 0 AND 1) AND (jev_outcome IS NULL OR model IS NOT NULL)),
 CONSTRAINT context_jev_decisions_answers_shape CHECK (jsonb_typeof(jev_answer) = 'object' AND octet_length(jev_answer::text) <= 8192
  AND jsonb_typeof(current_answer) = 'object' AND octet_length(current_answer::text) <= 8192),
 CONSTRAINT context_jev_decisions_numbers CHECK ((latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000)
  AND (input_tokens IS NULL OR input_tokens >= 0) AND (output_tokens IS NULL OR output_tokens >= 0) AND attempts BETWEEN 1 AND 10),
 CONSTRAINT context_jev_decisions_error_code CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$')
);
CREATE INDEX IF NOT EXISTS context_jev_decisions_point_time ON public.context_jev_decisions (decision_point, created_at);
CREATE INDEX IF NOT EXISTS context_jev_decisions_time ON public.context_jev_decisions (created_at);
CREATE INDEX IF NOT EXISTS context_jev_decisions_job ON public.context_jev_decisions (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS context_jev_decisions_row ON public.context_jev_decisions (row_id) WHERE row_id IS NOT NULL;
ALTER TABLE public.context_jev_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_jev_decisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.context_jev_decisions TO service_role;
COMMENT ON TABLE public.context_jev_decisions IS
 'Context Jev decisions (20261006080000): one row per request the context worker sent to Jev (TypeSafe, jev-1.13.0) in shadow, beside today''s answer at the same decision point (placement, ledger_update_gate, ledger_reply_owed). Jev''s answer never changes a decision. Ids, outcomes, numbers and codes only, never message words. Written by the worker with the service role (insert only); read with context_jev_agreement. Retention: keep 180 days; nothing deletes rows automatically, older rows may be deleted by hand. Flag: feature_flags.context_jev_shadow_v1 (created off).';

-- 2. Agreement by decision point and confidence band. Agreed: the same outcome
-- and, for a placement on a job, the same job. Unsafe: what would have done
-- harm had Jev decided: placing a message on a job Luna did not place it on;
-- skipping a ledger update read that then wrote something; calling a reply not
-- owed when the read wrote one owed. Bands: all, then 0.90-1.00, 0.80-0.90,
-- 0.50-0.80 and 0.00-0.50 of Jev's confidence. failed (band all only): Jev
-- requests that ended with no answer. pairs: compared answers counted as
-- "jev>today" (job>other_job is a placement on a different job).
CREATE OR REPLACE FUNCTION public.context_jev_agreement(p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL)
RETURNS TABLE (decision_point text, confidence_band text, answered bigint, compared bigint, agreed bigint, agreement numeric,
 unsafe bigint, failed bigint, pairs jsonb)
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 WITH win AS (
  SELECT coalesce(p_until, now()) AS until_, coalesce(p_since, coalesce(p_until, now()) - interval '14 days') AS since_
 ), d AS (
  SELECT j.decision_point AS point, j.jev_outcome, j.error_code,
   CASE WHEN j.jev_confidence IS NULL THEN NULL WHEN j.jev_confidence >= 0.9 THEN '0.90-1.00' WHEN j.jev_confidence >= 0.8 THEN '0.80-0.90'
        WHEN j.jev_confidence >= 0.5 THEN '0.50-0.80' ELSE '0.00-0.50' END AS band,
   (j.jev_outcome IS NOT NULL AND j.current_outcome IS NOT NULL) AS is_compared,
   (j.jev_outcome = j.current_outcome AND (j.jev_outcome <> 'job' OR j.jev_job_id = j.current_job_id)) AS is_agreed,
   CASE j.decision_point
    WHEN 'placement' THEN j.jev_outcome = 'job' AND (j.current_outcome <> 'job' OR j.jev_job_id <> j.current_job_id)
    WHEN 'ledger_update_gate' THEN j.jev_outcome = 'no_change' AND j.current_outcome = 'change'
    WHEN 'ledger_reply_owed' THEN j.jev_outcome = 'not_owed' AND j.current_outcome = 'owed' END AS is_unsafe,
   CASE WHEN j.jev_outcome = 'job' AND j.current_outcome = 'job' AND j.jev_job_id <> j.current_job_id THEN 'job>other_job'
        ELSE j.jev_outcome || '>' || j.current_outcome END AS pair
  FROM public.context_jev_decisions j CROSS JOIN win
  WHERE j.created_at >= win.since_ AND j.created_at < win.until_
 ), points (point, point_rank) AS (
  VALUES ('placement', 1), ('ledger_update_gate', 2), ('ledger_reply_owed', 3)
 ), bands (band, band_rank) AS (
  VALUES ('all', 0), ('0.90-1.00', 1), ('0.80-0.90', 2), ('0.50-0.80', 3), ('0.00-0.50', 4)
 ), cell AS (
  SELECT p.point, p.point_rank, b.band, b.band_rank, d.jev_outcome, d.error_code, d.is_compared, d.is_agreed, d.is_unsafe, d.pair
  FROM points p CROSS JOIN bands b
  LEFT JOIN d ON d.point = p.point AND (b.band = 'all' OR d.band = b.band)
 ), pair_counts AS (
  SELECT c.point, c.band, jsonb_object_agg(c.pair, c.n) AS pairs
  FROM (SELECT point, band, pair, count(*) AS n FROM cell WHERE is_compared GROUP BY point, band, pair) c
  GROUP BY c.point, c.band
 )
 SELECT c.point, c.band,
  count(*) FILTER (WHERE c.jev_outcome IS NOT NULL),
  count(*) FILTER (WHERE c.is_compared),
  count(*) FILTER (WHERE c.is_compared AND c.is_agreed),
  round((count(*) FILTER (WHERE c.is_compared AND c.is_agreed))::numeric / nullif(count(*) FILTER (WHERE c.is_compared), 0), 4),
  count(*) FILTER (WHERE c.is_compared AND c.is_unsafe),
  CASE WHEN c.band = 'all' THEN count(*) FILTER (WHERE c.error_code IS NOT NULL) ELSE 0 END,
  coalesce(min(pc.pairs::text)::jsonb, '{}'::jsonb)
 FROM cell c LEFT JOIN pair_counts pc ON pc.point = c.point AND pc.band = c.band
 GROUP BY c.point, c.point_rank, c.band, c.band_rank
 ORDER BY c.point_rank, c.band_rank
$fn$;
COMMENT ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) IS
 'Context Jev decisions (20261006080000): read only. Per decision point (placement, ledger_update_gate, ledger_reply_owed) and band of Jev''s confidence (all, 0.90-1.00, 0.80-0.90, 0.50-0.80, 0.00-0.50): answered, compared with today''s answer, agreed, agreement (agreed / compared, null when none), unsafe (would have done harm had Jev decided), failed (band all: requests with no answer) and pairs ("jev>today" counts) over created_at in [p_since, p_until), default the 14 days before now. Service role only.';

-- 3. Requests logged since Perth midnight, for the worker's daily cap.
CREATE OR REPLACE FUNCTION public.context_jev_calls_today()
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public
AS $fn$
 SELECT jsonb_build_object('perth_date', (now() AT TIME ZONE 'Australia/Perth')::date,
  'calls', coalesce(sum(j.attempts), 0)::bigint, 'decisions', count(*))
 FROM public.context_jev_decisions j
 WHERE j.created_at >= ((now() AT TIME ZONE 'Australia/Perth')::date)::timestamp AT TIME ZONE 'Australia/Perth'
$fn$;
COMMENT ON FUNCTION public.context_jev_calls_today() IS
 'Context Jev decisions (20261006080000): read only. {perth_date, calls (requests including retries), decisions (rows)} logged since Perth midnight. The worker reads it once a Perth day so its hard daily cap on Jev requests holds across a restart. Service role only.';

-- 4. Access: service role only.
REVOKE ALL ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.context_jev_calls_today() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.context_jev_calls_today() TO service_role;

-- 5. The switch, created OFF. Turning it on needs the owner's word (docs/jev.md in secureworks-jarvis).
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'context_jev_shadow_v1', false,
 'Jev in shadow (20261006080000): the context worker asks Jev (TypeSafe, jev-1.13.0) beside today''s answer at placement, the ledger update gate and the ledger''s reply-owed candidates, and logs both in context_jev_decisions. Jev never changes a decision. Also needs TYPESAFE_API_KEY on the worker. Owner''s word to turn on.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1');
