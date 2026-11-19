-- A grant to anon made by another role cannot be removed by the migration's
-- revoke, so the migration must refuse rather than leave it open.
DO $r$
BEGIN
  IF to_regrole('zgs_other_grantor') IS NULL THEN CREATE ROLE zgs_other_grantor NOLOGIN; END IF;
END
$r$;
CREATE FUNCTION public.zgs_other_grantor_fn() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.zgs_other_grantor_fn() FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA public TO zgs_other_grantor;
GRANT EXECUTE ON FUNCTION public.zgs_other_grantor_fn() TO zgs_other_grantor WITH GRANT OPTION;
SET ROLE zgs_other_grantor;
GRANT EXECUTE ON FUNCTION public.zgs_other_grantor_fn() TO anon;
RESET ROLE;
