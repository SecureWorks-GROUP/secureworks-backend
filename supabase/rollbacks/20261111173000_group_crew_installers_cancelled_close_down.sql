-- Down for 20261111173000_group_crew_installers_cancelled_close.sql. Deploy
-- the ops-api that does not call close_group_work_orders_on_cancelled_jobs
-- before running this (the sweep logs the missing function and carries on if
-- it is not). Any non-admin booking adds a person to a group again. A group
-- the automatic close voided stays void: void is permanent.
DO $$
DECLARE
  body text := pg_get_functiondef('public.group_work_order_crew(uuid[])'::regprocedure);
  new_text text := $new$    -- A booking adds installers only; anyone else joins the group
    -- themselves or stays on it as a member below (20261111173000).
    AND lower(COALESCE(u.role::text, '')) IN ('crew', 'lead_installer')
$new$;
  old_text text := $old$    AND lower(COALESCE(u.role::text, '')) <> 'admin'
$old$;
BEGIN
  IF strpos(body, '(20261111173000)') = 0 THEN RETURN; END IF;
  IF strpos(body, new_text) = 0 THEN
    RAISE EXCEPTION 'group_work_order_crew changed; review before rolling back 20261111173000';
  END IF;
  EXECUTE replace(body, new_text, old_text);
END $$;

COMMENT ON FUNCTION public.group_work_order_crew(uuid[]) IS
  'Read-only shared required crew: genuine non-admin allocations plus retained explicit group members. No group, hours, rate, sign-off or share write.';

DROP FUNCTION IF EXISTS public.close_group_work_orders_on_cancelled_jobs();
