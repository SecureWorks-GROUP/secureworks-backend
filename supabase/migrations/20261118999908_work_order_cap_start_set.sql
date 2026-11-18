-- Follow-up 49 item 9(b), before the switch: the work order cap's start date is set by an
-- approver through one function that records who set it, when and why.
-- Placeholder version: the keeper stamps the real one.
--
-- * set_work_order_cap_start(actor, email, shown, start, reason): owner_approval_authority
--   decides who may set it, checked first, before anything is read. The approver passes the
--   date they were shown; a date that moved since is refused (40001), so two approvers never
--   overwrite each other blind. Asking for the date already saved answers changed=false and
--   records nothing (a retry). It writes its own record row, naming the approver. Service role
--   only; ops-api calls it for a signed-in person. No company check: the settings row and the
--   approver list are both global. Anyone holding the service key can call it naming any
--   approver, the same trust as raise_job_labour_cap.
-- * work_order_cap_start_changes: append-only, one row per change of cap_start_on. Grows only
--   when a person changes the date; nothing reads it on a timer.
-- * install_work_order_cap_start_record() / remove_work_order_cap_start_record(): the director
--   installs, after proof, an AFTER trigger on work_order_cap_settings that also records any
--   change made by hand in SQL (via direct_sql, naming the database role). A change made
--   through the door is recorded once: the trigger skips the row the door wrote in the same
--   transaction for the same change. Not installed on merge.
-- Definitions only: one new table and five functions. No existing table is altered or
-- locked, and no trigger, timer, schedule or switch is created.
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
  'Follow-up 49 item 9(b): changes of work_order_cap_settings.cap_start_on, append-only. via approver: written by set_work_order_cap_start, naming the approver. via direct_sql: written by the trigger install_work_order_cap_start_record installs, naming the database role, for any other write.';
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

-- Records a change made other than through the door (installed by the function below). The
-- door's own row, written earlier in the same transaction for exactly this change, is the
-- record of a door change; a session cannot fake one (no role may insert a row by hand).
CREATE OR REPLACE FUNCTION public.work_order_cap_settings_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_before date; v_after date;
  v_door text := nullif(current_setting('sw.work_order_cap_start_change', true), '');
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_before := OLD.cap_start_on; END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') THEN v_after := NEW.cap_start_on; END IF;
  IF TG_OP = 'UPDATE' AND v_before IS NOT DISTINCT FROM v_after THEN RETURN NULL; END IF;
  IF v_door ~ '^[0-9]+$' AND EXISTS (
       SELECT 1 FROM public.work_order_cap_start_changes c
        WHERE c.id = v_door::bigint AND c.via = 'approver' AND c.changed_at = now()
          AND c.previous_start IS NOT DISTINCT FROM v_before
          AND c.new_start IS NOT DISTINCT FROM v_after) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.work_order_cap_start_changes (previous_start, new_start, via, db_role)
  VALUES (v_before, v_after, 'direct_sql',
          coalesce(nullif(current_setting('role', true), 'none'), session_user::text));
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION public.work_order_cap_settings_record() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.install_work_order_cap_start_record()
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $install$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.work_order_cap_settings'::regclass
      AND tgname = 'work_order_cap_settings_record' AND NOT tgisinternal) THEN
    CREATE TRIGGER work_order_cap_settings_record
      AFTER INSERT OR UPDATE OR DELETE ON public.work_order_cap_settings
      FOR EACH ROW EXECUTE FUNCTION public.work_order_cap_settings_record();
  END IF;
END $install$;
CREATE OR REPLACE FUNCTION public.remove_work_order_cap_start_record()
RETURNS void LANGUAGE plpgsql SET search_path = public, pg_temp AS $remove$ BEGIN
  IF to_regclass('public.work_order_cap_settings') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS work_order_cap_settings_record ON public.work_order_cap_settings;
  END IF;
END $remove$;
REVOKE ALL ON FUNCTION public.install_work_order_cap_start_record(), public.remove_work_order_cap_start_record()
  FROM PUBLIC, anon, authenticated, service_role;

-- The approver's door. Who may set it is checked before anything is read.
CREATE OR REPLACE FUNCTION public.set_work_order_cap_start(
  p_actor uuid,
  p_actor_email text,
  p_shown_start date,
  p_start date,
  p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_authority text; v_current date; v_change bigint;
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
  INSERT INTO public.work_order_cap_start_changes
    (previous_start, new_start, via, set_by, set_by_email, authority, reason, db_role)
  VALUES (v_current, p_start, 'approver', p_actor, nullif(btrim(p_actor_email), ''), v_authority,
          btrim(p_reason), coalesce(nullif(current_setting('role', true), 'none'), session_user::text))
  RETURNING id INTO v_change;
  -- No record, no change (a missing record row is never a silent success).
  IF v_change IS NULL THEN
    RAISE EXCEPTION 'work_order_cap_start_not_recorded' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('sw.work_order_cap_start_change', v_change::text, true);
  UPDATE public.work_order_cap_settings SET cap_start_on = p_start, updated_at = now() WHERE id = 1;
  PERFORM set_config('sw.work_order_cap_start_change', '', true);
  RETURN jsonb_build_object('changed', true, 'cap_start_on', p_start,
                            'previous_start', v_current, 'authority', v_authority, 'change_id', v_change);
END $fn$;
REVOKE ALL ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_work_order_cap_start(uuid, text, date, date, text) TO service_role;
