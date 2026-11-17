-- Director read-only live check. Match all three against the reference header before switch-on.
SET TimeZone = 'UTC';
SELECT view_name, md5(pg_get_viewdef(('public.' || view_name)::regclass, true)) AS md5
FROM (VALUES ('v_job_cost_events'), ('v_job_revenue_events'), ('v_job_profit')) AS views(view_name);
