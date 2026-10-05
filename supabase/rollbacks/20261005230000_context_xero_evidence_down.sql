-- Rollback for 20261005230000_context_xero_evidence.sql.
--
-- Drops the seven Xero evidence functions. It writes no row: run
-- SELECT public.context_xero_evidence_undo(false) FIRST if the backfill or the
-- placement has been run and must be undone (after this file the undo is gone).
-- Turn feature flag context_xero_evidence_place_v1 off (or leave it missing)
-- and redeploy the previous xero-sync first: the new xero-sync calls
-- context_xero_evidence_place while the flag is on, and logs and skips the
-- step when the function is missing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.context_xero_evidence_undo(boolean);
DROP FUNCTION IF EXISTS public.context_xero_evidence_request_reads(boolean,integer);
DROP FUNCTION IF EXISTS public.context_xero_evidence_place(jsonb,boolean,timestamptz,integer);
DROP FUNCTION IF EXISTS public.context_xero_evidence_backfill(boolean,integer);
DROP FUNCTION IF EXISTS public.context_xero_evidence_backfill_plan();
DROP FUNCTION IF EXISTS public.context_xero_paid_event_key(public.business_events);
DROP FUNCTION IF EXISTS public.context_xero_event_invoice(public.business_events);
