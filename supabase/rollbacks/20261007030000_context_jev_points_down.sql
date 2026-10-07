-- Rollback of 20261007030000_context_jev_points (Jev's five watch points).
--
-- Puts the Jev shadow log back exactly as 20261006080000 left it: the five
-- checks back to that migration's definitions, context_jev_agreement back to
-- that migration's body byte for byte (md5 053b8b4a1b61dd2ba44a136ab1405ff5),
-- context_jev_truth dropped, and the five context_jev_point_<name> flag rows
-- removed (a missing row reads as off, so the worker asks Jev nothing at them).
--
-- The rows the five points logged are DELETED first: the restored checks
-- cannot hold them. They hold only Jev's shadow answers beside today's answer
-- or the later truth (ids, outcomes, numbers and codes, never message words);
-- no decision, business row or other flag depends on them. The three earlier
-- points' rows are kept. Refuses when the live bodies are not this
-- migration's (a later migration moved on: roll that back first).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE problems text[] := '{}'; live text; x record;
BEGIN
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)');
 IF live IS DISTINCT FROM 'acd1c143ca45f6458044719625b0f3bf' THEN
  problems := problems || format('public.context_jev_agreement md5 %s, expected 20261007030000''s', coalesce(live, '<missing>'));
 END IF;
 live := NULL;
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_jev_truth(public.context_jev_decisions)');
 IF live IS DISTINCT FROM '520d338e6d920c3190614535bdaa5fe8' THEN
  problems := problems || format('public.context_jev_truth md5 %s, expected 20261007030000''s', coalesce(live, '<missing>'));
 END IF;
 FOR x IN SELECT * FROM (VALUES
  ('context_jev_decisions_point', '0f04dfee7d5bb5ec30ecc3f6719fdaa6'),
  ('context_jev_decisions_row', '6d7059f8415ccf228e7b27f74e9d5060'),
  ('context_jev_decisions_point_subject', '419f1f92c5baefcc901ec379cd3631ae'),
  ('context_jev_decisions_jev_outcome', 'ba794f40dc87aebee67b42fd380fc347'),
  ('context_jev_decisions_current_outcome', 'a6d0fc57196bfa0d16c2e03b1dcd7af3')
 ) AS t(name, after_md5) LOOP
  live := NULL;
  SELECT md5(pg_get_constraintdef(c.oid)) INTO live FROM pg_constraint c
  WHERE c.conrelid = 'public.context_jev_decisions'::regclass AND c.conname = x.name AND c.contype = 'c';
  IF live IS DISTINCT FROM x.after_md5 THEN
   problems := problems || format('check %s md5 %s, expected 20261007030000''s', x.name, coalesce(live, '<missing>'));
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_jev_points_rollback_refused: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The five points' rows, which the restored checks cannot hold.
DELETE FROM public.context_jev_decisions
WHERE decision_point IN ('sender_role', 'visit_happened', 'lead_alive', 'payment_wait', 'email_triage');

-- 2. The agreement read as 20261006080000 wrote it (it reads nothing but the log).
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

REVOKE ALL ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_jev_agreement(timestamptz, timestamptz) TO service_role;

-- 3. The truth read goes.
DROP FUNCTION public.context_jev_truth(public.context_jev_decisions);

-- 4. The five checks as 20261006080000 wrote them.
ALTER TABLE public.context_jev_decisions
 DROP CONSTRAINT context_jev_decisions_point,
 DROP CONSTRAINT context_jev_decisions_row,
 DROP CONSTRAINT context_jev_decisions_point_subject,
 DROP CONSTRAINT context_jev_decisions_jev_outcome,
 DROP CONSTRAINT context_jev_decisions_current_outcome,
 ADD CONSTRAINT context_jev_decisions_point CHECK (decision_point IN ('placement', 'ledger_update_gate', 'ledger_reply_owed')),
 ADD CONSTRAINT context_jev_decisions_row CHECK ((row_table IS NULL) = (row_id IS NULL)
  AND (row_table IS NULL OR row_table IN ('business_events', 'inbox_events'))),
 -- A CASE, never an OR of comparisons: a null row_table must refuse, not pass as unknown.
 ADD CONSTRAINT context_jev_decisions_point_subject CHECK (CASE decision_point
  WHEN 'placement' THEN row_table IS NOT DISTINCT FROM 'business_events' AND row_id IS NOT NULL
  WHEN 'ledger_update_gate' THEN job_id IS NOT NULL
  WHEN 'ledger_reply_owed' THEN job_id IS NOT NULL AND row_id IS NOT NULL
  ELSE false END),
 ADD CONSTRAINT context_jev_decisions_jev_outcome CHECK (jev_outcome IS NULL
  OR (decision_point = 'placement' AND jev_outcome IN ('job', 'several', 'none'))
  OR (decision_point = 'ledger_update_gate' AND jev_outcome IN ('change', 'no_change'))
  OR (decision_point = 'ledger_reply_owed' AND jev_outcome IN ('owed', 'not_owed'))),
 ADD CONSTRAINT context_jev_decisions_current_outcome CHECK (current_outcome IS NULL
  OR (decision_point = 'placement' AND current_outcome IN ('job', 'several', 'none'))
  OR (decision_point = 'ledger_update_gate' AND current_outcome IN ('change', 'no_change'))
  OR (decision_point = 'ledger_reply_owed' AND current_outcome IN ('owed', 'not_owed')));
COMMENT ON TABLE public.context_jev_decisions IS
 'Context Jev decisions (20261006080000): one row per request the context worker sent to Jev (TypeSafe, jev-1.13.0) in shadow, beside today''s answer at the same decision point (placement, ledger_update_gate, ledger_reply_owed). Jev''s answer never changes a decision. Ids, outcomes, numbers and codes only, never message words. Written by the worker with the service role (insert only); read with context_jev_agreement. Retention: keep 180 days; nothing deletes rows automatically, older rows may be deleted by hand. Flag: feature_flags.context_jev_shadow_v1 (created off).';

-- 5. The five switches.
DELETE FROM public.feature_flags WHERE flag_name IN ('context_jev_point_sender_role', 'context_jev_point_visit_happened',
 'context_jev_point_lead_alive', 'context_jev_point_payment_wait', 'context_jev_point_email_triage');
