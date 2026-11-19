-- A grant to anon made by another role cannot be removed by the migration's
-- revoke, so the migration must refuse rather than leave it open.
DO $r$
BEGIN
  IF to_regrole('ztg_other_grantor') IS NULL THEN CREATE ROLE ztg_other_grantor NOLOGIN; END IF;
END
$r$;
CREATE TABLE public.ztg_other_grantor_table (id int PRIMARY KEY);
REVOKE ALL ON public.ztg_other_grantor_table FROM anon;
GRANT USAGE ON SCHEMA public TO ztg_other_grantor;
GRANT SELECT ON public.ztg_other_grantor_table TO ztg_other_grantor WITH GRANT OPTION;
SET ROLE ztg_other_grantor;
GRANT SELECT ON public.ztg_other_grantor_table TO anon;
RESET ROLE;
