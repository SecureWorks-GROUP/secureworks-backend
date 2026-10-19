-- Prerequisites for 20261018140000_dispatch_scope_order_lines. Earlier registered
-- cases already create public.jobs and the API roles (checked here). The new
-- table references only jobs(id).
DO $$
DECLARE t text;
BEGIN
 IF to_regclass('public.jobs') IS NULL THEN
  RAISE EXCEPTION 'scope order lines setup: public.jobs missing from the registered stack';
 END IF;
 FOREACH t IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = t) THEN
   RAISE EXCEPTION 'scope order lines setup: role % missing from the registered stack', t;
  END IF;
 END LOOP;
END $$;
