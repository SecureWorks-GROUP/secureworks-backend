-- Reuse the predecessor's standalone prerequisites and its declared story/money stand-ins.
\ir ../20261118041726_context_client_story_stored/setup.sql
\if :p0013_standalone
DROP TABLE public.job_change_marks, public.job_page_marks_seen;
\ir ../../../migrations/20261117171302_job_change_marks.sql
\ir ../../../migrations/20261117172503_job_pages_queue_safety.sql
\ir ../../../migrations/20261118041726_context_client_story_stored.sql
\endif
