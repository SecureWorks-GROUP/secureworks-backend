-- Stored reader, check 8, on the ZZTEST job: the store answers (its as-at
-- time is the stored snapshot's, after the arm) and the stored book is the
-- live book exactly (the switch adds only computed_at, outside the digest). One statement, so a
-- refresh landing between reads cannot split the comparison (the timer runs
-- every minute). Evidence carries times, a digest match and the names of any
-- differing keys, never an amount.
\set zz_check 'stored_reader.stored_equals_live'
\ir ../session.sql
\if :zz_ok
WITH x AS (
  SELECT public.job_story_stored_profit_as_at(:'zz_job_id', now()) AS as_at,
         public.context_job_story_book_stored(:'zz_job_id', now()) AS stored,
         public.context_job_story_book_fast(:'zz_job_id', now()) AS live,
         (SELECT computed_at FROM public.job_profit_stored WHERE job_id = :'zz_job_id') AS computed_at,
         (SELECT armed_at FROM public.job_story_stored_profit_arm WHERE singleton) AS armed_at
)
SELECT :'zz_check' AS "check",
       CASE WHEN x.as_at IS NOT NULL AND x.as_at = x.computed_at AND x.computed_at > x.armed_at
             AND x.stored ->> 'digest' IS NOT NULL AND x.stored ->> 'digest' = x.live ->> 'digest'
             AND x.stored = x.live THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('as_at', x.as_at, 'computed_at', x.computed_at, 'armed_at', x.armed_at,
                          'digests_equal', x.stored ->> 'digest' IS NOT DISTINCT FROM x.live ->> 'digest',
                          'same_book', x.stored IS NOT NULL AND x.stored = x.live,
                          'keys_differing', (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]')
                              FROM jsonb_each(coalesce(x.stored, '{}')) s
                              FULL JOIN jsonb_each(coalesce(x.live, '{}')) l USING (key)
                              WHERE s.value IS DISTINCT FROM l.value))::text AS evidence
FROM x;
\endif
