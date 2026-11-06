-- Require a booked day again: the contract must catch it.
DO $$
DECLARE body text;
BEGIN
  body := pg_get_functiondef('public.group_work_order_time_entries_guard()'::regprocedure);
  body := replace(body, $o$    IF NOT EXISTS (
      SELECT 1 FROM public.group_work_order_participants p
      WHERE p.group_id = NEW.group_id AND p.user_id = NEW.user_id
    ) AND NOT public.group_work_order_assignment_covers(v_job, NEW.user_id, NEW.work_date) THEN$o$,
    $n$    IF NOT public.group_work_order_assignment_covers(v_job, NEW.user_id, NEW.work_date) THEN$n$);
  EXECUTE body;
END $$;
