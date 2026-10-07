-- Someone else's change where this migration's pre-images should be: a record loops body that is
-- neither 20261006040000's nor this migration's, and a lead rule of the same name that is not this
-- migration's. The guard must refuse and name both before touching anything.
CREATE OR REPLACE FUNCTION public.context_job_record_loops(p_job_ids uuid[], p_as_of timestamptz DEFAULT now())
RETURNS TABLE(job_id uuid, rule text, loop_key text, shown_as text, owner text, counterparty text, what text, why text,
 opened_at timestamptz, due_date date, amount numeric, about_key text, closes_when text, source_table text, source_id text,
 placement text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ SELECT NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz,
 NULL::date, NULL::numeric, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text WHERE false $fn$;
CREATE FUNCTION public.context_lead_monitored(p_job_id uuid, p_as_of timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
COMMENT ON FUNCTION public.context_lead_monitored(uuid, timestamptz) IS 'Someone else''s lead check';
