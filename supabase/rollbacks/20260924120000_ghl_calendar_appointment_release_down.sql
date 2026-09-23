-- Down: remove the stuck-sending release. Refuses while any row is released:
-- restoring the three-state check would reject that audit row, and a released
-- row is never deleted or silently turned back into a sending fence.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.ghl_calendar_appointment_requests WHERE state = 'released'
  ) THEN
    RAISE EXCEPTION 'ghl_calendar_appointment_release down: released rows exist; keep the migration';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.release_ghl_calendar_appointment_sending(text,text,text,text);
ALTER TABLE public.ghl_calendar_appointment_requests
  DROP CONSTRAINT IF EXISTS ghl_calendar_appointment_requests_release_check,
  DROP CONSTRAINT IF EXISTS ghl_calendar_appointment_requests_state_check,
  ADD CONSTRAINT ghl_calendar_appointment_requests_state_check
    CHECK (state IN ('reserved', 'sending', 'complete')),
  DROP COLUMN IF EXISTS released_at,
  DROP COLUMN IF EXISTS released_by,
  DROP COLUMN IF EXISTS release_reason;
