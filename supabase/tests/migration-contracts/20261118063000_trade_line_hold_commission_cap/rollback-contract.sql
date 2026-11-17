-- After the down migration: main's body.
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.assert_job_commission_cap(uuid,uuid)'::regprocedure)
       IS DISTINCT FROM 'c2aea6de53237a5c3ae7d166d153cac5' THEN
    RAISE EXCEPTION 'cap rollback: main body not restored';
  END IF;
END $$;
\ir ../../../migrations/20261118063000_trade_line_hold_commission_cap.sql
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.assert_job_commission_cap(uuid,uuid)'::regprocedure)
       IS DISTINCT FROM '404ca316dac46d6c8b93f7d79755919f' THEN
    RAISE EXCEPTION 'cap rollback: re-apply did not restore the post-image';
  END IF;
END $$;
