-- Rollback of 20261102070000 (R57 line evidence reader). Removes only what it
-- added. The loaded evidence rows go with their tables: Bookkeeping's own
-- revision files remain the source and can be loaded again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP FUNCTION IF EXISTS public.job_profit_line_evidence_score(date, date);
DROP FUNCTION IF EXISTS public.job_profit_line_evidence(uuid);
DROP VIEW IF EXISTS public.v_xero_lines;
DROP VIEW IF EXISTS public.v_bookkeeping_line_evidence_current;
DROP FUNCTION IF EXISTS public.bookkeeping_evidence_close(text);
DROP FUNCTION IF EXISTS public.bookkeeping_evidence_add(text, jsonb);
DROP FUNCTION IF EXISTS public.bookkeeping_evidence_open(text, text, text, timestamptz, text, text, integer, integer, text);
DROP FUNCTION IF EXISTS public.bookkeeping_evidence_classify(jsonb);
DROP TABLE IF EXISTS public.bookkeeping_line_evidence;
DROP TABLE IF EXISTS public.bookkeeping_evidence_revisions;
