-- Break: the stored cost events no longer copy the live view (a refresh that
-- stores the wrong amounts). Re-applying the migrations cannot heal it, and
-- the contract's stored-versus-installed parity must catch it.
CREATE FUNCTION public.zz_break_stored_cost() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.amount_ex := coalesce(NEW.amount_ex,0) + 1; RETURN NEW; END $f$;
CREATE TRIGGER zz_break_stored_cost BEFORE INSERT ON public.job_cost_events_stored
 FOR EACH ROW EXECUTE FUNCTION public.zz_break_stored_cost();
