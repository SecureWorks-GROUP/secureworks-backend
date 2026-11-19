-- Undo the change (the down migration puts the open 2025 read rule and the
-- anon grant back): the contract must fail on its first case.
\ir ../../../rollbacks/20261119090600_job_documents_read_rules_down.sql
-- The old read rule looks up jobs as the caller. A later migration
-- (20261119090900) may remove anon's read on jobs in this test database, so
-- put back the read the old state had, or the old leak cannot show.
GRANT SELECT ON TABLE public.jobs TO anon;
