-- G4: the office enters a missing crew member's days on a group work order,
-- with a recorded reason, and the crew member can dispute that entry.
-- (G3, the approver's "who is behind" read, needs no schema: it reads the
-- columns below and the existing tables.)
--
-- Why: one absent trade with no hours keeps a whole group in waiting_hours,
-- so nobody on the crew is paid. The office can now enter that person's days
-- for them. The entry says who entered it, when and why, and the person can
-- flag it as wrong. An open dispute holds the group: the split cannot freeze
-- and the claim cannot be marked invoiced until the office enters the days
-- again (which resolves the dispute) or the person enters their own.
--
-- Behind switch group_office_day_entry_v1, seeded OFF. Off, missing or
-- unreadable: both write functions refuse before any write. The columns and
-- the guards below are live from the first apply, but they only ever act on
-- rows the two functions wrote, so nothing changes while the switch is off.
--
-- 1. group_work_order_time_entries gains the office entry and dispute
--    columns. Only group_office_enter_hours and group_office_dispute_hours
--    may set them (a transaction-local marker); any other writer that sets
--    them is refused, and any other writer that changes the hours of an
--    office-entered day clears them (the person entered their own hours).
-- 2. group_office_enter_hours: a staff person or a pay run approver in the
--    group's company writes days for one participant, never for themselves
--    as a trade. It takes the same job lock as every crew hours write,
--    resolves the person's open dispute, and moves a started claim on the
--    same way the crew's own confirm does.
-- 3. group_office_dispute_hours: only the person the office entered days for
--    may dispute them, before the split freezes.
-- 4. A BEFORE UPDATE trigger on group_work_orders refuses a freeze, or a
--    claim marked invoiced, while an office entry is disputed.
-- 5. The audit log accepts office_enter_hours and dispute_office_hours.
--
-- No existing function body changes. No grant to anon, PUBLIC or
-- authenticated is added or changed: the new functions are service_role only.
-- Apply before the matching ops-api. The runner supplies the transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 0. the switch, off ─────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'group_office_day_entry_v1',
  false,
  'G4: the office may enter a missing crew member''s days on a group work order with a reason, and that person may dispute them. Off, missing or unreadable: both doors refuse with no write.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags WHERE flag_name = 'group_office_day_entry_v1'
);

-- ── 1. columns ─────────────────────────────────────────────────────────────

ALTER TABLE public.group_work_order_time_entries
  ADD COLUMN IF NOT EXISTS entered_by_office boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS office_entered_by uuid,
  ADD COLUMN IF NOT EXISTS office_entered_at timestamptz,
  ADD COLUMN IF NOT EXISTS office_entry_reason text,
  ADD COLUMN IF NOT EXISTS disputed_at timestamptz,
  ADD COLUMN IF NOT EXISTS disputed_by uuid,
  ADD COLUMN IF NOT EXISTS dispute_reason text,
  ADD COLUMN IF NOT EXISTS dispute_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_resolved_by uuid;

ALTER TABLE public.group_work_order_time_entries
  DROP CONSTRAINT IF EXISTS group_work_order_time_entries_office_entry_check;
ALTER TABLE public.group_work_order_time_entries
  ADD CONSTRAINT group_work_order_time_entries_office_entry_check CHECK (
    (NOT entered_by_office
      AND office_entered_by IS NULL AND office_entered_at IS NULL AND office_entry_reason IS NULL)
    OR (entered_by_office
      AND office_entered_by IS NOT NULL AND office_entered_at IS NOT NULL
      AND char_length(btrim(coalesce(office_entry_reason, ''))) BETWEEN 3 AND 500)
  );

ALTER TABLE public.group_work_order_time_entries
  DROP CONSTRAINT IF EXISTS group_work_order_time_entries_dispute_check;
ALTER TABLE public.group_work_order_time_entries
  ADD CONSTRAINT group_work_order_time_entries_dispute_check CHECK (
    (disputed_at IS NULL AND disputed_by IS NULL AND dispute_reason IS NULL
      AND dispute_resolved_at IS NULL AND dispute_resolved_by IS NULL)
    OR (entered_by_office
      AND disputed_at IS NOT NULL AND disputed_by IS NOT NULL
      AND char_length(btrim(coalesce(dispute_reason, ''))) BETWEEN 3 AND 500
      AND (dispute_resolved_at IS NULL) = (dispute_resolved_by IS NULL))
  );

