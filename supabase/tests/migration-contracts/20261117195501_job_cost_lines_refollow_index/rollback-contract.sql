DO $$ BEGIN
  IF to_regclass('public.job_cost_lines_follows_line_idx') IS NOT NULL THEN
    RAISE EXCEPTION 'FU11 rollback: added index remains';
  END IF;
  IF pg_get_functiondef('public.job_cost_lines_refollow(text,text)'::regprocedure)
    NOT LIKE '%EXISTS (SELECT 1 FROM public.job_cost_lines p WHERE p.id = l.follows_line_id%' THEN
    RAISE EXCEPTION 'FU11 rollback: previous function not restored';
  END IF;
END $$;
