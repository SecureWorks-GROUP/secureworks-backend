-- Slice 4 — Smart Booking, handshake v2 (CP-K / CP-L)
-- Adds work_calendar_email to scoper_preferences so the calendar
-- adapter knows which work mailbox to write the appointment to.
--
-- Per Marnin loops 19/20 the calendar layer is Microsoft 365 / Outlook
-- via Microsoft Graph, NOT Google Workspace. Column name is vendor-
-- neutral on purpose so a future second-vendor adapter doesn't need
-- another migration.
--
-- Earlier draft of this same migration was named
--   workspace_calendar_email (Google-Workspace-flavoured)
-- and renamed to
--   work_calendar_email      (vendor-neutral)
-- before apply per Marnin's CP-J' approval scope (loop 24).
--
-- Khairo's value supplied separately at scoper-bootstrap time.

ALTER TABLE scoper_preferences
  ADD COLUMN IF NOT EXISTS work_calendar_email text;

COMMENT ON COLUMN scoper_preferences.work_calendar_email IS
  'Work-mailbox UPN used by the OutlookCalendarAdapter to target a Microsoft 365 calendar via Microsoft Graph. NULL = adapter will fail closed for this scoper.';

-- Idempotent population of the three known scopers' Workspace UPNs.
-- Each UPDATE gates on the column already being NULL so a re-apply is a
-- no-op for rows already populated. Comment-out / replace before apply
-- if the values are wrong.
UPDATE scoper_preferences SET work_calendar_email = 'marnin@secureworkswa.com.au'
  WHERE user_id = '706c5258-70dd-483a-b36c-af6864b24498' AND work_calendar_email IS NULL;
UPDATE scoper_preferences SET work_calendar_email = 'nithin@secureworkswa.com.au'
  WHERE user_id = '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73' AND work_calendar_email IS NULL;
UPDATE scoper_preferences SET work_calendar_email = 'khairo@secureworkswa.com.au'
  WHERE user_id = 'be6c2188-2b7b-49c7-b6e4-5b0d0deb6415' AND work_calendar_email IS NULL;
