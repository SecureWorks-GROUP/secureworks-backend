-- A live job-created body nobody read (here: a hand edit that adds a comment
-- line). P1b must refuse rather than silently replace it.
DO $$
DECLARE src text;
BEGIN
 SELECT prosrc INTO src FROM pg_proc WHERE oid='public.context_job_created_reconsider()'::regprocedure;
 EXECUTE format('CREATE OR REPLACE FUNCTION public.context_job_created_reconsider() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS %L',
  '-- hand edit'||chr(10)||src);
END $$;
