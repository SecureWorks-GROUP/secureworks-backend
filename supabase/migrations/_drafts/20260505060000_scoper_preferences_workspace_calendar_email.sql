-- Slice 4 — Smart Booking, handshake v2 (CP-I)
-- Adds workspace_calendar_email to scoper_preferences so the Google
-- Calendar adapter knows which Workspace user to impersonate via
-- domain-wide delegation.
--
-- Per Marnin loop-16: all three scopers go on Path A (Google Workspace
-- domain-wide delegation). Khairo's Outlook email is contact metadata
-- only. His Workspace calendar identity is supplied here as a separate
-- value; left NULL initially and populated by Marnin before the calendar
-- adapter is wired live.
--
-- DRAFT — not applied. Awaits explicit Marnin migration approval.

ALTER TABLE scoper_preferences
  ADD COLUMN IF NOT EXISTS workspace_calendar_email text;

COMMENT ON COLUMN scoper_preferences.workspace_calendar_email IS
  'Google Workspace identity used by the Calendar adapter to impersonate this scoper via domain-wide delegation. Distinct from any contact email. NULL = adapter will fail closed for this scoper.';

-- Marnin (and Nithin) likely already use their secureworkswa.com.au
-- addresses on Workspace; we leave the population to Marnin so we don't
-- guess. Khairo's value is unknown and stays NULL until confirmed.
--
-- Idempotent placeholder updates so a future apply is a no-op when these
-- already exist. Comment out / replace the values below before apply if
-- they're wrong.
--
-- UPDATE scoper_preferences SET workspace_calendar_email = 'marnin@secureworkswa.com.au'
--   WHERE user_id = '706c5258-70dd-483a-b36c-af6864b24498' AND workspace_calendar_email IS NULL;
-- UPDATE scoper_preferences SET workspace_calendar_email = 'nithin@secureworkswa.com.au'
--   WHERE user_id = '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73' AND workspace_calendar_email IS NULL;
-- UPDATE scoper_preferences SET workspace_calendar_email = '<KHAIRO_WORKSPACE_EMAIL>'
--   WHERE user_id = 'be6c2188-2b7b-49c7-b6e4-5b0d0deb6415' AND workspace_calendar_email IS NULL;
