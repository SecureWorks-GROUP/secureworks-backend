-- Break: a queue that ignores live_from must fail the contract.
CREATE OR REPLACE FUNCTION public.context_recon_live_from() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT NULL::timestamptz $$;
