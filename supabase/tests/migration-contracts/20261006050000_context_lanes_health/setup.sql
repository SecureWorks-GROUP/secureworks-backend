-- Lanes health setup. Earlier registered fixtures supply business_events,
-- webhook_log, feature_flags, monitored_mailboxes (EM1, 11 selected sources),
-- context_capture_runs (F1b), the email reader's attachment ledger (EM2) and
-- the five status functions this migration replaces. Prove the starting point
-- is production's: the five bodies read live on 6 Oct 2026, and the ledger
-- without error_code.
DO $$
DECLARE x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.context_source_freshness_policy()','455f0ec0a3f6c60477a68044db10a448'),
  ('public.context_source_freshness()','b12cdb949edd17fbf636990c45c6345d'),
  ('public.context_email_capture_status_at(timestamptz)','78aefd4a54766e3e4967373e46fb934a'),
  ('public.context_ghl_capture_policy()','4deabf30725e64f01f5778d2e853c344'),
  ('public.context_ghl_capture_status()','ecdec7c3bc7f09cb3ea23d35ac096cd2')
 ) AS t(sig,want) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(x.sig)) IS DISTINCT FROM x.want
  THEN RAISE EXCEPTION 'lanes health setup: % is not the live body read on 6 Oct 2026',x.sig; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_email_attachments'::regclass AND attname='error_code' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'lanes health setup: context_email_attachments.error_code already exists'; END IF;
END $$;
