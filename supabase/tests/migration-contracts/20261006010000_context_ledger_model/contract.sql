-- Contract: 20261006010000_context_ledger_model. The ledger exists, is empty,
-- is service-role read-only, refuses malformed rows, and starts switched off
-- with no rollout list (every live job).
\set ON_ERROR_STOP on
BEGIN;

-- 1. Tables, owner comments (the re-apply guard keys on them), settings off.
DO $c$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.context_ledger_generations','public.context_ledger_items',
                          'public.context_ledger_transitions','public.context_ledger_settings'] LOOP
  IF to_regclass(t) IS NULL THEN RAISE EXCEPTION 'ledger contract: % missing', t; END IF;
  IF obj_description(to_regclass(t), 'pg_class') NOT LIKE 'Context ledger:%' THEN
   RAISE EXCEPTION 'ledger contract: % comment is not the owner marker', t;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass(t)) THEN
   RAISE EXCEPTION 'ledger contract: % has no row level security', t;
  END IF;
  IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('authenticated', t, 'SELECT') THEN
   RAISE EXCEPTION 'ledger contract: % readable by anon or authenticated', t;
  END IF;
  IF NOT has_table_privilege('service_role', t, 'SELECT') THEN
   RAISE EXCEPTION 'ledger contract: % not readable by service_role', t;
  END IF;
  IF has_table_privilege('service_role', t, 'INSERT') OR has_table_privilege('service_role', t, 'UPDATE')
     OR has_table_privilege('service_role', t, 'DELETE') THEN
   RAISE EXCEPTION 'ledger contract: % writable by service_role (writes go through the store)', t;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.context_ledger_settings) <> 1
    OR (SELECT mode FROM public.context_ledger_settings) <> 'off'
    OR (SELECT calls_per_day FROM public.context_ledger_settings) <> 0 THEN
  RAISE EXCEPTION 'ledger contract: settings must be one row, mode off, 0 calls';
 END IF;
END $c$;

-- 2. Shape: one live and one building generation per job; malformed items refused.
INSERT INTO public.jobs (id, org_id, status, type) VALUES ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing') ON CONFLICT DO NOTHING;
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, promoted_at)
VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'backfill', 'live', 'luna-ledger:v1', now());
DO $c$
BEGIN
 BEGIN
  INSERT INTO public.context_ledger_generations (job_id, kind, status, reader, promoted_at)
  VALUES ('00000000-0000-4000-8000-0000000000a1', 'rebuild', 'live', 'luna-ledger:v1', now());
  RAISE EXCEPTION 'ledger contract: a second live generation was accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 BEGIN
  INSERT INTO public.context_ledger_generations (job_id, kind, status, reader)
  VALUES ('00000000-0000-4000-8000-0000000000a1', 'rebuild', 'live', 'luna-ledger:v1');
  RAISE EXCEPTION 'ledger contract: a live generation without promoted_at was accepted';
 EXCEPTION WHEN check_violation OR unique_violation THEN NULL;
 END;
END $c$;

INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, to_role,
  what, about_key, opened_at, opened_by, closes_on, written_by)
VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'commitment:quote:rest:1',
  'commitment', 'open', 'us', 'customer', 'Quote the rest of the fence separately.', 'quote:rest-of-fence', now(),
  '[{"table":"business_events","id":"00000000-0000-4000-8000-0000000000c1","excerpt":"I will quote the rest"}]'::jsonb,
  'quote_sent', 'model:luna-ledger:v1');

DO $c$
DECLARE g uuid := '00000000-0000-4000-8000-0000000000b1'; j uuid := '00000000-0000-4000-8000-0000000000a1';
 cite jsonb := '[{"table":"business_events","id":"00000000-0000-4000-8000-0000000000c1","excerpt":"x"}]';
