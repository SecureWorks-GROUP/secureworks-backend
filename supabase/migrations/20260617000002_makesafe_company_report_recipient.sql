-- MakeSafe report-recipient correction (BLOCKER C).
--
-- Business meaning:
--   The make-safe COMPLETION report pack (report PDF + tax invoice) must be
--   emailed to the builder's WORK-ORDERS inbox, NOT the per-builder billing
--   contact (makesafe_companies.invoice_email). For AJS that billing contact is
--   vanessa@ajs.build, who must NEVER be the To of a report send.
--
--   This column holds the per-builder work-orders inbox used as the To for the
--   report pack. When NULL the cockpit surfaces a "no work-order recipient
--   configured" warning and send_pack refuses to send (fail-closed).
--
-- Safety:
--   Additive only. Intended for PR review first. Do NOT apply to production
--   without the standard SecureWorks deploy/migration approval gate. The deploy
--   lane applies migrations; this file only authors the change.

ALTER TABLE public.makesafe_companies
  ADD COLUMN IF NOT EXISTS report_recipient text;

COMMENT ON COLUMN public.makesafe_companies.report_recipient IS
  'The builder work-orders inbox the make-safe report pack is emailed TO. NOT the billing contact (invoice_email). NULL -> no send allowed (fail-closed); the cockpit shows a no-work-order-recipient warning.';

-- Seed ONLY AJS (slug = aj) with its work-orders inbox. Other builders are left
-- NULL deliberately so they surface the no-recipient warning until configured.
UPDATE public.makesafe_companies
  SET report_recipient = 'workorders@ajs.build',
      updated_at = now()
  WHERE slug = 'aj';
