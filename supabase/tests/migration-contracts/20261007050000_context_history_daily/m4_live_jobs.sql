-- M4's context_ghl_history_live_jobs() (20260925031500), verbatim, md5(prosrc)
-- 49eb23015b724a29058c11b2743954bf, with its comment, so a contract can stand
-- M4's list back up after 20261007050000 widened it (inside a rolled-back
-- transaction). Not a migration.
CREATE OR REPLACE FUNCTION public.context_ghl_history_live_jobs()
RETURNS TABLE(job_id uuid, job_number text, ghl_contact_id text, status text, live_basis text, tier integer, activity_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH pol AS (SELECT public.context_ghl_history_policy() AS p),
 j AS (
  SELECT jb.id, jb.job_number, nullif(btrim(jb.ghl_contact_id),'') AS contact, jb.status::text AS status, jb.created_at, jb.updated_at,
   (SELECT max(d.sent_at) FROM public.job_documents d
    WHERE d.job_id=jb.id AND d.type='quote' AND d.sent_at IS NOT NULL
     AND d.sent_at>=now()-make_interval(days=>(pol.p->>'quote_sent_days')::integer) AND d.sent_at<=now()) AS quote_sent_at,
   jb.status::text IN (SELECT jsonb_array_elements_text(pol.p->'live_statuses')) AS live_status,
   jb.status::text IN (SELECT jsonb_array_elements_text(pol.p->'quote_statuses')) AS quote_status
  FROM public.jobs jb CROSS JOIN pol
  WHERE NOT coalesce(jb.archived,false)
   AND coalesce(jb.metadata->>'do_not_schedule','') NOT IN ('true','1')
 )
 SELECT j.id, j.job_number, j.contact, j.status,
  CASE WHEN j.live_status THEN 'status' ELSE 'quote_sent' END,
  CASE WHEN NOT j.live_status THEN 4
   WHEN j.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_1')) THEN 1
   WHEN j.status IN (SELECT jsonb_array_elements_text(pol.p->'tier_2')) THEN 2 ELSE 3 END,
  greatest(j.created_at,j.updated_at,j.quote_sent_at)
 FROM j CROSS JOIN pol
 WHERE j.live_status OR (j.quote_status AND j.quote_sent_at IS NOT NULL)
$$;
COMMENT ON FUNCTION public.context_ghl_history_live_jobs() IS
 'M4: the live jobs (captain ruling 24 Sep 2026): a status on the policy''s live allow-list (accepted, scheduled and in-progress stages), or draft or quoted with a quote document sent in the last 60 days. Never archived, never a holding job. ghl_contact_id null when the job has none. Read only.';
