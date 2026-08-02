-- Rollback twin for 20260802010000_makesafe_awaiting_portal_completion_substatus.sql
--
-- Restores the pre-F4 substatus CHECK (the live production shape, including the
-- 'pending_allocation' legacy value) under its original name.
--
-- IMPORTANT: this rollback FAILS if any row has already been written with
-- substatus = 'awaiting_portal_completion'. That is deliberate — narrowing a
-- CHECK must never silently strand a card in a value the constraint no longer
-- allows. Reassign those cards through the sanctioned board path first; this
-- file never writes a row.

ALTER TABLE public.makesafe_job_details
  DROP CONSTRAINT IF EXISTS makesafe_job_details_substatus_check_v2;

ALTER TABLE public.makesafe_job_details
  DROP CONSTRAINT IF EXISTS makesafe_job_details_substatus_check;

ALTER TABLE public.makesafe_job_details
  ADD CONSTRAINT makesafe_job_details_substatus_check
  CHECK (substatus IN (
    'pending_allocation',
    'company_contact_required',
    'company_contact_done',
    'waiting_on_trade_report',
    'admin_to_send_report',
    'ready_to_invoice',
    'complete'
  ));
