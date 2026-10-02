-- Re-open exec_sql to anon, as if the revoke had been omitted.
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO anon;
