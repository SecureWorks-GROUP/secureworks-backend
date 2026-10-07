-- Prerequisites for 20261007090000_context_grades: nothing new. The tables it
-- reads or references (jobs, the ledger model's items and generations) and the
-- store's item check it is proved against are created by earlier registered
-- cases (20261006010000 and 20261006013000), as are the three roles it grants
-- to. This check fails early, and by name, if one is missing.
DO $$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['public.jobs', 'public.context_ledger_items', 'public.context_ledger_generations'] LOOP
  IF to_regclass(r) IS NULL THEN RAISE EXCEPTION 'grades setup: % is missing from the registered stack', r; END IF;
 END LOOP;
 IF to_regprocedure('public.context_ledger_check_item(uuid,jsonb,text,uuid,text)') IS NULL THEN
  RAISE EXCEPTION 'grades setup: public.context_ledger_check_item is missing from the registered stack';
 END IF;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'grades setup: role % is missing', r; END IF;
 END LOOP;
END $$;
