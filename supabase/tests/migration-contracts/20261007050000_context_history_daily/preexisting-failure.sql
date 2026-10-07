-- The CRM list this slice replaces is not the body it was built on: the
-- migration must refuse rather than overwrite a live change nobody read.
CREATE OR REPLACE FUNCTION public.context_ghl_history_live_jobs()
RETURNS TABLE(job_id uuid, job_number text, ghl_contact_id text, status text, live_basis text, tier integer, activity_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::integer, NULL::timestamptz WHERE false
$$;
