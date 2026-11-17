-- P2-01.1 is supplied by the registered stack.
DO $$ BEGIN
  IF to_regclass('public.job_cost_lines') IS NULL THEN RAISE EXCEPTION 'writer setup: cost lines missing'; END IF;
END $$;
