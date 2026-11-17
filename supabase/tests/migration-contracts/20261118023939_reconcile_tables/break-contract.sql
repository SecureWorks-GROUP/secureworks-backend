-- A producer that substitutes a permitted action would bypass the person guard.
-- Restore-on-entry does not erase this independent adversarial fixture trigger.
CREATE FUNCTION public.zztest_reconcile_wrong_action() RETURNS trigger LANGUAGE plpgsql AS $break$
BEGIN
 IF NEW.action='overhead' AND NEW."by"='matcher:v1' THEN NEW.action:='place'; END IF;
 RETURN NEW;
END $break$;
CREATE TRIGGER zztest_reconcile_wrong_action BEFORE INSERT ON public.reconcile_decisions
 FOR EACH ROW EXECUTE FUNCTION public.zztest_reconcile_wrong_action();
