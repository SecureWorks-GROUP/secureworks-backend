CREATE OR REPLACE FUNCTION public.context_fact_expiry(p_kind text,p_event_at timestamptz,p_due_date date DEFAULT NULL)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::timestamptz $$;
