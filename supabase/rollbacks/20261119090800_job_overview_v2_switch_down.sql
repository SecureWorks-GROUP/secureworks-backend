-- Down for 20261119090800_job_overview_v2_switch.sql: removes the switch row
-- only while it is still off, so a switch someone turned on is never deleted.
DELETE FROM public.feature_flags
WHERE flag_name = 'job_overview_v2' AND enabled = false;