CREATE INDEX IF NOT EXISTS idx_group_work_order_time_entries_open_dispute
  ON public.group_work_order_time_entries (group_id, user_id)
  WHERE disputed_at IS NOT NULL AND dispute_resolved_at IS NULL;

COMMENT ON COLUMN public.group_work_order_time_entries.entered_by_office IS
  '20261119091500: true when the office entered this day for the person. Set only by group_office_enter_hours; cleared when the person changes the day themselves.';
COMMENT ON COLUMN public.group_work_order_time_entries.office_entry_reason IS
  '20261119091500: why the office entered this day (3 to 500 characters). The person sees it on their own row.';
COMMENT ON COLUMN public.group_work_order_time_entries.disputed_at IS
  '20261119091500: the person flagged the office entry as wrong. While dispute_resolved_at is null the group cannot freeze or be marked invoiced.';

-- ── 2. who may set the columns ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.group_work_order_time_entries_office_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- The two office functions set this marker for their own transaction only.
  IF coalesce(current_setting('secureworks.group_office_entry', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.entered_by_office OR NEW.office_entered_by IS NOT NULL OR NEW.office_entered_at IS NOT NULL
       OR NEW.office_entry_reason IS NOT NULL OR NEW.disputed_at IS NOT NULL OR NEW.disputed_by IS NOT NULL
       OR NEW.dispute_reason IS NOT NULL OR NEW.dispute_resolved_at IS NOT NULL
       OR NEW.dispute_resolved_by IS NOT NULL THEN
      RAISE EXCEPTION 'group_office_entry_forged' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.entered_by_office, NEW.office_entered_by, NEW.office_entered_at, NEW.office_entry_reason,
      NEW.disputed_at, NEW.disputed_by, NEW.dispute_reason, NEW.dispute_resolved_at, NEW.dispute_resolved_by)
     IS DISTINCT FROM
     (OLD.entered_by_office, OLD.office_entered_by, OLD.office_entered_at, OLD.office_entry_reason,
      OLD.disputed_at, OLD.disputed_by, OLD.dispute_reason, OLD.dispute_resolved_at, OLD.dispute_resolved_by) THEN
    RAISE EXCEPTION 'group_office_entry_forged' USING ERRCODE = '42501';
  END IF;
  -- The person (or any other writer) changed the day itself: it is no longer
  -- the office's entry, and a dispute about the office's figures is moot.
  IF (NEW.work_date, NEW.start_time, NEW.finish_time, NEW.break_minutes, NEW.hours, NEW.user_id, NEW.group_id)
     IS DISTINCT FROM
     (OLD.work_date, OLD.start_time, OLD.finish_time, OLD.break_minutes, OLD.hours, OLD.user_id, OLD.group_id) THEN
    NEW.entered_by_office := false;
    NEW.office_entered_by := NULL;
    NEW.office_entered_at := NULL;
    NEW.office_entry_reason := NULL;
    NEW.disputed_at := NULL;
    NEW.disputed_by := NULL;
    NEW.dispute_reason := NULL;
    NEW.dispute_resolved_at := NULL;
    NEW.dispute_resolved_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_order_time_entries_office
  ON public.group_work_order_time_entries;
-- Named to fire after trg_group_work_order_time_entries_guard (alphabetical),
-- so the freeze, membership and identical-save rules run first.
CREATE TRIGGER trg_group_work_order_time_entries_office
  BEFORE INSERT OR UPDATE ON public.group_work_order_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.group_work_order_time_entries_office_guard();

-- ── 3. an open dispute holds the group ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.group_work_order_office_dispute_open(p_group_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_work_order_time_entries e
    WHERE e.group_id = p_group_id
      AND e.disputed_at IS NOT NULL
      AND e.dispute_resolved_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.group_work_orders_office_dispute_hold()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF ((NEW.split_frozen_at IS NOT NULL AND OLD.split_frozen_at IS NULL)
      OR (NEW.claim_state = 'invoiced' AND OLD.claim_state IS DISTINCT FROM 'invoiced'))
     AND public.group_work_order_office_dispute_open(NEW.id) THEN
    RAISE EXCEPTION 'group_office_hours_disputed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_orders_office_dispute_hold ON public.group_work_orders;
CREATE TRIGGER trg_group_work_orders_office_dispute_hold
  BEFORE UPDATE OF split_frozen_at, claim_state ON public.group_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.group_work_orders_office_dispute_hold();

-- ── 4. the audit log accepts the two new actions ───────────────────────────

DO $migration$
DECLARE
  prior text;
  expected text := $check$CHECK ((action = ANY (ARRAY['freeze'::text, 'unfreeze'::text, 'revoke_signoff'::text, 'void_group'::text, 'rekey'::text, 'remove_participant'::text, 'approve_budget'::text, 'amend_pay_basis'::text, 'release'::text, 'office_issue_invoices'::text, 'office_approve_hours'::text, 'restore_participant'::text, 'name_crew'::text, 'leave_claim'::text, 'confirm_hours'::text, 'approve_split'::text, 'dispute_split'::text, 'escalate'::text, 'issue_invoices'::text, 'office_settle'::text])))$check$;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO prior FROM pg_constraint
  WHERE conrelid = 'public.group_work_order_events'::regclass
    AND conname = 'group_work_order_events_action_check';
  IF prior IS NOT NULL AND strpos(prior, 'office_enter_hours') > 0 THEN
    RETURN;
  END IF;
  IF prior IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'group_work_order_events_action_check changed; review before applying 20261119091500';
  END IF;
  ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
  ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
    CHECK (action IN ('freeze','unfreeze','revoke_signoff','void_group','rekey','remove_participant',
      'approve_budget','amend_pay_basis','release','office_issue_invoices','office_approve_hours',
      'restore_participant','name_crew','leave_claim','confirm_hours','approve_split','dispute_split',
      'escalate','issue_invoices','office_settle','office_enter_hours','dispute_office_hours'));
END;
$migration$;

-- ── 5. the office enters days for one participant ──────────────────────────

CREATE OR REPLACE FUNCTION public.group_office_enter_hours(
  p_group_id uuid,
  p_actor uuid,
  p_target uuid,
  p_days jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  g public.group_work_orders;
  reason text := btrim(coalesce(p_reason, ''));
  today date := (now() AT TIME ZONE 'Australia/Perth')::date;
  day_row record;
  affected integer;
  edits integer := 0;
  resolved integer := 0;
  dates date[] := ARRAY[]::date[];
  written jsonb := '[]'::jsonb;
  replaced jsonb;
  prior_hash text;
  complete boolean;
  next_state text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
      WHERE flag_name = 'group_office_day_entry_v1' AND enabled IS TRUE) THEN
    RAISE EXCEPTION 'group_office_day_entry_disabled';
  END IF;
  IF char_length(reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'group_reason_invalid';
  END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION 'group_actor_required'; END IF;
  IF p_target IS NULL OR p_target = p_actor THEN
    RAISE EXCEPTION 'group_office_target_invalid';
  END IF;
  SELECT * INTO g FROM public.group_work_orders WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'group_work_order_not_found'; END IF;
  -- Staff in the group's company, or a pay run approver in it.
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_actor AND u.org_id = g.org_id
      AND (lower(coalesce(u.role::text, '')) IN ('admin', 'owner', 'ops_manager')
        OR EXISTS (SELECT 1 FROM public.trade_pay_settings s
          WHERE s.id = 1 AND p_actor = ANY (s.pay_run_approver_user_ids)))
  ) THEN
    RAISE EXCEPTION 'group_office_actor_not_staff';
  END IF;
  IF jsonb_typeof(p_days) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_days) NOT BETWEEN 1 AND 31 THEN
    RAISE EXCEPTION 'group_hours_required';
  END IF;

  -- The same lock order as every crew hours write (group_claim_member).
  PERFORM public.group_work_order_lock_job(g.job_id);
  SELECT * INTO STRICT g FROM public.group_work_orders WHERE id = p_group_id FOR UPDATE;
  IF g.status = 'void' THEN RAISE EXCEPTION 'group_work_order_void'; END IF;
  IF g.split_frozen_at IS NOT NULL THEN RAISE EXCEPTION 'group_split_frozen'; END IF;
  IF g.claim_state = 'invoiced' THEN RAISE EXCEPTION 'group_claim_invoiced'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.group_work_order_participants p
    JOIN public.users u ON u.id = p.user_id
    WHERE p.group_id = g.id AND p.user_id = p_target AND u.org_id = g.org_id
  ) THEN
    RAISE EXCEPTION 'group_office_target_not_member';
  END IF;

  FOR day_row IN SELECT * FROM jsonb_to_recordset(p_days)
      AS d(work_date date, start_time text, finish_time text, break_minutes int, hours numeric) LOOP
    IF day_row.work_date IS NULL OR day_row.work_date > today OR day_row.work_date = ANY (dates)
       OR day_row.start_time IS NULL OR day_row.start_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       OR day_row.finish_time IS NULL OR day_row.finish_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       OR day_row.break_minutes IS NULL OR day_row.break_minutes NOT BETWEEN 0 AND 600
       OR day_row.hours IS NULL OR day_row.hours <= 0 OR day_row.hours > 24 THEN
      RAISE EXCEPTION 'group_day_invalid';
    END IF;
    dates := dates || day_row.work_date;
  END LOOP;

  PERFORM set_config('secureworks.group_office_entry', 'on', true);

  -- Entering the days again is the office's answer to a dispute.
  UPDATE public.group_work_order_time_entries
  SET dispute_resolved_at = clock_timestamp(), dispute_resolved_by = p_actor
  WHERE group_id = g.id AND user_id = p_target
    AND disputed_at IS NOT NULL AND dispute_resolved_at IS NULL;
  GET DIAGNOSTICS resolved = ROW_COUNT;

  IF g.claim_state IN ('with_office', 'disputed') THEN
    prior_hash := public.group_claim_current_hash(g.id);
  END IF;

  -- What the office is replacing, for the log.
  SELECT coalesce(jsonb_agg(jsonb_build_object('work_date', e.work_date, 'start_time', e.start_time,
      'finish_time', e.finish_time, 'break_minutes', e.break_minutes, 'hours', e.hours,
      'entered_by_office', e.entered_by_office) ORDER BY e.work_date), '[]'::jsonb)
    INTO replaced
    FROM public.group_work_order_time_entries e
    WHERE e.group_id = g.id AND e.user_id = p_target AND e.work_date = ANY (dates);

  FOR day_row IN SELECT * FROM jsonb_to_recordset(p_days)
      AS d(work_date date, start_time text, finish_time text, break_minutes int, hours numeric) LOOP
    written := written || jsonb_build_object('work_date', day_row.work_date, 'start_time', day_row.start_time,
      'finish_time', day_row.finish_time, 'break_minutes', day_row.break_minutes, 'hours', round(day_row.hours, 2));
    INSERT INTO public.group_work_order_time_entries AS e
      (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours,
       entered_by_office, office_entered_by, office_entered_at, office_entry_reason)
    VALUES (g.id, p_target, day_row.work_date, day_row.start_time, day_row.finish_time,
      day_row.break_minutes, round(day_row.hours, 2), true, p_actor, clock_timestamp(), reason)
    ON CONFLICT (group_id, user_id, work_date) DO UPDATE SET
      start_time = excluded.start_time,
      finish_time = excluded.finish_time,
      break_minutes = excluded.break_minutes,
      hours = excluded.hours,
      entered_by_office = true,
      office_entered_by = excluded.office_entered_by,
      office_entered_at = excluded.office_entered_at,
      office_entry_reason = excluded.office_entry_reason,
      -- A fresh entry starts with no dispute; the resolved one is in the log.
      disputed_at = NULL, disputed_by = NULL, dispute_reason = NULL,
      dispute_resolved_at = NULL, dispute_resolved_by = NULL;
    edits := edits + 1;
  END LOOP;

  PERFORM set_config('secureworks.group_office_entry', 'off', true);

  -- A started claim moves on as it does for the crew's own confirm
  -- (group_claim_hours, 20261118122153). A group not on the claim flow
  -- (claim_state null) is left as it is.
  IF g.claim_state IS NOT NULL THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.group_work_order_participants p
      WHERE p.group_id = g.id AND NOT EXISTS (
        SELECT 1 FROM public.group_work_order_time_entries e
        WHERE e.group_id = g.id AND e.user_id = p.user_id AND e.hours > 0)) INTO complete;
    next_state := CASE WHEN complete THEN 'waiting_approval' ELSE 'waiting_hours' END;
    IF g.claim_state IN ('with_office', 'disputed') AND prior_hash IS NOT NULL
       AND prior_hash = public.group_claim_current_hash(g.id) THEN
      next_state := g.claim_state;
    END IF;
    UPDATE public.group_work_orders SET
      claim_state = next_state,
      claim_deadline_at = CASE WHEN next_state = 'waiting_approval' OR next_state IS DISTINCT FROM claim_state
        THEN clock_timestamp() + interval '48 hours' ELSE claim_deadline_at END
    WHERE id = g.id
    RETURNING claim_state INTO next_state;
  END IF;

  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (g.id, g.job_id, 'office_enter_hours', p_actor, jsonb_build_object(
    'user_id', p_target,
    'work_dates', to_jsonb(dates),
    'days', written,
    'replaced', replaced,
    'reason', reason,
    'resolved_disputes', resolved));

  RETURN jsonb_build_object(
    'ok', true,
    'group_id', g.id,
    'user_id', p_target,
    'days_written', edits,
    'resolved_disputes', resolved,
    'claim_state', next_state);
