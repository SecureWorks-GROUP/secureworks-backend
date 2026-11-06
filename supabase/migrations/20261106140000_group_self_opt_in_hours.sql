-- Group work orders with less friction (owner, 6 Nov 2026: "just let the
-- trades self opt in ... let them log their own hours and then we will make
-- it"; "just let them sign their own").
--
-- 1. A crew member logs their own hours for any day on the job. The hours
--    no longer have to fall on a booked day: a multi-day booking is one
--    job_assignments row, so day two and later were refused before, and a
--    trade who opted in without a booking could log nothing.
-- 2. Every hour logged on the group counts in the split.
-- 3. The split does not wait for hours from office staff (admin, owner,
--    ops_manager) booked on the job to watch it who never joined the crew.
--    Anyone on the crew still needs hours, office staff included. A booked
--    trade who has not joined, or who left, is still named: the office
--    cancels the booking or they join, so nobody booked goes unpaid.
--
-- The TypeScript twin of rules 2 and 3 is loadShareView in
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

-- 2 and 3. The split counts every crew hour and names only the people who
-- still owe hours.
DO $$
DECLARE
  body text;
  entries_before text := $old$  WHERE e.group_id = p_group_id
    AND e.hours > 0
    AND public.group_work_order_assignment_covers(v_job, e.user_id, e.work_date);$old$;
  entries_after text := $new$  WHERE e.group_id = p_group_id
    AND e.hours > 0; -- every crew hour counts, booked day or not (20261106140000)$new$;
  booked_before text := $old$      AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') IS DISTINCT FROM 'true'
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = a.user_id
      )
  ) missing;$old$;
  booked_after text := $new$      AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') IS DISTINCT FROM 'true'
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = a.user_id
      )
      -- Booked office staff watching the job who never joined the crew.
      AND NOT (
        EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = a.user_id
            AND lower(COALESCE(u.role, '')) IN ('admin', 'owner', 'ops_manager')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.group_work_order_participants p2
          WHERE p2.group_id = p_group_id AND p2.user_id = a.user_id
        )
      )
  ) missing;$new$;
BEGIN
  body := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
  IF strpos(body, '(20261106140000)') = 0 THEN
    IF strpos(body, entries_before) = 0 OR strpos(body, booked_before) = 0 THEN
      RAISE EXCEPTION 'group_work_order_write_split changed; review before applying 20261106140000';
    END IF;
    body := replace(body, entries_before, entries_after);
    body := replace(body, booked_before, booked_after);
    EXECUTE body;
  END IF;
END $$;
