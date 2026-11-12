-- Where a builder wants the report and photos for its RESTORATION jobs sent
-- (owner, 12 Nov 2026: ML Builders' restoration coordinator takes the report,
-- photos and invoice directly, not the Prime work-order mailer).
--
-- Outbound only. sender_patterns stays the inbound trust list (who we accept
-- work orders FROM); this column is never read by intake, so adding a person
-- here never makes their mail a work order. The mailer ops send route
-- (send_mailer_ops_visibility) accepts an address from this list as To only
-- for a restoration card, and only when the operator names it explicitly.
ALTER TABLE public.makesafe_companies
  ADD COLUMN IF NOT EXISTS restoration_recipients text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.makesafe_companies.restoration_recipients IS
  'Full email addresses a restoration card''s report and photos may be sent to (send_mailer_ops_visibility, restoration cards only, named explicitly). Outbound only; never an intake sender pattern.';
