DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)'))
       IS DISTINCT FROM '32a44a44d85e7a56b6e7a44080422647'
     OR to_regprocedure('public.job_backed_trade_room(uuid,uuid)') IS NOT NULL
     OR NOT has_function_privilege('service_role','public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)','execute')
     OR has_function_privilege('authenticated','public.decide_held_trade_line(uuid,text,uuid,uuid,jsonb,text)','execute') THEN
    RAISE EXCEPTION 'held_line_trade_room_rollback_failed';
  END IF;
END $$;
