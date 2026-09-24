-- Ship the rule without its pool: K1's pool again, so listed jobs with only
-- pre-go-live evidence are never judged. The contract must catch it.
CREATE OR REPLACE FUNCTION public.context_cadence_pool() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_cadence_policy() AS p)
 SELECT DISTINCT u.job_id FROM public.context_unread_rows(NULL) u, pol
 WHERE u.context_captured_at>=(pol.p->>'live_since')::timestamptz
  AND coalesce(u.metadata->>'capture_mode','live')='live' AND u.metadata->>'written_as'='service_role'
$$;
