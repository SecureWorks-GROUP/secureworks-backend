-- After the down migration: the store, the links, the hold trigger and every function are gone,
-- and business_events is still writable by the ladder.
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF to_regclass('public.context_reconciliation_decisions') IS NOT NULL
     OR to_regclass('public.context_placement_links') IS NOT NULL THEN
    RAISE EXCEPTION 'recon rollback: tables remain';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.business_events'::regclass AND tgname = 'context_aa_recon_hold_decided') THEN
    RAISE EXCEPTION 'recon rollback: hold trigger remains';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND (p.proname LIKE 'context\_recon\_%' OR p.proname IN ('context_event_jobs', 'context_job_owed_lines', 'context_job_view'))) THEN
    RAISE EXCEPTION 'recon rollback: functions remain';
  END IF;
END $$;
BEGIN;
INSERT INTO public.business_events (id, channel, direction, occurred_at, payload, event_type, source)
VALUES ('7c300000-0000-0000-0000-000000000001', 'sms', 'inbound', '2026-10-18 01:00Z', '{"body":"x"}', 'sms.inbound', 'recon-rollback');
UPDATE public.business_events SET attribution_status = 'unplaced' WHERE id = '7c300000-0000-0000-0000-000000000001';
ROLLBACK;