BEGIN
 -- unknown type
 BEGIN
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by)
  VALUES (g, j, 'k1', 'fact', 'open', 'us', 'x', now(), cite, 'model:r');
  RAISE EXCEPTION 'ledger contract: unknown item_type accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- no citation
 BEGIN
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by)
  VALUES (g, j, 'k2', 'request', 'open', 'customer', 'x', now(), '[]'::jsonb, 'model:r');
  RAISE EXCEPTION 'ledger contract: an uncited item was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- closed without closing evidence or a person
 BEGIN
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, closed_at, written_by)
  VALUES (g, j, 'k3', 'request', 'closed', 'customer', 'x', now(), cite, now(), 'model:r');
  RAISE EXCEPTION 'ledger contract: a model item closed without evidence was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- open with a closed_at
 BEGIN
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, closed_at, written_by)
  VALUES (g, j, 'k4', 'request', 'open', 'customer', 'x', now(), cite, now(), 'model:r');
  RAISE EXCEPTION 'ledger contract: an open item with closed_at was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- a due date nobody stated
 BEGIN
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, due_date, written_by)
  VALUES (g, j, 'k5', 'commitment', 'open', 'us', 'x', now(), cite, current_date, 'model:r');
  RAISE EXCEPTION 'ledger contract: an unstated due date was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- a writer that is neither model, person nor rule
 BEGIN
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by)
  VALUES (g, j, 'k6', 'commitment', 'open', 'us', 'x', now(), cite, 'clock');
  RAISE EXCEPTION 'ledger contract: an unattributed writer was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- duplicate key in one generation
 BEGIN
  INSERT INTO public.context_ledger_items (generation_id, job_id, item_key, item_type, status, from_role, what, opened_at, opened_by, written_by)
  VALUES (g, j, 'commitment:quote:rest:1', 'commitment', 'open', 'us', 'x', now(), cite, 'model:r');
  RAISE EXCEPTION 'ledger contract: a duplicate item_key was accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $c$;

-- 3. Settings refuse an off-scale ceiling.
DO $c$
BEGIN
 BEGIN
  UPDATE public.context_ledger_settings SET calls_per_day = 401;
  RAISE EXCEPTION 'ledger contract: calls_per_day above the 400 cap accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;

