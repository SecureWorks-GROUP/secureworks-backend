-- Rollback of 20260924130000_ghl_webhook_receipts (slice C1c).
-- Redeploy the previous ghl-webhook-receiver FIRST: the C1c receiver writes one
-- ghl_webhook_receipts row per delivery through this function (a missing
-- function is only logged by code; deliveries keep working). The receipts are
-- 30-day operational data; dropping them loses only webhook health history.
-- Refuses unless the function is exactly the C1c body, so a later change to it
-- is never dropped unread.
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE live_md5 text;
BEGIN
 SELECT md5(p.prosrc) INTO live_md5 FROM pg_proc p WHERE p.oid=to_regprocedure('public.record_ghl_webhook_receipt(jsonb)');
 IF live_md5 IS NOT NULL AND live_md5<>'05293bfa6bf24e1ea182fd01492d882e' THEN
  RAISE EXCEPTION 'ghl_webhook_receipts_rollback_mismatch: md5 % is not the C1c body; read it before dropping',live_md5;
 END IF;
END $guard$;
DROP FUNCTION IF EXISTS public.record_ghl_webhook_receipt(jsonb);
DROP TABLE IF EXISTS public.ghl_webhook_receipts;
