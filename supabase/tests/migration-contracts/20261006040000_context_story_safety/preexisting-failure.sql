-- Someone else's body where a 20261006033000 one should be: story safety must refuse
-- to overwrite it (its md5 is neither the one 033000 leaves nor this migration's).
CREATE OR REPLACE FUNCTION public.context_job_record_loops(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text,
 opened_at timestamptz, due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text,
 placement text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz,
 NULL::date, NULL::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $fn$;
