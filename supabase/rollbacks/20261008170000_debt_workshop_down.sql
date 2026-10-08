-- Rollback for 20261008170000_debt_workshop.sql.
--
-- Removes the two Jan list cron jobs, the trigger function and the seven debt_ws_ tables.
--
-- Fail-closed: it refuses while any workshop record exists (a log row, a suggestion, a
-- send, a statement or a Jan list), so a rollback never silently discards what was sent,
-- noted or decided. Export or delete those rows first, on purpose. The settings row (the
-- switches, owners, not-chased list, statement emails and company aliases) and the
-- per-share states are settings and caches, not records, and go with their tables.
-- Re-running it is a no-op.

DO $$
DECLARE
  v_rows bigint := 0;
  v_table text;
  v_count bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'debt_ws_log', 'debt_ws_suggestions', 'debt_ws_sends',
    'debt_ws_statements', 'debt_ws_jan_lists'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', v_table) INTO v_count;
      v_rows := v_rows + v_count;
    END IF;
  END LOOP;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'rollback refused: % debt workshop record(s) exist (log, suggestions, sends, statements or Jan lists)', v_rows;
  END IF;
END $$;

DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.unschedule(jobname) FROM cron.job
   WHERE jobname IN ('debt-ws-jan-list-lock', 'debt-ws-jan-list-send');
END $cron$;

DROP FUNCTION IF EXISTS public.trigger_debt_ws_jan_list(text);
DROP TABLE IF EXISTS public.debt_ws_sends;
DROP TABLE IF EXISTS public.debt_ws_suggestions;
DROP TABLE IF EXISTS public.debt_ws_log;
DROP TABLE IF EXISTS public.debt_ws_states;
DROP TABLE IF EXISTS public.debt_ws_statements;
DROP TABLE IF EXISTS public.debt_ws_jan_lists;
DROP TABLE IF EXISTS public.debt_ws_settings;
