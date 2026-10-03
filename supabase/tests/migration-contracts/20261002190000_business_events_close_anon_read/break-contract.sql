-- Deliberately re-open what the migration closed: the public read and the
-- public TRUNCATE.
GRANT SELECT, TRUNCATE ON public.business_events TO anon;
CREATE POLICY select_all ON public.business_events FOR SELECT USING (true);