-- 4. The ledger's own live reserve: 100 calls all day and 100 before noon by
-- default (the line the ledger kept before), 0 to 400, commented.
DO $c$
DECLARE c text;
BEGIN
 FOREACH c IN ARRAY ARRAY['live_reserve_calls', 'live_reserve_calls_morning'] LOOP
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_settings'
                 AND column_name = c AND data_type = 'integer' AND is_nullable = 'NO' AND column_default = '100') THEN
   RAISE EXCEPTION 'ledger contract: settings.% must be integer NOT NULL DEFAULT 100', c;
  END IF;
  IF coalesce(col_description('public.context_ledger_settings'::regclass,
      (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.context_ledger_settings'::regclass AND a.attname = c)), '')
     NOT LIKE 'Context ledger: calls the ledger always leaves free for live fact reads%' THEN
   RAISE EXCEPTION 'ledger contract: settings.% carries no owner comment', c;
  END IF;
 END LOOP;
 IF (SELECT live_reserve_calls <> 100 OR live_reserve_calls_morning <> 100 FROM public.context_ledger_settings) THEN
  RAISE EXCEPTION 'ledger contract: the seeded reserve must be 100 all day and 100 before noon';
 END IF;
 UPDATE public.context_ledger_settings SET live_reserve_calls = 0, live_reserve_calls_morning = 400;
 UPDATE public.context_ledger_settings SET live_reserve_calls = 400, live_reserve_calls_morning = 0;
 BEGIN
  UPDATE public.context_ledger_settings SET live_reserve_calls = 401;
  RAISE EXCEPTION 'ledger contract: a reserve above 400 was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.context_ledger_settings SET live_reserve_calls_morning = -1;
  RAISE EXCEPTION 'ledger contract: a negative morning reserve was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 UPDATE public.context_ledger_settings SET live_reserve_calls = 100, live_reserve_calls_morning = 100;
END $c$;

-- 5. The rollout list for a staged start: none by default (every live job), at
-- most 500 jobs, never a null entry, one dimension.
DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_settings'
                AND column_name = 'job_ids' AND data_type = 'ARRAY' AND udt_name = '_uuid' AND is_nullable = 'YES'
                AND column_default IS NULL) THEN
  RAISE EXCEPTION 'ledger contract: settings.job_ids must be a nullable uuid[] with no default';
 END IF;
 IF (SELECT job_ids FROM public.context_ledger_settings) IS NOT NULL THEN
  RAISE EXCEPTION 'ledger contract: the rollout list must start unset (NULL = every live job)';
 END IF;
 IF coalesce(col_description('public.context_ledger_settings'::regclass,
     (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.context_ledger_settings'::regclass AND a.attname = 'job_ids')), '')
    NOT LIKE 'Context ledger: the staged rollout list%' THEN
  RAISE EXCEPTION 'ledger contract: settings.job_ids carries no owner comment';
 END IF;
 UPDATE public.context_ledger_settings SET job_ids = ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 500));
 UPDATE public.context_ledger_settings SET job_ids = '{}';
 UPDATE public.context_ledger_settings SET job_ids = NULL;
 BEGIN
  UPDATE public.context_ledger_settings SET job_ids = ARRAY[gen_random_uuid(), NULL];
  RAISE EXCEPTION 'ledger contract: a null entry in the rollout list was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.context_ledger_settings SET job_ids = ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 501));
  RAISE EXCEPTION 'ledger contract: a rollout list over 500 jobs was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.context_ledger_settings SET job_ids = ARRAY[ARRAY[gen_random_uuid()], ARRAY[gen_random_uuid()]];
  RAISE EXCEPTION 'ledger contract: a two-dimensional rollout list was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;

-- 6. The backfill hours: unset by default (any time), Perth hours 0 to 23, both
-- or neither, never the same hour, a window may wrap midnight.
DO $c$
DECLARE c text;
BEGIN
 FOREACH c IN ARRAY ARRAY['backfill_from_hour', 'backfill_to_hour'] LOOP
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'context_ledger_settings'
                 AND column_name = c AND data_type = 'smallint' AND is_nullable = 'YES' AND column_default IS NULL) THEN
   RAISE EXCEPTION 'ledger contract: settings.% must be a nullable smallint with no default', c;
  END IF;
  IF coalesce(col_description('public.context_ledger_settings'::regclass,
      (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.context_ledger_settings'::regclass AND a.attname = c)), '')
     NOT LIKE 'Context ledger: %backfill hours%' THEN
   RAISE EXCEPTION 'ledger contract: settings.% carries no owner comment', c;
  END IF;
 END LOOP;
 IF (SELECT backfill_from_hour IS NOT NULL OR backfill_to_hour IS NOT NULL FROM public.context_ledger_settings) THEN
  RAISE EXCEPTION 'ledger contract: the backfill hours must start unset (any time)';
 END IF;
 UPDATE public.context_ledger_settings SET backfill_from_hour = 22, backfill_to_hour = 6;
 UPDATE public.context_ledger_settings SET backfill_from_hour = 0, backfill_to_hour = 23;
 UPDATE public.context_ledger_settings SET backfill_from_hour = NULL, backfill_to_hour = NULL;
 BEGIN
  UPDATE public.context_ledger_settings SET backfill_from_hour = 22;
  RAISE EXCEPTION 'ledger contract: a backfill window with one end was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.context_ledger_settings SET backfill_from_hour = 5, backfill_to_hour = 5;
  RAISE EXCEPTION 'ledger contract: an empty backfill window was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE public.context_ledger_settings SET backfill_from_hour = 24, backfill_to_hour = 6;
  RAISE EXCEPTION 'ledger contract: a backfill hour of 24 was accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $c$;

ROLLBACK;
