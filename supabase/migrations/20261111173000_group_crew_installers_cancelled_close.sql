-- Group work orders: who a booking puts on a group, and what happens to a
-- group when its job is cancelled (owner, 11 Nov 2026: the group work order
-- has to be "really simple, works").
--
-- Before:
-- 1. Any booking of anyone who is not an office admin made that person group
--    crew. An ops manager or estimator booked on a patio job was put on the
--    group by the 2-minute sweep and then owed hours, so the split could not
--    be made ready or frozen until the office removed them (live: two patio
--    groups each waiting on hours from an ops manager who never logs any).
-- 2. A group stayed open after its job was cancelled (live: one patio group,
--    nobody on it).
--
-- Now:
-- 1. A booking adds installers only: people whose role is crew or
--    lead_installer. Anyone else who works on site joins the group themselves
--    (Join in the trade app), or the office adds them. Everyone already on a
--    group stays on it and still counts, whatever their role: this file
--    takes nobody off. An office removal still wins over a booking
--    (20261106170000) and is not undone.
-- 2. close_group_work_orders_on_cancelled_jobs closes (void) an open group
--    on a cancelled or lost job when nothing on it could be owed: not frozen,
--    no sign-off or signature, no hours, no shares, nothing released, nobody
--    booked on a day up to today, and the job untouched for 7 days (so a job
--    cancelled by mistake and put back keeps its group). The auto_issue_job_work_orders
--    sweep calls it. Void is permanent, as for the office's own void.
--    Archived, complete and invoiced jobs keep their group: crew are still
--    paid from it.
--
-- Shares, super, rates, budgets and hours are not read differently and no
-- amount changes. No row is written when this file is applied, and nothing
-- sends. The runner supplies the transaction.

-- 1. A booking adds installers only.
DO $$
DECLARE
  body text := pg_get_functiondef('public.group_work_order_crew(uuid[])'::regprocedure);
  before_text text := $old$    AND lower(COALESCE(u.role::text, '')) <> 'admin'
$old$;
  after_text text := $new$    -- A booking adds installers only; anyone else joins the group
    -- themselves or stays on it as a member below (20261111173000).
    AND lower(COALESCE(u.role::text, '')) IN ('crew', 'lead_installer')
$new$;
BEGIN
  IF strpos(body, '(20261111173000)') > 0 THEN RETURN; END IF;
  IF strpos(body, before_text) = 0
     OR length(body) - length(replace(body, before_text, '')) <> length(before_text) THEN
    RAISE EXCEPTION 'group_work_order_crew changed; review before applying 20261111173000';
  END IF;
  EXECUTE replace(body, before_text, after_text);
END $$;

COMMENT ON FUNCTION public.group_work_order_crew(uuid[]) IS
  'Read-only shared required crew: bookings of installers (role crew or lead_installer) plus retained explicit group members of any role. No group, hours, rate, sign-off or share write.';

-- 2. A cancelled job's untouched group is closed.
CREATE OR REPLACE FUNCTION public.close_group_work_orders_on_cancelled_jobs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v record;
  v_closed jsonb := '[]'::jsonb;
BEGIN
  FOR v IN
    SELECT g.id, g.job_id
    FROM public.group_work_orders g
    JOIN public.jobs j ON j.id = g.job_id
    WHERE g.status = 'open'
      AND lower(COALESCE(j.status, '')) IN ('cancelled', 'lost')
    ORDER BY g.created_at, g.id
  LOOP
    -- Same order as every other group write: the job lock, then the row.
    PERFORM public.group_work_order_lock_job(v.job_id);
    UPDATE public.group_work_orders g
    SET status = 'void',
        voided_at = now(),
        void_reason = 'Job cancelled',
        updated_at = now()
    WHERE g.id = v.id
      AND g.status = 'open'
      AND g.split_frozen_at IS NULL
      AND g.client_signed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE j.id = g.job_id
          AND lower(COALESCE(j.status, '')) IN ('cancelled', 'lost')
          -- Put back within a week, the job keeps its group.
          AND j.updated_at < now() - interval '7 days'
      )
      AND NOT EXISTS (SELECT 1 FROM public.group_work_order_time_entries e WHERE e.group_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM public.group_work_order_shares s WHERE s.group_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM public.group_work_order_releases r WHERE r.group_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM public.group_work_order_signatures sg WHERE sg.group_id = g.id)
      AND NOT EXISTS (SELECT 1 FROM public.job_client_signoffs cs WHERE cs.job_id = g.job_id)
      -- Someone booked on a day that has come may have worked it: the office decides.
      AND NOT EXISTS (
        SELECT 1 FROM public.job_assignments a
        WHERE a.job_id = g.job_id
          AND a.scheduled_date <= (now() AT TIME ZONE 'Australia/Perth')::date
          AND lower(COALESCE(a.status, '')) <> 'cancelled'
          AND lower(COALESCE(a.role, '')) <> 'observer'
          AND COALESCE(a.is_ghost, false) = false
      );
    IF FOUND THEN
      INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
      VALUES (v.id, v.job_id, 'void_group', NULL,
        jsonb_build_object('reason', 'Job cancelled', 'automatic', true));
      v_closed := v_closed || jsonb_build_object('group_id', v.id, 'job_id', v.job_id);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('closed', v_closed);
END;
$$;
REVOKE ALL ON FUNCTION public.close_group_work_orders_on_cancelled_jobs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_group_work_orders_on_cancelled_jobs() TO service_role;
COMMENT ON FUNCTION public.close_group_work_orders_on_cancelled_jobs() IS
  '20261111173000: voids open groups on cancelled or lost jobs that hold no hours, shares, sign-off, signature, release or past booking, once the job has been untouched for 7 days. Called by the auto_issue_job_work_orders sweep. Touches no invoice and no amount.';
