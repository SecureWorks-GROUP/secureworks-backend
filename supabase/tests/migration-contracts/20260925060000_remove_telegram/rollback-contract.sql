-- After the down migration: the four columns are back, empty, with their keys
-- and indexes; the CHECKs, defaults and view match the production pre-image
-- fingerprints; data, the function and the revoked grants stay gone.
DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
      AND (table_name, column_name) IN (('users', 'telegram_id'), ('users', 'telegram_username'),
           ('staff_agent_preferences', 'telegram_user_id'), ('inbox_events', 'telegram_notified'))) <> 4 THEN
    RAISE EXCEPTION 'rollback contract: telegram columns not restored';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE telegram_id IS NOT NULL OR telegram_username IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback contract: restored columns are not empty';
  END IF;
  IF to_regclass('public.idx_users_telegram') IS NULL OR to_regclass('public.idx_staff_prefs_telegram') IS NULL
     OR to_regclass('public.users_telegram_id_key') IS NULL
     OR to_regclass('public.staff_agent_preferences_telegram_user_id_key') IS NULL THEN
    RAISE EXCEPTION 'rollback contract: telegram keys or indexes not restored';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'staff_agent_preferences' AND column_name = 'telegram_user_id') <> 'NO' THEN
    RAISE EXCEPTION 'rollback contract: telegram_user_id not NOT NULL on the empty table';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE contype = 'c' AND convalidated
      AND md5(pg_get_constraintdef(oid)) IN ('da2449459d9104b26380b5928ee0efea', 'dffd6fa669fe2db79a7af7fdb72f2327',
          'e23672f7c0d4834bae5c048e548776b3', '9f540bb62a07f928090b15e4d7719472',
          'b2c78cccb3837eb42b90f5fe98a842d6', 'feb44cbefce2820f8d60d8c45717aa40',
          '26e27300bd074bf0969ebb480bb3be04')) <> 9 THEN
    RAISE EXCEPTION 'rollback contract: CHECKs do not match the production pre-image';
  END IF;
  IF md5(pg_get_viewdef('public.v_evidence_health'::regclass)) <> 'd5cccec9e949e15d4998587e1f7a223a' THEN
    RAISE EXCEPTION 'rollback contract: v_evidence_health does not match the production pre-image';
  END IF;
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'commitments' AND column_name = 'source_channel') <> '''telegram''::text' THEN
    RAISE EXCEPTION 'rollback contract: commitments default not restored';
  END IF;
  IF (SELECT column_default FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'pending_confirmations' AND column_name = 'channel') <> '''telegram_dm''::text'
     OR EXISTS (SELECT 1 FROM public.smart_nudges WHERE channel = 'telegram') THEN
    RAISE EXCEPTION 'rollback contract: defaults or smart_nudges rows not as promised';
  END IF;
  IF to_regprocedure('public.deliver_proposed_actions()') IS NOT NULL
     OR has_table_privilege('anon', 'public.v_evidence_health', 'INSERT') THEN
    RAISE EXCEPTION 'rollback contract: the rollback restored a function or grant it must not';
  END IF;
END
$$;
