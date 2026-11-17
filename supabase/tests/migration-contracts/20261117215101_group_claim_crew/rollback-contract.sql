DO $$ BEGIN
  IF to_regprocedure('public.group_claim_update_crew(uuid,uuid,text,uuid[])') IS NOT NULL
    OR to_regprocedure('public.group_claim_search_trades(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST crew rollback retained functions'; END IF;
END $$;
