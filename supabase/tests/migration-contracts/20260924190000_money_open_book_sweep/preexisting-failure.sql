-- A live change nobody read: the money block already replaced by some other
-- body, and xero_verified_at already present with another type. The guard must
-- refuse and name both.
CREATE OR REPLACE FUNCTION public.context_money_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT '{"alarms":[]}'::jsonb $$;
ALTER TABLE public.xero_invoices ADD COLUMN xero_verified_at text;
