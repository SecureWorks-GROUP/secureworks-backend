-- After the down migration: main's body, and no split helper.
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
       IS DISTINCT FROM '58182c36e4f35a04ef652da81cea4ec7'
     OR to_regprocedure('public.trade_line_hold_merge_v1(jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'weekly split rollback: main body not restored';
  END IF;
END $$;
\ir ../../../migrations/20261118063100_trade_line_hold_weekly_split.sql
\ir ../../../migrations/20261118063100_trade_line_hold_weekly_split.sql
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure)
       IS DISTINCT FROM 'fe44f464f3c5c62b35149122f7655cb9' THEN
    RAISE EXCEPTION 'weekly split rollback: re-apply did not restore the post-image';
  END IF;
END $$;
