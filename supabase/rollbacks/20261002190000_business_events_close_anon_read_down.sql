-- Rollback for 20261002190000_business_events_close_anon_read.sql.
-- RE-OPENS the public-key read of every business_events row, SMS bodies
-- included. Run it only to restore a caller the close broke, and only on the
-- owner's word; prefer fixing the caller.
-- Restores exactly the pre-change surface: the select_all policy for PUBLIC,
-- the anon SELECT grant, and the TRUNCATE, UPDATE, DELETE, REFERENCES and
-- TRIGGER grants production held for anon and authenticated (2 Oct 2026
-- snapshot). Leaves row level security on, as it was.

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS business_events_staff_read ON public.business_events;
DROP FUNCTION IF EXISTS public.business_events_staff_reader();
CREATE POLICY select_all ON public.business_events FOR SELECT USING (true);
GRANT SELECT ON TABLE public.business_events TO anon;
GRANT TRUNCATE, UPDATE, DELETE, REFERENCES, TRIGGER
  ON TABLE public.business_events TO anon;
GRANT TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.business_events TO authenticated;
