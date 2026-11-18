-- Stored reader, check 5: the stored story profit is installed, proved
-- the way install_job_story_stored_profit itself proves it: the live book is
-- the switch body and the live staff read is the stamped body (bodies
-- compared, never a hash literal), and its two triggers exist and are enabled.
-- Reads pg_proc and pg_trigger only; the install function is not called.
\set zz_check 'stored_reader.installed'
\ir ../session.sql
WITH body AS (
  SELECT
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_book(uuid,timestamptz)')) AS book,
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_book_switch(uuid,timestamptz)')) AS switched,
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_text_get(uuid,jsonb,boolean)')) AS txt,
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_text_get_stamped(uuid,jsonb,boolean)')) AS stamped
), trg AS (
  SELECT
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.job_profit_stored')
            AND tgname = 'job_story_stored_profit_counts' AND tgenabled IN ('O', 'A')) AS counts_trigger,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.feature_flags')
            AND tgname = 'job_story_stored_profit_rearm' AND tgenabled IN ('O', 'A')) AS rearm_trigger
)
SELECT :'zz_check' AS "check",
       CASE WHEN b.book IS NOT NULL AND b.book = b.switched AND b.txt IS NOT NULL AND b.txt = b.stamped
             AND t.counts_trigger AND t.rearm_trigger THEN 'PASS' ELSE 'FAIL' END AS result,
       jsonb_build_object('book_is_switch_body', b.book IS NOT NULL AND b.book = b.switched,
                          'staff_read_is_stamped_body', b.txt IS NOT NULL AND b.txt = b.stamped,
                          'counts_trigger', t.counts_trigger, 'rearm_trigger', t.rearm_trigger)::text AS evidence
FROM body b CROSS JOIN trg t;
