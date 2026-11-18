-- Stored reader, check 12, on the ZZTEST job: the stored read plus its
-- freshness check is faster than the live book; if not, the switch gains
-- nothing and stays off. Three rounds, each timed by the database clock
-- around one statement per read, stored first then live; psql round trips
-- are in both sides alike.
\set zz_check 'stored_reader.faster'
\ir ../session.sql
SELECT clock_timestamp() AS zz_a0 \gset
SELECT public.context_job_story_book_stored(:'zz_job_id', now()) IS NOT NULL
       AND public.job_story_stored_profit_as_at(:'zz_job_id', now()) IS NOT NULL AS zz_s1 \gset
SELECT clock_timestamp() AS zz_a1 \gset
SELECT public.context_job_story_book_fast(:'zz_job_id', now()) IS NOT NULL AS zz_l1 \gset
SELECT clock_timestamp() AS zz_a2 \gset
SELECT public.context_job_story_book_stored(:'zz_job_id', now()) IS NOT NULL
       AND public.job_story_stored_profit_as_at(:'zz_job_id', now()) IS NOT NULL AS zz_s2 \gset
SELECT clock_timestamp() AS zz_a3 \gset
SELECT public.context_job_story_book_fast(:'zz_job_id', now()) IS NOT NULL AS zz_l2 \gset
SELECT clock_timestamp() AS zz_a4 \gset
SELECT public.context_job_story_book_stored(:'zz_job_id', now()) IS NOT NULL
       AND public.job_story_stored_profit_as_at(:'zz_job_id', now()) IS NOT NULL AS zz_s3 \gset
SELECT clock_timestamp() AS zz_a5 \gset
SELECT public.context_job_story_book_fast(:'zz_job_id', now()) IS NOT NULL AS zz_l3 \gset
SELECT clock_timestamp() AS zz_a6 \gset
WITH t AS (
  SELECT round(1000 * extract(epoch FROM (:'zz_a1'::timestamptz - :'zz_a0'::timestamptz)
                                       + (:'zz_a3'::timestamptz - :'zz_a2'::timestamptz)
                                       + (:'zz_a5'::timestamptz - :'zz_a4'::timestamptz)), 1) AS stored_ms,
         round(1000 * extract(epoch FROM (:'zz_a2'::timestamptz - :'zz_a1'::timestamptz)
                                       + (:'zz_a4'::timestamptz - :'zz_a3'::timestamptz)
                                       + (:'zz_a6'::timestamptz - :'zz_a5'::timestamptz)), 1) AS live_ms,
         :'zz_s1'::boolean AND :'zz_s2'::boolean AND :'zz_s3'::boolean AS stored_answered,
         :'zz_l1'::boolean AND :'zz_l2'::boolean AND :'zz_l3'::boolean AS live_answered
)
SELECT :'zz_check' AS "check",
       CASE WHEN t.stored_answered AND t.live_answered AND t.stored_ms < t.live_ms THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('rounds', 3, 'stored_and_as_at_ms', t.stored_ms, 'live_ms', t.live_ms,
                          'stored_answered_every_round', t.stored_answered,
                          'live_answered_every_round', t.live_answered)::text AS evidence
FROM t;
