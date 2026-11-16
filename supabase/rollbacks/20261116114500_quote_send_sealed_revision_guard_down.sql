-- Down for 20261116114500_quote_send_sealed_revision_guard.
-- Roll the matching send-quote and ghl-proxy code back first: they read the
-- switch and write the column and the table.
--
-- Removes the switch and the recorded document revisions. Keeps the recorded
-- misses (quote_send_sealed_revision_misses and its append-only triggers): they
-- are the only record of which sends the guard would have refused.

DELETE FROM public.feature_flags WHERE flag_name = 'quote_send_sealed_revision_required_v1';

ALTER TABLE public.job_documents DROP COLUMN IF EXISTS scope_revision_id;
