-- Give anon back EXECUTE on one owner-rights routine; contract 1 must catch it.
GRANT EXECUTE ON FUNCTION public.zgs_definer_open(int) TO anon;
