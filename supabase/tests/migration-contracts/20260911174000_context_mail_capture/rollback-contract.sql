DO $$ BEGIN
 IF to_regprocedure('public.claim_context_mail_stream(text)') IS NOT NULL THEN RAISE EXCEPTION 'rollback left worker active'; END IF;
 IF EXISTS(SELECT 1 FROM public.context_mail_streams WHERE enabled) THEN RAISE EXCEPTION 'rollback failed to stop capture'; END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='context-mail-evidence' AND NOT public) THEN RAISE EXCEPTION 'rollback lost private evidence custody'; END IF;
END $$;
