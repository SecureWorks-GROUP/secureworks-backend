-- Deliberately drop per-kind snapshot rows so only the all row survives.
CREATE FUNCTION public.zztest_drop_kind_snapshots()
RETURNS trigger LANGUAGE plpgsql AS $break$
/* block */ BEGIN
  IF NEW.kind <> 'all' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $break$;

CREATE TRIGGER zztest_drop_kind_snapshots
  BEFORE INSERT ON public.reconcile_waiting_daily
  FOR EACH ROW EXECUTE FUNCTION public.zztest_drop_kind_snapshots();
