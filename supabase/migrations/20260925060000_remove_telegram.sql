-- Remove every Telegram trace from the database (Captain 25 Sep 2026: "Delete
-- everything to do with telegram across our entire system. Nobody uses it and
-- we never will.").
--
-- Already gone from production before this file: every Telegram
-- business_events row and fact, the users' Telegram values, the telegram-bot
-- edge function, the TELEGRAM_BOT_TOKEN secret and the deliver-proposed-actions
-- cron job. This migration removes what is left in the schema, so nothing can
-- write, route or deliver to Telegram again:
--
--   1. columns: users.telegram_id (+ users_telegram_id_key, idx_users_telegram),
--      users.telegram_username, staff_agent_preferences.telegram_user_id
--      (+ its unique key and idx_staff_prefs_telegram), inbox_events.telegram_notified
--      (648 delivery flags, dropped by design);
--   2. public.deliver_proposed_actions(): Telegram was its only delivery path, it
--      posted to the deleted telegram-bot function, and EXECUTE was granted to
--      PUBLIC/anon/authenticated. Any cron job still invoking it is unscheduled;
--   3. the 13 authority_levels rows whose channel is telegram, and the
--      action_permissions send_telegram row;
--   4. 'telegram' as an allowed value in nine channel CHECK constraints, and all
--      six 'telegram' column defaults. Chosen from each column's real writers:
--        smart_nudges.channel          -> 'dashboard'. generate_smart_nudges()
--          (cron generate-smart-nudges) never sets channel, so every nudge took
--          'telegram'; nudges are read on screen and by sw_list_smart_nudges. The
--          existing telegram rows (1650 at the read, still growing) become
--          'dashboard', count-checked inside this transaction.
--        conversation_sessions.channel -> 'dashboard' (NOT NULL; ops-ai is the
--          only writer and always sends dashboard/ceo_dashboard/canary_test;
--          all 43 stored rows are dashboard).
--        conversation_history.channel  -> 'dashboard' (NOT NULL; same writer).
--        pending_confirmations.channel -> no default (nullable, table empty).
--        commitments.source_channel, corrections.corrected_via -> no default
--          (tables empty; 'dashboard' would violate their CHECKs, which admit
--          only web/api/system);
--   5. 'telegram' from v_evidence_health's comms_missing_preview list. While the
--      view is rewritten, the write grants anon/authenticated/PUBLIC held on it
--      are revoked (SELECT for authenticated kept);
--   6. the Telegram wording in trigger_daily_digest()'s comment.
--
-- Guards pin the production pre-image read on 25 Sep 2026 (read-only). An
-- object that is absent is skipped (a migration-only database never had these
-- live-drift objects), an object already in its post-state is skipped (re-apply
-- is a no-op), and any object in a third shape refuses the whole migration
-- rather than guess. Row data that must already be empty (users and
-- staff_agent_preferences Telegram values) refuses when present.
--
-- Rollback (supabase/rollbacks/20260925060000_remove_telegram_down.sql) re-adds
-- the four columns empty with their indexes, and re-admits 'telegram' in the
-- CHECKs, defaults and view. It restores no data, no function and no grant.

DO $$
DECLARE
  v_count bigint;
  v_rows bigint;
  v_type text;
  v_md5 text;
  v_def text;
  r record;
BEGIN
  -- 1. Columns ---------------------------------------------------------------
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.users') AND a.attname = 'telegram_id' AND NOT a.attisdropped;
  IF v_type IS NOT NULL THEN
    IF v_type <> 'bigint' THEN
      RAISE EXCEPTION 'remove_telegram: users.telegram_id is %, expected bigint', v_type;
    END IF;
    EXECUTE 'SELECT count(*) FROM public.users WHERE telegram_id IS NOT NULL' INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'remove_telegram: users.telegram_id still holds % value(s), expected 0', v_count;
    END IF;
    ALTER TABLE public.users DROP COLUMN telegram_id;
  END IF;

  v_type := NULL;
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.users') AND a.attname = 'telegram_username' AND NOT a.attisdropped;
  IF v_type IS NOT NULL THEN
    IF v_type <> 'text' THEN
      RAISE EXCEPTION 'remove_telegram: users.telegram_username is %, expected text', v_type;
    END IF;
    EXECUTE 'SELECT count(*) FROM public.users WHERE telegram_username IS NOT NULL' INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'remove_telegram: users.telegram_username still holds % value(s), expected 0', v_count;
    END IF;
    ALTER TABLE public.users DROP COLUMN telegram_username;
  END IF;

  v_type := NULL;
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.staff_agent_preferences') AND a.attname = 'telegram_user_id' AND NOT a.attisdropped;
  IF v_type IS NOT NULL THEN
    IF v_type <> 'bigint' THEN
      RAISE EXCEPTION 'remove_telegram: staff_agent_preferences.telegram_user_id is %, expected bigint', v_type;
    END IF;
    EXECUTE 'SELECT count(*) FROM public.staff_agent_preferences WHERE telegram_user_id IS NOT NULL' INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'remove_telegram: staff_agent_preferences.telegram_user_id still holds % value(s), expected 0', v_count;
    END IF;
    ALTER TABLE public.staff_agent_preferences DROP COLUMN telegram_user_id;
  END IF;

  v_type := NULL;
  SELECT format_type(a.atttypid, a.atttypmod) INTO v_type
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public.inbox_events') AND a.attname = 'telegram_notified' AND NOT a.attisdropped;
  IF v_type IS NOT NULL THEN
    IF v_type <> 'boolean' THEN
      RAISE EXCEPTION 'remove_telegram: inbox_events.telegram_notified is %, expected boolean', v_type;
    END IF;
    ALTER TABLE public.inbox_events DROP COLUMN telegram_notified;
  END IF;

  -- 2. deliver_proposed_actions() and any cron job that calls it --------------
  -- Production md5(pg_get_functiondef) was 60d6ad1c4f30eb9fc424817a3a97d080. The
  -- pin is structural so it holds on any deparse: no arguments, returns jsonb,
  -- posts to telegram-bot, and no other function calls it.
  IF to_regprocedure('public.deliver_proposed_actions()') IS NOT NULL THEN
    SELECT p.prosrc, pg_get_function_result(p.oid) INTO v_def, v_type
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.deliver_proposed_actions()');
    IF v_type <> 'jsonb' OR v_def NOT ILIKE '%telegram-bot%' THEN
      RAISE EXCEPTION 'remove_telegram: deliver_proposed_actions() is not the Telegram delivery function (returns %)', v_type;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_proc q
      WHERE q.oid <> to_regprocedure('public.deliver_proposed_actions()')
        AND q.prosrc ILIKE '%deliver_proposed_actions%'
    ) THEN
      RAISE EXCEPTION 'remove_telegram: another function calls deliver_proposed_actions()';
    END IF;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR r IN
      EXECUTE $q$SELECT jobid FROM cron.job
                 WHERE jobname = 'deliver-proposed-actions'
                    OR command ILIKE '%deliver_proposed_actions%'$q$
    LOOP
      EXECUTE 'SELECT cron.unschedule($1)' USING r.jobid;
    END LOOP;
  END IF;
  DROP FUNCTION IF EXISTS public.deliver_proposed_actions();

  -- 3. Telegram rows ---------------------------------------------------------
  IF to_regclass('public.authority_levels') IS NOT NULL THEN
    LOCK TABLE public.authority_levels IN SHARE ROW EXCLUSIVE MODE;
    EXECUTE $q$SELECT count(*) FROM public.authority_levels WHERE channel = 'telegram'$q$ INTO v_count;
    IF v_count NOT IN (0, 13) THEN
      RAISE EXCEPTION 'remove_telegram: authority_levels holds % telegram row(s), expected 13 (or 0 once removed)', v_count;
    END IF;
    EXECUTE $q$DELETE FROM public.authority_levels WHERE channel = 'telegram'$q$;
  END IF;

  IF to_regclass('public.action_permissions') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM public.action_permissions
               WHERE action_type ILIKE '%telegram%' AND action_type <> 'send_telegram'$q$ INTO v_count;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'remove_telegram: action_permissions holds % unexpected telegram action type(s)', v_count;
    END IF;
    EXECUTE $q$DELETE FROM public.action_permissions WHERE action_type = 'send_telegram'$q$;
  END IF;

  -- 4. Defaults, then CHECK constraints ---------------------------------------
  IF to_regclass('public.smart_nudges') IS NOT NULL THEN
    -- Hold off generate_smart_nudges() so the count and the update see the same rows.
    LOCK TABLE public.smart_nudges IN SHARE ROW EXCLUSIVE MODE;
    EXECUTE $q$SELECT count(*) FROM public.smart_nudges WHERE channel = 'telegram'$q$ INTO v_count;
    EXECUTE $q$UPDATE public.smart_nudges SET channel = 'dashboard' WHERE channel = 'telegram'$q$;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_count THEN
      RAISE EXCEPTION 'remove_telegram: smart_nudges moved % row(s), counted %', v_rows, v_count;
    END IF;
  END IF;

  -- Each row: table, column, the pinned production default, the replacement
  -- (NULL = drop the default).
  FOR r IN
    SELECT * FROM (VALUES
      ('smart_nudges', 'channel', '''telegram''::text', '''dashboard''::text'),
      ('conversation_sessions', 'channel', '''telegram''::text', '''dashboard''::text'),
      ('conversation_history', 'channel', '''telegram''::text', '''dashboard''::text'),
      ('pending_confirmations', 'channel', '''telegram_dm''::text', NULL),
      ('commitments', 'source_channel', '''telegram''::text', NULL),
      ('corrections', 'corrected_via', '''telegram''::text', NULL)
    ) AS d(tbl, col, pinned_default, new_default)
  LOOP
    v_def := NULL;
    SELECT pg_get_expr(ad.adbin, ad.adrelid) INTO v_def
    FROM pg_attrdef ad JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
    WHERE ad.adrelid = to_regclass('public.' || r.tbl) AND a.attname = r.col;
    IF v_def IS NULL OR v_def IS NOT DISTINCT FROM r.new_default THEN
      CONTINUE; -- absent here, or already replaced
    END IF;
    IF v_def <> r.pinned_default THEN
      RAISE EXCEPTION 'remove_telegram: %.% default is %, expected %', r.tbl, r.col, v_def, r.pinned_default;
    END IF;
    IF r.new_default IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT', r.tbl, r.col);
    ELSE
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %s', r.tbl, r.col, r.new_default);
    END IF;
  END LOOP;

  -- Each row: table, constraint, production md5(pg_get_constraintdef) with
  -- telegram, and the replacement definition without it.
  FOR r IN
    SELECT * FROM (VALUES
      ('agent_memory_log', 'agent_memory_log_channel_check', 'da2449459d9104b26380b5928ee0efea',
       $c$CHECK ((channel = ANY (ARRAY['web'::text, 'api'::text, 'system'::text, 'cron'::text])))$c$),
      ('authority_levels', 'authority_levels_channel_check', 'da2449459d9104b26380b5928ee0efea',
       $c$CHECK ((channel = ANY (ARRAY['web'::text, 'api'::text, 'system'::text, 'cron'::text])))$c$),
      ('intention_log', 'intention_log_channel_check', 'da2449459d9104b26380b5928ee0efea',
       $c$CHECK ((channel = ANY (ARRAY['web'::text, 'api'::text, 'system'::text, 'cron'::text])))$c$),
      ('communications_log', 'communications_log_channel_check', 'dffd6fa669fe2db79a7af7fdb72f2327',
       $c$CHECK ((channel = ANY (ARRAY['email'::text, 'sms'::text, 'web'::text, 'whatsapp'::text])))$c$),
      ('pending_entity_matches', 'pending_entity_matches_source_channel_check', 'e23672f7c0d4834bae5c048e548776b3',
       $c$CHECK ((source_channel = ANY (ARRAY['email'::text, 'sms'::text, 'web'::text, 'system'::text])))$c$),
      ('entity_observations', 'entity_observations_source_channel_check', '9f540bb62a07f928090b15e4d7719472',
       $c$CHECK ((source_channel = ANY (ARRAY['web'::text, 'api'::text, 'system'::text, 'manual'::text])))$c$),
      ('corrections', 'corrections_corrected_via_check', 'b2c78cccb3837eb42b90f5fe98a842d6',
       $c$CHECK ((corrected_via = ANY (ARRAY['web'::text, 'api'::text, 'system'::text])))$c$),
      ('commitments', 'commitments_source_channel_check', 'feb44cbefce2820f8d60d8c45717aa40',
       $c$CHECK ((source_channel = ANY (ARRAY['web'::text, 'api'::text, 'system'::text])))$c$),
      ('business_events', 'business_events_channel_check', '26e27300bd074bf0969ebb480bb3be04',
       $c$CHECK (((channel = ANY (ARRAY['email'::text, 'sms'::text, 'call'::text, 'note'::text, 'document'::text, 'xero'::text, 'po'::text, 'wo'::text, 'assignment'::text, 'status'::text, 'quote'::text, 'invoice'::text, 'payment'::text, 'scope'::text, 'chat'::text, 'audit'::text, 'system'::text])) OR (channel IS NULL)))$c$)
    ) AS c(tbl, con, pinned_md5, new_def)
  LOOP
    v_md5 := NULL;
    SELECT md5(pg_get_constraintdef(pc.oid)) INTO v_md5
    FROM pg_constraint pc
    WHERE pc.conrelid = to_regclass('public.' || r.tbl) AND pc.conname = r.con AND pc.contype = 'c';
    IF v_md5 IS NULL OR v_md5 = md5(r.new_def) THEN
      CONTINUE; -- absent here, or already without telegram
    END IF;
    IF v_md5 <> r.pinned_md5 THEN
      RAISE EXCEPTION 'remove_telegram: %.% is not the production pre-image (md5 %)', r.tbl, r.con, v_md5;
    END IF;
    -- The replacement validates every row under this statement's lock, so a
    -- telegram value written since the pre-image read refuses here.
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I, ADD CONSTRAINT %I %s',
                   r.tbl, r.con, r.con, r.new_def);
  END LOOP;

  -- 5. v_evidence_health -----------------------------------------------------
  IF to_regclass('public.v_evidence_health') IS NOT NULL THEN
    v_def := pg_get_viewdef('public.v_evidence_health'::regclass);
    IF v_def ILIKE '%telegram%' THEN
      IF md5(v_def) <> 'd5cccec9e949e15d4998587e1f7a223a' THEN
        RAISE EXCEPTION 'remove_telegram: v_evidence_health is not the production pre-image (md5 %)', md5(v_def);
      END IF;
      CREATE OR REPLACE VIEW public.v_evidence_health AS
      SELECT COALESCE(channel, '_legacy_no_channel') AS channel,
             COALESCE(direction, '_legacy_no_direction') AS direction,
             COALESCE(source_table, '_legacy_no_source_table') AS source_table,
             count(*) AS rows_30d,
             count(*) FILTER (WHERE job_id IS NULL) AS missing_job,
             count(*) FILTER (WHERE contact_id IS NULL) AS missing_contact,
             count(*) FILTER (WHERE channel IS NULL OR direction IS NULL
                                 OR source_table IS NULL OR source_id IS NULL) AS missing_envelope,
             count(*) FILTER (WHERE body_preview IS NULL
                                 AND channel = ANY (ARRAY['email', 'sms', 'call', 'note'])) AS comms_missing_preview,
             count(*) FILTER (WHERE body_preview IS NOT NULL
                                 AND char_length(body_preview) >= 500
                                 AND body_pointer IS NULL) AS preview_truncated_no_pointer,
             count(*) FILTER (WHERE match_status = 'matched') AS matched,
             count(*) FILTER (WHERE match_status = 'ambiguous') AS ambiguous,
             count(*) FILTER (WHERE match_status = 'unresolved') AS unresolved,
             count(*) FILTER (WHERE match_status = 'ignored') AS ignored,
             count(*) FILTER (WHERE match_status IS NULL) AS no_match_status,
             max(occurred_at) AS last_event_at,
             min(occurred_at) AS first_event_at
      FROM public.business_events
      WHERE occurred_at > now() - '30 days'::interval
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3;
    END IF;
    -- A read-only diagnostic view: nobody but the owner and service_role writes.
    REVOKE ALL ON public.v_evidence_health FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL ON public.v_evidence_health FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      REVOKE ALL ON public.v_evidence_health FROM authenticated;
      GRANT SELECT ON public.v_evidence_health TO authenticated;
    END IF;
  END IF;

  -- 6. trigger_daily_digest() comment ------------------------------------------
  IF to_regprocedure('public.trigger_daily_digest()') IS NOT NULL
     AND obj_description(to_regprocedure('public.trigger_daily_digest()'), 'pg_proc') ILIKE '%telegram%'
  THEN
    COMMENT ON FUNCTION public.trigger_daily_digest() IS
      'Fire the daily digest. Usage: SELECT trigger_daily_digest();';
  END IF;
END
$$;
