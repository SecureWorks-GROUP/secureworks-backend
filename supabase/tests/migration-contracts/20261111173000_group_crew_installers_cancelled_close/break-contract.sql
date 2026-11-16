-- Let any non-admin booking add a person again: the contract must catch it.
DO $$
DECLARE body text;
BEGIN
  body := pg_get_functiondef('public.group_work_order_crew(uuid[])'::regprocedure);
  body := replace(body, $o$IN ('crew', 'lead_installer')$o$, $n$<> 'admin'$n$);
  EXECUTE body;
END $$;
