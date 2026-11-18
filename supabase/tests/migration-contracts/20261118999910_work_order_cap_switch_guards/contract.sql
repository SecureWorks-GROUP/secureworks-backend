BEGIN;
SET LOCAL statement_timeout = '90s';
-- Rule 17: stand the door back up as 20261118194100 left it, then apply twice.
\ir ../../../rollbacks/20261118999910_work_order_cap_switch_guards_down.sql
\ir ../../../migrations/20261118999910_work_order_cap_switch_guards.sql
\ir ../../../migrations/20261118999910_work_order_cap_switch_guards.sql

CREATE FUNCTION pg_temp.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ZZTEST %', label; END IF;
END $$;

DO $$ BEGIN
  PERFORM pg_temp.assert_ok(has_function_privilege('service_role', 'public.work_order_cap_start_preview(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.work_order_cap_start_preview(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.work_order_cap_start_preview(uuid)', 'EXECUTE'), 'preview grants');
  PERFORM pg_temp.assert_ok(NOT has_function_privilege('authenticated', 'public.set_work_order_cap_start(uuid,text,date,date,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.set_work_order_cap_start(uuid,text,date,date,text)', 'EXECUTE'), 'door grants');
END $$;

-- Made-up approver; the hold switch as seeded (no row = off).
UPDATE public.work_order_settings SET owner_user_ids = ARRAY['f1990910-0000-4000-8000-0000000000a1'::uuid] WHERE id = 1;
DELETE FROM public.feature_flags WHERE flag_name = 'trade_line_hold_v1';
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  -- Preview: a stranger is refused.
  BEGIN
    r := public.work_order_cap_start_preview('f1990910-0000-4000-8000-0000000000ff');
    RAISE EXCEPTION 'ZZTEST stranger previewed';
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.assert_ok(SQLERRM = 'work_order_cap_start_not_approver', 'stranger refusal');
  END;
  r := public.work_order_cap_start_preview('f1990910-0000-4000-8000-0000000000a1');
  PERFORM pg_temp.assert_ok(r->>'authority' = 'owner' AND (r->>'hold_switch_on')::boolean = false
    AND r->'cap_start_on' = 'null'::jsonb AND (r->>'settings_row')::boolean, 'preview answer, switch off');
  -- Switch off: set, then clear, both allowed and recorded.
  r := public.set_work_order_cap_start('f1990910-0000-4000-8000-0000000000a1', NULL, NULL, DATE '2026-11-24', 'ZZTEST set');
  PERFORM pg_temp.assert_ok((r->>'hold_switch_on')::boolean = false AND r->>'cap_start_on' = '2026-11-24', 'set with switch off');
  r := public.set_work_order_cap_start('f1990910-0000-4000-8000-0000000000a1', NULL, DATE '2026-11-24', NULL, 'ZZTEST clear off');
  PERFORM pg_temp.assert_ok((r->>'changed')::boolean AND r->'cap_start_on' = 'null'::jsonb, 'clear with switch off');
  r := public.set_work_order_cap_start('f1990910-0000-4000-8000-0000000000a1', NULL, NULL, DATE '2026-11-24', 'ZZTEST set again');
END $$;
RESET ROLE;
INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('trade_line_hold_v1', true);
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb; v_changes bigint;
BEGIN
  SELECT count(*) INTO v_changes FROM public.work_order_cap_start_changes;
  r := public.work_order_cap_start_preview('f1990910-0000-4000-8000-0000000000a1');
  PERFORM pg_temp.assert_ok((r->>'hold_switch_on')::boolean AND r->>'cap_start_on' = '2026-11-24', 'preview answer, switch on');
  -- Switch on: clearing is refused, nothing written or recorded.
  BEGIN
    r := public.set_work_order_cap_start('f1990910-0000-4000-8000-0000000000a1', NULL, DATE '2026-11-24', NULL, 'ZZTEST clear on');
    RAISE EXCEPTION 'ZZTEST cleared while on';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    PERFORM pg_temp.assert_ok(SQLERRM = 'work_order_cap_start_clear_while_on', 'clear refusal');
  END;
  PERFORM pg_temp.assert_ok((SELECT cap_start_on FROM public.work_order_cap_settings WHERE id = 1) = DATE '2026-11-24', 'date kept');
  PERFORM pg_temp.assert_ok((SELECT count(*) FROM public.work_order_cap_start_changes) = v_changes, 'refusal recorded a change');
  -- Switch on: moving the day still works, and the answer names the switch.
  r := public.set_work_order_cap_start('f1990910-0000-4000-8000-0000000000a1', NULL, DATE '2026-11-24', DATE '2026-12-01', 'ZZTEST later');
  PERFORM pg_temp.assert_ok((r->>'hold_switch_on')::boolean AND r->>'cap_start_on' = '2026-12-01', 'later with switch on');
  -- A retry of the saved day is unchanged, and says the switch too.
  r := public.set_work_order_cap_start('f1990910-0000-4000-8000-0000000000a1', NULL, DATE '2026-12-01', DATE '2026-12-01', 'ZZTEST again');
  PERFORM pg_temp.assert_ok(NOT (r->>'changed')::boolean AND (r->>'hold_switch_on')::boolean, 'unchanged answer');
END $$;
RESET ROLE;
-- The preview checks the approver before the settings read. Make that read fail: a
-- stranger (and a null actor) still gets the approver refusal, while an approver
-- reaches the read and gets its error. A preview that read first would fail both alike.
ALTER TABLE public.work_order_cap_settings RENAME TO zz_cap_settings_moved;
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  BEGIN
    r := public.work_order_cap_start_preview('f1990910-0000-4000-8000-0000000000ff');
    RAISE EXCEPTION 'ZZTEST stranger previewed with no settings table';
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM pg_temp.assert_ok(SQLERRM = 'work_order_cap_start_not_approver', 'stranger reached the settings read');
  END;
  BEGIN
    r := public.work_order_cap_start_preview(NULL);
    RAISE EXCEPTION 'ZZTEST null actor previewed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    r := public.work_order_cap_start_preview('f1990910-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'ZZTEST approver preview did not read the settings';
  EXCEPTION WHEN undefined_table THEN NULL;
  END;
END $$;
RESET ROLE;
ALTER TABLE public.zz_cap_settings_moved RENAME TO work_order_cap_settings;
-- With the row gone, an approver gets settings_row false and no date.
DELETE FROM public.work_order_cap_settings WHERE id = 1;
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.work_order_cap_start_preview('f1990910-0000-4000-8000-0000000000a1');
  PERFORM pg_temp.assert_ok(NOT (r->>'settings_row')::boolean AND r->'cap_start_on' = 'null'::jsonb, 'no settings row');
END $$;
RESET ROLE;
ROLLBACK;
SELECT 'FU49-9b cap switch guards (no clear while on, approver-first preview): passed' AS result;
