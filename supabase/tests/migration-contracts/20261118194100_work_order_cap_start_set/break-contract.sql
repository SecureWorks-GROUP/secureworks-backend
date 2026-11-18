-- Break: a trigger that silently drops every record row, so a change of the start date is
-- no longer recorded. The migration's re-apply does not remove it.
CREATE FUNCTION public.zz_break_cap_start_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
CREATE TRIGGER zz_break_cap_start_record BEFORE INSERT ON public.work_order_cap_start_changes
  FOR EACH ROW EXECUTE FUNCTION public.zz_break_cap_start_record();
