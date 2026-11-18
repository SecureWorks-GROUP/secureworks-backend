-- Follow-up 49 item 9(b), before the switch: the work order cap's start date is set by an
-- approver through one function that records who set it, when and why; every other change
-- to it (direct SQL as before) is recorded too, naming the database role, never no one.
-- Placeholder version: the keeper stamps the real one.
--
-- * set_work_order_cap_start(actor, email, shown, start, reason): owner_approval_authority
--   decides who may set it, checked first, before anything is read. The approver passes the
--   date they were shown; a date that moved since is refused (40001), so two approvers never
--   overwrite each other blind. Asking for the date already saved answers changed=false and
--   records nothing (a retry). Service role only; ops-api calls it for a signed-in person.
--   There is no company check: the settings row and the approver list are both global.
-- * work_order_cap_start_changes: append-only, one row per change of cap_start_on (insert,
--   update or delete of the settings row), written only by the trigger below.
-- * work_order_cap_settings_record: AFTER trigger on work_order_cap_settings. A change made
--   through the function names the approver; any other change names the database role.
--   Anyone holding the service key can call the function naming any approver, the same trust
--   as raise_job_labour_cap.
-- Existing table locked on apply: work_order_cap_settings (CREATE TRIGGER, one row). No timer,
-- schedule or switch. The cap's scope rule (work_order_cap_scope) is not changed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$ BEGIN
  IF to_regclass('public.work_order_cap_settings') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='work_order_cap_settings'
            AND (column_name, data_type) IN (('id','smallint'),('cap_start_on','date'),
                                             ('updated_at','timestamp with time zone'))) <> 3 THEN
    RAISE EXCEPTION 'work_order_cap_start_pre_image' USING DETAIL='work_order_cap_settings';
  END IF;
  IF to_regprocedure('public.owner_approval_authority(uuid)') IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_start_pre_image' USING DETAIL='owner_approval_authority';
  END IF;
  -- A re-apply keeps the record (the rollback keeps it too); its shape must be this one.
  IF to_regclass('public.work_order_cap_start_changes') IS NOT NULL
     AND (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='work_order_cap_start_changes') <> 10 THEN
    RAISE EXCEPTION 'work_order_cap_start_pre_image' USING DETAIL='work_order_cap_start_changes';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.work_order_cap_start_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  previous_start date,
  new_start date,
  via text NOT NULL CHECK (via IN ('approver', 'direct_sql')),
  set_by uuid,
  set_by_email text,
  authority text,
  reason text,
  db_role text NOT NULL,
  CONSTRAINT work_order_cap_start_changes_approver_named CHECK (
    via <> 'approver' OR (set_by IS NOT NULL AND authority IS NOT NULL AND reason IS NOT NULL))
);
COMMENT ON TABLE public.work_order_cap_start_changes IS
  'Follow-up 49 item 9(b): every change of work_order_cap_settings.cap_start_on, append-only. via approver: set_work_order_cap_start, naming the approver. via direct_sql: any other write, naming the database role. Written only by work_order_cap_settings_record.';
ALTER TABLE public.work_order_cap_start_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.work_order_cap_start_changes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.work_order_cap_start_changes TO service_role;

CREATE OR REPLACE FUNCTION public.work_order_cap_start_changes_write_once()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'work_order_cap_start_changes_write_once' USING ERRCODE = '42501';
END $fn$;
REVOKE ALL ON FUNCTION public.work_order_cap_start_changes_write_once() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS work_order_cap_start_changes_write_once ON public.work_order_cap_start_changes;
CREATE TRIGGER work_order_cap_start_changes_write_once
  BEFORE UPDATE OR DELETE ON public.work_order_cap_start_changes
  FOR EACH ROW EXECUTE FUNCTION public.work_order_cap_start_changes_write_once();
DROP TRIGGER IF EXISTS work_order_cap_start_changes_no_truncate ON public.work_order_cap_start_changes;
CREATE TRIGGER work_order_cap_start_changes_no_truncate
  BEFORE TRUNCATE ON public.work_order_cap_start_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public.work_order_cap_start_changes_write_once();

-- The record. The approver's details come from a transaction-local setting that only
-- set_work_order_cap_start sets and clears around its own update.
CREATE OR REPLACE FUNCTION public.work_order_cap_settings_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_before date; v_after date; v_by jsonb;
  v_role text := coalesce(nullif(current_setting('role', true), 'none'), session_user::text);
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_before := OLD.cap_start_on; END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN v_after := NEW.cap_start_on; END IF;
  IF TG_OP = 'UPDATE' AND v_before IS NOT DISTINCT FROM v_after THEN RETURN NULL; END IF;
  v_by := nullif(current_setting('sw.work_order_cap_start_by', true), '')::jsonb;
  INSERT INTO public.work_order_cap_start_changes
    (previous_start, new_start, via, set_by, set_by_email, authority, reason, db_role)
  VALUES (v_before, v_after,
          CASE WHEN v_by IS NULL THEN 'direct_sql' ELSE 'approver' END,
          (v_by ->> 'set_by')::uuid, v_by ->> 'email', v_by ->> 'authority', v_by ->> 'reason',
          v_role);
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.work_order_cap_settings_record() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS work_order_cap_settings_record ON public.work_order_cap_settings;
CREATE TRIGGER work_order_cap_settings_record
  AFTER INSERT OR UPDATE OR DELETE ON public.work_order_cap_settings
  FOR EACH ROW EXECUTE FUNCTION public.work_order_cap_settings_record();

-- The approver's door. Who may set it is checked before anything is read.
CREATE OR REPLACE FUNCTION public.set_work_order_cap_start(
  p_actor uuid,
  p_actor_email text,
  p_shown_start date,
  p_start date,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_authority text; v_current date;
BEGIN
  v_authority := public.owner_approval_authority(p_actor);
  IF v_authority IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_start_not_approver' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'work_order_cap_start_reason_invalid' USING ERRCODE = '22023';
  END IF;
  -- work_order_cap_settings_pkey, locked so two approvers queue.
  SELECT s.cap_start_on INTO v_current FROM public.work_order_cap_settings s WHERE s.id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_order_cap_settings_missing' USING ERRCODE = 'P0002';
  END IF;
  IF v_current IS NOT DISTINCT FROM p_start THEN
    RETURN jsonb_build_object('changed', false, 'cap_start_on', v_current, 'authority', v_authority);
  END IF;
  IF v_current IS DISTINCT FROM p_shown_start THEN
    RAISE EXCEPTION 'work_order_cap_start_changed' USING ERRCODE = '40001';
  END IF;
  PERFORM set_config('sw.work_order_cap_start_by', jsonb_build_object(
    'set_by', p_actor, 'email', nullif(btrim(p_actor_email), ''),
    'authority', v_authority, 'reason', btrim(p_reason))::text, true);
  UPDATE public.work_order_cap_settings SET cap_start_on = p_start, updated_at = now() WHERE id = 1;
  PERFORM set_config('sw.work_order_cap_start_by', '', true);
  RETURN jsonb_build_object('changed', true, 'cap_start_on', p_start,
                            'previous_start', v_current, 'authority', v_authority);
END $fn$;
REVOKE ALL ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) TO service_role;
