-- A business_events trigger already holds this migration's trigger name but
-- calls another function: the guard must refuse rather than replace it.
CREATE FUNCTION public.pr_fixture_other_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER context_party_roles_business_event BEFORE INSERT ON public.business_events
 FOR EACH ROW EXECUTE FUNCTION public.pr_fixture_other_trigger();
