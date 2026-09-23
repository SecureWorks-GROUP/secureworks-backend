-- A live ladder body nobody read (here: a hand edit that adds a comment line).
-- P1a must refuse rather than silently replace it.
DO $$
DECLARE src text;
BEGIN
 SELECT prosrc INTO src FROM pg_proc WHERE oid='public.resolve_context_attribution(public.business_events)'::regprocedure;
 EXECUTE format('CREATE OR REPLACE FUNCTION public.resolve_context_attribution(e public.business_events) RETURNS public.business_events LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS %L',
  '-- hand edit'||chr(10)||src);
END $$;
