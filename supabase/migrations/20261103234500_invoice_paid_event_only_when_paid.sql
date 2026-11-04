-- B3 (finish line, 3 Nov 2026): the payment trigger records "invoice.paid" only when a sales invoice
-- becomes PAID.
--
-- fn_payment_detected (trg_payment_detected, AFTER UPDATE OF amount_due on xero_invoices) fired whenever
-- amount_due fell from above 0 to 0. A void or delete through ops-api void_invoice also sets amount_due
-- to 0 (xero_void_mirror.ts: nothing is owed on a voided or deleted invoice), so it wrote "invoice.paid"
-- for invoices nobody paid: 79 of 602 such events in the 90 days to 3 Nov 08:00Z (13%,
-- all with amount_paid 0), 8 in the week to 3 Nov (INV-1776, 1777, 1786, 1793, 1794, 1795, 1808, 1809;
-- verify/evidence/20261103-b3/REPORT.md). The event stops chasing and sits on the job as evidence the
-- notes reader reads (SWP-261646's notes still say $3,400 is owed on the voided INV-1794 and INV-1795).
-- Job Profit's collected is not affected; it reads amount_paid.
--
-- Change: the same transition, and the status becomes PAID in that write (it was not PAID before).
-- Nothing else in the function changes. Past events are not touched: they are listed in the PR for the
-- CIO chat to decide.
--
-- The xero-sync change in the same PR does not depend on this: of the 42 invoices it re-reads, Xero
-- keeps the amount due on the 25 voided or deleted ones, and the 17 paid ones are already at 0.
--
-- Guard: the live definition must be the one this was written against (md5 c0680811..., read
-- 3 Nov 08:43Z) or already this change. Rehearsed on production in a rolled-back transaction.
-- Rollback: supabase/rollbacks/20261103234500_invoice_paid_event_only_when_paid_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE v text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_payment_detected()'::regprocedure)) INTO v;
  IF v NOT IN ('c0680811439254b5190a335d2aef804a', '4bf8d1847135539f995590d276583a61') THEN
    RAISE EXCEPTION 'fn_payment_detected is not the definition this migration was written against (md5 %); refusing', v;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_payment_detected()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Fire when a sales invoice becomes PAID with nothing left due. A void or a
  -- delete also takes amount_due to 0 and is not a payment (20261103234500).
  IF OLD.amount_due > 0 AND NEW.amount_due = 0 AND NEW.invoice_type = 'ACCREC'
     AND NEW.status = 'PAID' AND OLD.status IS DISTINCT FROM 'PAID' THEN
    INSERT INTO business_events (
      event_type, source, entity_type, entity_id, job_id, payload,
      occurred_at, recorded_at
    ) VALUES (
      'invoice.paid',
      'xero-sync-trigger',
      'invoice',
      NEW.id::text,
      NEW.job_id,
      jsonb_build_object(
        'invoice_number', NEW.invoice_number,
        'contact_name', NEW.contact_name,
        'amount_paid', NEW.total,
        'xero_contact_id', NEW.xero_contact_id,
        'xero_invoice_id', NEW.xero_invoice_id
      ),
      now(),
      now()
    );
  END IF;
  RETURN NEW;
END;
$function$;

DO $check$
DECLARE v text;
BEGIN
  SELECT md5(pg_get_functiondef('public.fn_payment_detected()'::regprocedure)) INTO v;
  IF v <> '4bf8d1847135539f995590d276583a61' THEN
    RAISE EXCEPTION 'fn_payment_detected after the change is not the rehearsed definition (md5 %)', v;
  END IF;
END $check$;
