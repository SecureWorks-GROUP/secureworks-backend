DO $$ BEGIN
  IF to_regprocedure('public.job_cost_proven_share(uuid[])') IS NOT NULL OR EXISTS (
    SELECT FROM information_schema.columns WHERE table_schema='public' AND table_name='job_profit_stored'
    AND column_name IN ('cost_proven_ex','cost_on_clues_ex','cost_unknown_ex','cost_unknown_items','proven_share_pct','proven_share_reason')
  ) THEN RAISE EXCEPTION 'share_rollback_failed'; END IF;
END $$;
