-- Lose the failed hours: a trigger drops every failed run before it is stored,
-- so a broken scorecard leaves a silent gap in the hourly record. The
-- contract's failed-run check must catch it.
CREATE FUNCTION public.hourly_break_drop_failed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status = 'failed' THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hourly_break_drop_failed BEFORE INSERT ON public.context_scorecard_runs
 FOR EACH ROW EXECUTE FUNCTION public.hourly_break_drop_failed();
