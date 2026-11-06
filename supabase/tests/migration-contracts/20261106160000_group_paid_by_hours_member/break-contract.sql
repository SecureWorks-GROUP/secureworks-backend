-- Put back the old fence: any ordinary pay on the job refuses a group. The
-- contract must catch that the rest of the crew are stuck again.
DO $$
DECLARE body text;
BEGIN
  body := pg_get_functiondef('public.group_work_orders_refuse_existing_pay()'::regprocedure);
  body := replace(body, $o$      AND NOT public.group_work_order_line_is_paid_hours(l.line_type, l.source_work_order_id, l.description)
$o$, '');
  EXECUTE body;
END $$;
