-- Contract: 20261006010000_context_ledger_model. The ledger exists, is empty,
-- is service-role read-only, refuses malformed rows, and starts switched off.
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

ROLLBACK;
