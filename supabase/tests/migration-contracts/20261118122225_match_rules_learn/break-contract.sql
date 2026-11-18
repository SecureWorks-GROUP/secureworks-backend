-- Suppress only the proposed rule insert. The office decision remains valid.
CREATE FUNCTION public.zztest_skip_learned_rule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RETURN NULL; END $$;
CREATE TRIGGER zztest_skip_learned_rule BEFORE INSERT ON public.match_rules
 FOR EACH ROW EXECUTE FUNCTION public.zztest_skip_learned_rule();
