-- Deliberately misroute the first split part beneath the real reader. The
-- contract re-applies its own migration, so break the input rather than a view
-- that replay would restore. The original split/commitment assertion must fail.
CREATE FUNCTION public.zztest_cost_part_misroute() RETURNS trigger LANGUAGE plpgsql AS $break$
BEGIN
 IF NEW.line_id='00000000-0000-0000-0000-00000000e720'
 AND NEW.job_id='00000000-0000-0000-0000-00000000e701' THEN
  NEW.job_id:='00000000-0000-0000-0000-00000000e702';
 END IF;
 RETURN NEW;
END $break$;
CREATE TRIGGER zztest_cost_part_misroute BEFORE INSERT ON public.job_cost_line_parts
FOR EACH ROW EXECUTE FUNCTION public.zztest_cost_part_misroute();
