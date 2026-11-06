-- Let bookings win over an office removal again: the contract must catch it.
DO $$
DECLARE body text;
BEGIN
  body := pg_get_functiondef('public.group_work_order_crew(uuid[])'::regprocedure);
  body := replace(body, $o$        AND r.restored_at IS NULL
$o$, $n$        AND r.restored_at IS NULL AND false
$n$);
  EXECUTE body;
END $$;
