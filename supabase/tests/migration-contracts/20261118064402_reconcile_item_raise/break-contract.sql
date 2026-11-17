-- A writer that guesses an organisation instead of reading the subject's.
-- The contract re-applies this migration, which leaves this fixture trigger.
CREATE FUNCTION public.zztest_reconcile_guess_org() RETURNS trigger LANGUAGE plpgsql AS $break$
/* block */ BEGIN
 NEW.org_id := '00000000-0000-0000-0000-0000000000a1';
 RETURN NEW;
END $break$;
CREATE TRIGGER zztest_reconcile_guess_org BEFORE INSERT ON public.reconcile_items
 FOR EACH ROW EXECUTE FUNCTION public.zztest_reconcile_guess_org();
