DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ledger_packet(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure) <> 'b04863d6bd6f8ceaadb102532b8136a2' THEN RAISE EXCEPTION 'story card rollback: context_ledger_packet changed'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story(uuid,timestamp with time zone,uuid,timestamp with time zone,boolean)'::regprocedure) <> '72da3ec164693a91819016eace85e895' THEN RAISE EXCEPTION 'story card rollback: context_job_story changed'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_record_value(uuid[],timestamp with time zone)'::regprocedure) <> 'ed329078f075719e650797926df6d3da' THEN RAISE EXCEPTION 'story card rollback: context_job_record_value changed'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_held(uuid,timestamp with time zone)'::regprocedure) <> 'e9e5db3d25199d2273eac53c4fbb1786' THEN RAISE EXCEPTION 'story card rollback: context_job_story_held changed'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ledger_evidence_rows(uuid[],timestamp with time zone)'::regprocedure) <> '2c3dbfef58572e08a630444692d61242' THEN RAISE EXCEPTION 'story card rollback: context_ledger_evidence_rows changed'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ledger_cite(uuid,jsonb)'::regprocedure) <> 'c126255e2f405fa17341545146723fe0' THEN RAISE EXCEPTION 'story card rollback: context_ledger_cite changed'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_ledger_held_rows(uuid[],timestamp with time zone)'::regprocedure) <> 'dcdfdb1d63e56dd4f85def29bc9b7c3e' THEN RAISE EXCEPTION 'story card rollback: context_ledger_held_rows changed'; END IF;
 IF to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'story card rollback helper survived'; END IF;
END $$;
