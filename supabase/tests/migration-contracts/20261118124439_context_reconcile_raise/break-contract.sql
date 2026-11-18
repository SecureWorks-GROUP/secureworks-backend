-- Break the invariant that explicit p_org_id never overrides reconcile_item_org
-- when the subject row carries its own organisation. The contract re-applies
-- this migration, leaving this fixture trigger on reconcile_items.
CREATE FUNCTION public.zztest_p4_01_6_override_org() RETURNS trigger
LANGUAGE plpgsql AS $break$
/* block */ BEGIN
  IF NEW.subject_table = 'jobs' THEN
    NEW.org_id := '00000000-0000-0000-0000-0000000000a1';
  END IF;
  RETURN NEW;
END $break$;
CREATE TRIGGER zztest_p4_01_6_override_org
  BEFORE INSERT ON public.reconcile_items
  FOR EACH ROW EXECUTE FUNCTION public.zztest_p4_01_6_override_org();
