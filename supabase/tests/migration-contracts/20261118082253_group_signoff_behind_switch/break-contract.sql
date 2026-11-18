-- Put main's direct sign-off call back in the writer: the contract must fail.
DO $$
DECLARE body text := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
/* block */ BEGIN
  EXECUTE replace(body, 'public.group_client_signoff_gate_passes(', 'public.group_client_signoff_counts(');
END $$;
