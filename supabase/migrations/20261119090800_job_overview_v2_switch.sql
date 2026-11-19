-- Seed the Job Overview v2 switch, job_overview_v2, OFF.
-- ops-api job_detail (office) returns job_overview_v2_enabled from it
-- (readSwitch: a missing or unreadable row is off) so the Ops Dash can tell
-- whether Job Overview v2 is on. Nothing else reads it.
-- ON CONFLICT DO NOTHING: a row that already exists is left exactly as it is.
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('job_overview_v2', false, 'Ops Dash Job Overview v2 for every staff browser. Off: the classic Overview stays the default. ops-api job_detail returns it as job_overview_v2_enabled (20261119090800).')
ON CONFLICT (flag_name) DO NOTHING;