END;
$fn$;

-- ── 6. the person disputes the office's entry ──────────────────────────────

CREATE OR REPLACE FUNCTION public.group_office_dispute_hours(
  p_group_id uuid,
  p_actor uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  g public.group_work_orders;
  reason text := btrim(coalesce(p_reason, ''));
  marked integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags
      WHERE flag_name = 'group_office_day_entry_v1' AND enabled IS TRUE) THEN
    RAISE EXCEPTION 'group_office_day_entry_disabled';
  END IF;
  IF char_length(reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'group_reason_invalid';
  END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION 'group_actor_required'; END IF;
  SELECT * INTO g FROM public.group_work_orders WHERE id = p_group_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.group_work_order_participants p
    JOIN public.users u ON u.id = p.user_id
    WHERE p.group_id = g.id AND p.user_id = p_actor AND u.org_id = g.org_id
  ) THEN
    RAISE EXCEPTION 'group_claim_not_member';
  END IF;
  PERFORM public.group_work_order_lock_job(g.job_id);
  SELECT * INTO STRICT g FROM public.group_work_orders WHERE id = p_group_id FOR UPDATE;
  IF g.status = 'void' THEN RAISE EXCEPTION 'group_work_order_void'; END IF;
  -- Once the split is frozen the shares are fixed and may be invoiced.
  IF g.split_frozen_at IS NOT NULL THEN RAISE EXCEPTION 'group_split_frozen'; END IF;
  IF g.claim_state = 'invoiced' THEN RAISE EXCEPTION 'group_claim_invoiced'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_order_time_entries e
      WHERE e.group_id = g.id AND e.user_id = p_actor AND e.entered_by_office) THEN
    RAISE EXCEPTION 'group_office_entry_not_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_order_time_entries e
      WHERE e.group_id = g.id AND e.user_id = p_actor AND e.entered_by_office
        AND e.disputed_at IS NOT NULL AND e.dispute_resolved_at IS NULL) THEN
    RETURN jsonb_build_object('ok', true, 'group_id', g.id, 'disputed', true, 'already_disputed', true);
  END IF;

  PERFORM set_config('secureworks.group_office_entry', 'on', true);
  UPDATE public.group_work_order_time_entries
  SET disputed_at = clock_timestamp(), disputed_by = p_actor, dispute_reason = reason,
      dispute_resolved_at = NULL, dispute_resolved_by = NULL
  WHERE group_id = g.id AND user_id = p_actor AND entered_by_office;
  GET DIAGNOSTICS marked = ROW_COUNT;
  PERFORM set_config('secureworks.group_office_entry', 'off', true);

  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (g.id, g.job_id, 'dispute_office_hours', p_actor,
    jsonb_build_object('user_id', p_actor, 'reason', reason, 'days', marked));

  RETURN jsonb_build_object('ok', true, 'group_id', g.id, 'disputed', true, 'already_disputed', false);
END;
$fn$;

-- ── 7. grants: service_role only ───────────────────────────────────────────

REVOKE ALL ON FUNCTION public.group_work_order_time_entries_office_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_orders_office_dispute_hold() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_office_dispute_open(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_office_enter_hours(uuid, uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_office_dispute_hours(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_office_dispute_open(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_office_enter_hours(uuid, uuid, uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_office_dispute_hours(uuid, uuid, text) TO service_role;
