-- Undo the change (the down migration puts the open 2025 read rule and the
-- anon grant back): the contract must fail on its first case.
\ir ../../../rollbacks/20261119090600_job_documents_read_rules_down.sql
