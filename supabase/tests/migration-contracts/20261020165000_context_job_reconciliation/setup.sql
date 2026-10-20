-- Pre-migration surface for the job reconciliation reads. Everything they read (business_events,
-- jobs, context_placement_links and the 20261020140000 decision functions) is created by earlier
-- registered migrations; this migration adds no table or column.
SELECT 1;
