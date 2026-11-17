SELECT to_regprocedure('public.context_job_story_book_profit_live(uuid,timestamptz)') IS NOT NULL AS stored_profit_successor \gset
\if :stored_profit_successor
\ir ../../../rollbacks/20261118000201_job_story_stored_profit_down.sql
\endif
