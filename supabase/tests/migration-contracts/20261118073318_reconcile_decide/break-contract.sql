-- A writer that puts a different amount on the job than the line holds.
-- The contract re-applies the migrations, which leave this fixture trigger.
CREATE FUNCTION public.zztest_reconcile_part_drift() RETURNS trigger LANGUAGE plpgsql AS $break$
/* block */ BEGIN
 IF NEW.target = 'job' THEN NEW.amount_ex := NEW.amount_ex - 1; END IF;
 RETURN NEW;
END $break$;
CREATE TRIGGER zztest_reconcile_part_drift BEFORE INSERT ON public.job_cost_line_parts
 FOR EACH ROW EXECUTE FUNCTION public.zztest_reconcile_part_drift();
