-- Deliberately make a clash skip one row instead of refusing the plan: the
-- contract must catch a half-applied move.
CREATE OR REPLACE FUNCTION public.reschedule_job_assignments_v1(
  p_job_id uuid, p_updates jsonb, p_deletes jsonb, p_creates jsonb,
  p_release_ghost_user_ids uuid[], p_released_invoice_statuses text[], p_operator text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_item jsonb;
BEGIN
  PERFORM 1 FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    PERFORM public.reschedule_job_assignments_refuse('job_not_found', 'Job not found');
  END IF;
  FOR v_item IN SELECT e FROM jsonb_array_elements(coalesce(p_updates, '[]')) AS e LOOP
    BEGIN
      UPDATE public.job_assignments
         SET scheduled_date = (v_item->>'scheduled_date')::date,
             scheduled_end = (v_item->>'scheduled_end')::date
       WHERE id = (v_item->>'id')::uuid;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;
  RETURN '{}'::jsonb;
END;
$$;
