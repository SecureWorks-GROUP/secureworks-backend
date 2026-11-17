-- Director read on live, 18 Nov 2026, UTC. Expected pg_get_viewdef(oid,true) hashes:
-- v_job_cost_events    c2e9632718dfa057703f1ee36b97322e
-- v_job_revenue_events cea985aadcb59a2f751b1f403176a39c
-- v_job_profit         578270db501761330fad0b46412aac95
-- Match all three against supabase/reference/job_profit_views_live.sql before switch-on.
SET TimeZone = 'UTC';
SELECT view_name, md5(pg_get_viewdef(('public.' || view_name)::regclass, true)) AS md5
FROM (VALUES ('v_job_cost_events'), ('v_job_revenue_events'), ('v_job_profit')) AS views(view_name);
