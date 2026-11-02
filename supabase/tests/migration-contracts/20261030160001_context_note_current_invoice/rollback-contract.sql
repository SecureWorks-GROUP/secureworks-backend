DO $$ BEGIN
 IF to_regprocedure('public.context_job_story_note_current_invoice(jsonb,jsonb,timestamptz)') IS NOT NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_job_story_ledger(uuid,uuid,timestamptz)'::regprocedure)<>'09d28c282caf22c873f5673d7dd8073f' THEN RAISE EXCEPTION 'current invoice rollback failed'; END IF;
END $$;
