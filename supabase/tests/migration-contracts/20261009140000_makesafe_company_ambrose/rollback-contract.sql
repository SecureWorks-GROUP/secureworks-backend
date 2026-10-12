-- The down migration deactivates the row and keeps it for minted cards.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.makesafe_companies WHERE slug = 'acg') <> 1 THEN
    RAISE EXCEPTION 'ambrose rollback: row was deleted';
  END IF;
  IF (SELECT active FROM public.makesafe_companies WHERE slug = 'acg') THEN
    RAISE EXCEPTION 'ambrose rollback: row still active';
  END IF;
END $$;
