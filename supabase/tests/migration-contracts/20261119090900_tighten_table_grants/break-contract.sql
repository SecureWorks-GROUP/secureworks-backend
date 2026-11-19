-- Give anon back TRUNCATE on one tightened relation (row rules never stop it);
-- contract 2b must catch it.
GRANT TRUNCATE ON public.ztg_rls_off TO anon;
