-- Rollback for 20261002150000_business_events_close_anon_read.sql.
-- RE-OPENS the public-key read of every business_events row, SMS bodies
-- included. Run it only to restore a caller the close broke, and only on the
-- owner's word; prefer fixing the caller.
-- Restores exactly the pre-change read surface: the select_all policy for
-- PUBLIC and the anon SELECT grant. Leaves row level security on, as it was.

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS business_events_staff_read ON public.business_events;
DROP FUNCTION IF EXISTS public.business_events_staff_reader();
CREATE POLICY select_all ON public.business_events FOR SELECT USING (true);
GRANT SELECT ON TABLE public.business_events TO anon;
