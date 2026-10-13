-- The one staff text for a new insurance REPAIR job goes to a named user.
--
-- Owner's word, 13 Oct 2026: each repair job that intake creates sends one
-- staff text to the insurance operations manager, worded as a repair. Until
-- now that text used the make-safe recipient and the make-safe wording, so
-- the five repair jobs brought in on 13 Oct were told to the make-safe list
-- as "New make-safe".
--
-- This adds the repair recipient as a setting beside the make-safe one:
-- makesafe_notify_settings.repair_new_job_user_ids names users (users.id),
-- never a phone number. The phone is read from that user's row when the text
-- is sent (ops-api loadRepairNotificationConfig). Exactly one named user with
-- a phone sends. An empty list, more than one user, a user that does not
-- exist or a user with no phone sends nothing and records the reason on the
-- job's makesafe_intake_hugo_notifications row; a repair text never falls
-- back to a role or to the make-safe list.
--
-- Make-safe texts do not read this column. Their recipients and wording are
-- unchanged.
--
-- The seed runs once, when the column is first added, and only in a database
-- that holds the insurance operations manager's user row (production). A
-- later run leaves the list as someone set it, an emptied list included.
-- Changing who gets the text is an edit to this list, not a code change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $migration$
DECLARE
  v_first_apply boolean;
  -- users.id of the insurance operations manager (production, read 13 Oct 2026).
  v_recipient constant uuid := 'b353f39a-b3cc-495d-a016-50ebf4a8497d';
BEGIN
  SELECT NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'makesafe_notify_settings'
      AND column_name = 'repair_new_job_user_ids'
  ) INTO v_first_apply;

  ALTER TABLE public.makesafe_notify_settings
    ADD COLUMN IF NOT EXISTS repair_new_job_user_ids uuid[]
      NOT NULL DEFAULT '{}'::uuid[];

  IF v_first_apply THEN
    UPDATE public.makesafe_notify_settings
    SET repair_new_job_user_ids = ARRAY[v_recipient],
        updated_at = now()
    WHERE id = true
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_recipient);
  END IF;
END;
$migration$;

COMMENT ON COLUMN public.makesafe_notify_settings.repair_new_job_user_ids IS
  'users.id of the staff member who gets the one "new repair job" text when intake creates a repair job. Exactly one user with a phone sends; the phone is read from the user row at send time. Empty, more than one, an unknown user or no phone sends nothing and records why. Never falls back to a role or to the make-safe list. Changing it is an edit here, not a code change.';
