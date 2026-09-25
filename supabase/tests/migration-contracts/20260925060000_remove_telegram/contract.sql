-- 20260925060000_remove_telegram: no Telegram column, function, row, allowed
-- channel value, default, view term or comment survives, and nothing else moved.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
             WHERE attname ILIKE '%telegram%' AND NOT attisdropped AND attnum > 0
               AND attrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)) THEN
    RAISE EXCEPTION 'contract: a telegram column survives';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname ILIKE '%telegram%') THEN
    RAISE EXCEPTION 'contract: a telegram index or relation survives';
  END IF;
  IF to_regprocedure('public.deliver_proposed_actions()') IS NOT NULL THEN
    RAISE EXCEPTION 'contract: deliver_proposed_actions() survives';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
             AND (prosrc ILIKE '%telegram%' OR obj_description(oid, 'pg_proc') ILIKE '%telegram%')) THEN
    RAISE EXCEPTION 'contract: a function body or comment still mentions telegram';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE pg_get_constraintdef(oid) ILIKE '%telegram%') THEN
    RAISE EXCEPTION 'contract: a constraint still admits telegram';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE contype = 'c' AND convalidated
        AND conname IN ('agent_memory_log_channel_check', 'authority_levels_channel_check',
                        'intention_log_channel_check', 'communications_log_channel_check',
                        'pending_entity_matches_source_channel_check', 'entity_observations_source_channel_check',
                        'corrections_corrected_via_check', 'commitments_source_channel_check',
                        'business_events_channel_check')) <> 9 THEN
    RAISE EXCEPTION 'contract: the nine channel CHECKs are not all present and validated';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND column_default ILIKE '%telegram%') THEN
    RAISE EXCEPTION 'contract: a telegram default survives';
  END IF;
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_memory_log' AND column_name = 'channel')
     IS DISTINCT FROM '''system''::text' THEN
    RAISE EXCEPTION 'contract: a non-telegram default was changed';
  END IF;
  IF pg_get_viewdef('public.v_evidence_health'::regclass) ILIKE '%telegram%' THEN
    RAISE EXCEPTION 'contract: v_evidence_health still mentions telegram';
  END IF;
  IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
      WHERE attrelid = 'public.v_evidence_health'::regclass AND attnum > 0)
     <> 'channel,direction,source_table,rows_30d,missing_job,missing_contact,missing_envelope,comms_missing_preview,preview_truncated_no_pointer,matched,ambiguous,unresolved,ignored,no_match_status,last_event_at,first_event_at' THEN
    RAISE EXCEPTION 'contract: v_evidence_health columns changed';
  END IF;
  IF has_table_privilege('anon', 'public.v_evidence_health', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,SELECT')
     OR has_table_privilege('authenticated', 'public.v_evidence_health', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.v_evidence_health', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_evidence_health', 'INSERT') THEN
    RAISE EXCEPTION 'contract: v_evidence_health grants are not read-only for anon/authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM public.authority_levels WHERE channel = 'telegram')
     OR (SELECT count(*) FROM public.authority_levels) <> 34 THEN
    RAISE EXCEPTION 'contract: authority_levels lost the wrong rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public.action_permissions WHERE action_type ILIKE '%telegram%')
     OR NOT EXISTS (SELECT 1 FROM public.action_permissions WHERE action_type = 'add_ghl_note') THEN
    RAISE EXCEPTION 'contract: action_permissions lost the wrong rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public.smart_nudges WHERE channel IS DISTINCT FROM 'dashboard')
     OR (SELECT count(*) FROM public.smart_nudges) <> 5 THEN
    RAISE EXCEPTION 'contract: smart_nudges rows not moved to dashboard';
  END IF;
  IF (SELECT string_agg(table_name || '.' || column_name || '=' || coalesce(column_default, '<none>'), ',' ORDER BY table_name)
      FROM information_schema.columns WHERE table_schema = 'public'
        AND (table_name, column_name) IN (('smart_nudges', 'channel'), ('conversation_sessions', 'channel'),
             ('conversation_history', 'channel'), ('pending_confirmations', 'channel'),
             ('commitments', 'source_channel'), ('corrections', 'corrected_via')))
     <> 'commitments.source_channel=<none>,conversation_history.channel=''dashboard''::text,conversation_sessions.channel=''dashboard''::text,corrections.corrected_via=<none>,pending_confirmations.channel=<none>,smart_nudges.channel=''dashboard''::text' THEN
    RAISE EXCEPTION 'contract: replacement defaults are not as chosen';
  END IF;
  -- The surviving columns of the touched tables are intact.
  IF to_regclass('public.users') IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_attribute WHERE attrelid = 'public.inbox_events'::regclass AND attname = 'graph_message_id')
     OR NOT EXISTS (
       SELECT 1 FROM pg_attribute WHERE attrelid = 'public.staff_agent_preferences'::regclass AND attname = 'display_name') THEN
    RAISE EXCEPTION 'contract: a surviving column went missing';
  END IF;
END
$$;

-- The tightened CHECKs refuse telegram and still admit the remaining channels.
BEGIN;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.authority_levels (action, channel) VALUES ('probe', 'telegram');
    RAISE EXCEPTION 'contract: authority_levels accepted telegram';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.commitments (source_channel) VALUES ('telegram');
    RAISE EXCEPTION 'contract: commitments accepted telegram';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.commitments DEFAULT VALUES;
    RAISE EXCEPTION 'contract: commitments still has a source_channel default';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
END
$$;
INSERT INTO public.authority_levels (action, channel) VALUES ('probe', 'web');
INSERT INTO public.communications_log (channel) VALUES ('whatsapp');
INSERT INTO public.corrections (corrected_via) VALUES ('system');
INSERT INTO public.smart_nudges (title) VALUES ('new nudge');
INSERT INTO public.conversation_history (user_id) VALUES ('probe');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.smart_nudges WHERE channel IS DISTINCT FROM 'dashboard')
     OR EXISTS (SELECT 1 FROM public.conversation_history WHERE channel <> 'dashboard') THEN
    RAISE EXCEPTION 'contract: a new row did not take the dashboard default';
  END IF;
END
$$;
ROLLBACK;

-- Re-apply is a no-op.
\ir ../../../migrations/20260925060000_remove_telegram.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.authority_levels) <> 34 THEN
    RAISE EXCEPTION 'contract: re-apply changed authority_levels';
  END IF;
  IF (SELECT count(*) FROM public.smart_nudges WHERE channel = 'dashboard') <> 5 THEN
    RAISE EXCEPTION 'contract: re-apply changed smart_nudges';
  END IF;
END
$$;
