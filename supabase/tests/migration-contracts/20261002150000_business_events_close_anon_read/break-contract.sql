-- Deliberately re-open the public read the migration closed.
GRANT SELECT ON public.business_events TO anon;
CREATE POLICY select_all ON public.business_events FOR SELECT USING (true);
