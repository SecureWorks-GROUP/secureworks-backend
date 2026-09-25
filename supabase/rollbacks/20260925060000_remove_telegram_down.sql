-- Down migration for 20260925060000_remove_telegram.
--
-- Restores the schema shape only: the four Telegram columns come back EMPTY
-- (inbox_events.telegram_notified back-fills its old default, false) with their
-- keys and indexes, and 'telegram' is re-admitted in the nine CHECKs, the six
-- column defaults and v_evidence_health. It deliberately restores no data (the
-- 13 authority_levels rows, the send_telegram permission, the smart_nudges rows
-- moved to dashboard), no
-- deliver_proposed_actions() (its only target, the telegram-bot function, no
-- longer exists) and none of the revoked write grants on v_evidence_health.
-- Each step is skipped when its table is absent.

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS telegram_id bigint,
      ADD COLUMN IF NOT EXISTS telegram_username text;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_telegram_id_key'
                   AND conrelid = 'public.users'::regclass) THEN
      ALTER TABLE public.users ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);
    END IF;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram ON public.users (telegram_id)
      WHERE telegram_id IS NOT NULL;
  END IF;

  IF to_regclass('public.staff_agent_preferences') IS NOT NULL THEN
    -- Production held it NOT NULL on an empty table; NOT NULL is restored only
    -- while the table is still empty, so the rollback cannot fail on new rows.
    ALTER TABLE public.staff_agent_preferences ADD COLUMN IF NOT EXISTS telegram_user_id bigint;
    IF NOT EXISTS (SELECT 1 FROM public.staff_agent_preferences) THEN
      ALTER TABLE public.staff_agent_preferences ALTER COLUMN telegram_user_id SET NOT NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_agent_preferences_telegram_user_id_key'
                   AND conrelid = 'public.staff_agent_preferences'::regclass) THEN
      ALTER TABLE public.staff_agent_preferences
        ADD CONSTRAINT staff_agent_preferences_telegram_user_id_key UNIQUE (telegram_user_id);
    END IF;
    CREATE INDEX IF NOT EXISTS idx_staff_prefs_telegram ON public.staff_agent_preferences (telegram_user_id);
  END IF;

  IF to_regclass('public.inbox_events') IS NOT NULL THEN
    ALTER TABLE public.inbox_events ADD COLUMN IF NOT EXISTS telegram_notified boolean DEFAULT false;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('agent_memory_log', 'agent_memory_log_channel_check',
       $c$CHECK ((channel = ANY (ARRAY['telegram'::text, 'web'::text, 'api'::text, 'system'::text, 'cron'::text])))$c$),
      ('authority_levels', 'authority_levels_channel_check',
       $c$CHECK ((channel = ANY (ARRAY['telegram'::text, 'web'::text, 'api'::text, 'system'::text, 'cron'::text])))$c$),
      ('intention_log', 'intention_log_channel_check',
       $c$CHECK ((channel = ANY (ARRAY['telegram'::text, 'web'::text, 'api'::text, 'system'::text, 'cron'::text])))$c$),
      ('communications_log', 'communications_log_channel_check',
       $c$CHECK ((channel = ANY (ARRAY['telegram'::text, 'email'::text, 'sms'::text, 'web'::text, 'whatsapp'::text])))$c$),
      ('pending_entity_matches', 'pending_entity_matches_source_channel_check',
       $c$CHECK ((source_channel = ANY (ARRAY['telegram'::text, 'email'::text, 'sms'::text, 'web'::text, 'system'::text])))$c$),
      ('entity_observations', 'entity_observations_source_channel_check',
       $c$CHECK ((source_channel = ANY (ARRAY['telegram'::text, 'web'::text, 'api'::text, 'system'::text, 'manual'::text])))$c$),
      ('corrections', 'corrections_corrected_via_check',
       $c$CHECK ((corrected_via = ANY (ARRAY['telegram'::text, 'web'::text, 'api'::text, 'system'::text])))$c$),
      ('commitments', 'commitments_source_channel_check',
       $c$CHECK ((source_channel = ANY (ARRAY['telegram'::text, 'web'::text, 'api'::text, 'system'::text])))$c$),
      ('business_events', 'business_events_channel_check',
       $c$CHECK (((channel = ANY (ARRAY['email'::text, 'sms'::text, 'call'::text, 'telegram'::text, 'note'::text, 'document'::text, 'xero'::text, 'po'::text, 'wo'::text, 'assignment'::text, 'status'::text, 'quote'::text, 'invoice'::text, 'payment'::text, 'scope'::text, 'chat'::text, 'audit'::text, 'system'::text])) OR (channel IS NULL)))$c$)
    ) AS c(tbl, con, old_def)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I, ADD CONSTRAINT %I %s',
                     r.tbl, r.con, r.con, r.old_def);
    END IF;
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      ('smart_nudges', 'channel', 'telegram'), ('conversation_sessions', 'channel', 'telegram'),
      ('conversation_history', 'channel', 'telegram'), ('pending_confirmations', 'channel', 'telegram_dm'),
      ('commitments', 'source_channel', 'telegram'), ('corrections', 'corrected_via', 'telegram')
    ) AS d(tbl, col, old_default)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %L', r.tbl, r.col, r.old_default);
    END IF;
  END LOOP;

  IF to_regclass('public.v_evidence_health') IS NOT NULL THEN
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
                               AND channel = ANY (ARRAY['email', 'sms', 'call', 'telegram', 'note'])) AS comms_missing_preview,
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
END
$$;
