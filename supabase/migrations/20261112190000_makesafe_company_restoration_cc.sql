-- Who is copied on a builder's RESTORATION mail (owner, 12 Nov 2026: ML
-- Builders' restoration coordinator wants the report, photos, quote and invoice
-- sent to her, with the Prime work-order mailer copied so her team sees it when
-- she is away; ses@ stays copied for our records).
--
-- Outbound only, like restoration_recipients: never read by intake, so an
-- address here never makes its mail a work order. The two restoration send
-- routes (send_mailer_ops_visibility on a restoration card, and
-- send_restoration_document) copy every address listed here beside ses@.
ALTER TABLE public.makesafe_companies
  ADD COLUMN IF NOT EXISTS restoration_cc text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.makesafe_companies.restoration_cc IS
  'Full email addresses copied (beside ses@) on every restoration send for this builder: send_mailer_ops_visibility on a restoration card and send_restoration_document. Outbound only; never an intake sender pattern.';
