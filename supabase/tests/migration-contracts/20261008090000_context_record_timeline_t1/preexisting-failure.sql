-- Someone else's timeline where the story safety (20261006040000) one should be: the migration must
-- refuse to overwrite it, naming the body it found.
CREATE OR REPLACE FUNCTION public.context_job_record_timeline(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, at timestamptz, perth_date date, time_basis text, kind text, what text, amount numeric,
 party text, placement text, source_table text, source_id text, state text, made_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::uuid, NULL::timestamptz, NULL::date, NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::text, NULL::text,
 NULL::text, NULL::text, NULL::text, NULL::timestamptz WHERE false $fn$;
