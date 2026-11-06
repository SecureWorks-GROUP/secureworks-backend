-- Group work orders with less friction (owner, 6 Nov 2026: "just let the
-- trades self opt in ... let them log their own hours and then we will make
-- it"; "just let them sign their own").
--
-- 1. A crew member logs their own hours for any day on the job. The hours
--    no longer have to fall on a booked day: a multi-day booking is one
--    job_assignments row, so day two and later were refused before, and a
--    trade who opted in without a booking could log nothing.
-- 2. Every hour a crew member logs on the group counts in the split.
--    Who still owes hours stays the one crew population of
--    20261106083000 (group_work_order_crew), which this file does not touch.
--
-- The TypeScript twin of rule 2 is loadShareView in
-- group_work_order.ts. Change both together. No row is written by this file and
-- nothing sends. The runner supplies the transaction.

-- 1. Hours need a crew member or a booked day, not both.
DO $$
DECLARE
  body text;
  before_text text := $old$    IF NOT public.group_work_order_assignment_covers(v_job, NEW.user_id, NEW.work_date) THEN
      RAISE EXCEPTION 'group_hours_not_assigned' USING ERRCODE = '23514';
    END IF;$old$;
  after_text text := $new$    -- A crew member logs their own hours for any day on the job; a booked
    -- day is still accepted as before (20261106140000).
    IF NOT EXISTS (
      SELECT 1 FROM public.group_work_order_participants p
      WHERE p.group_id = NEW.group_id AND p.user_id = NEW.user_id
    ) AND NOT public.group_work_order_assignment_covers(v_job, NEW.user_id, NEW.work_date) THEN
      RAISE EXCEPTION 'group_hours_not_member' USING ERRCODE = '23514';
    END IF;$new$;
BEGIN
  body := pg_get_functiondef('public.group_work_order_time_entries_guard()'::regprocedure);
  IF strpos(body, '(20261106140000)') = 0 THEN
    IF strpos(body, before_text) = 0 THEN
      RAISE EXCEPTION 'group_work_order_time_entries_guard changed; review before applying 20261106140000';
    END IF;
    EXECUTE replace(body, before_text, after_text);
  END IF;
END $$;

-- 2. The split counts every crew hour, booked day or not.
DO $$
DECLARE
  body text;
  entries_before text := $old$  WHERE e.group_id = p_group_id
    AND e.hours > 0
    AND public.group_work_order_assignment_covers(v_job, e.user_id, e.work_date);$old$;
  entries_after text := $new$  WHERE e.group_id = p_group_id
    AND e.hours > 0; -- every crew hour counts, booked day or not (20261106140000)$new$;
BEGIN
  body := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
  IF strpos(body, '(20261106140000)') = 0 THEN
    IF strpos(body, entries_before) = 0 THEN
      RAISE EXCEPTION 'group_work_order_write_split changed; review before applying 20261106140000';
    END IF;
    EXECUTE replace(body, entries_before, entries_after);
  END IF;
END $$;
