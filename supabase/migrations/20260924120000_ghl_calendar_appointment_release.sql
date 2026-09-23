-- Release for a GHL appointment ledger row stuck in `sending` (booking review
-- 23 Sep 2026, gap 15). A provider error after the writer marked a row
-- `sending` left it `sending` forever, and a `sending` row blocks that person's
-- window for every other key. This adds a terminal `released` state, the
-- columns that record who released it and why, and one service-role function
-- that moves an old `sending` row to `released`. Nothing is ever deleted and
-- no other state changes. ghl-proxy `release_calendar_appointment_request`
-- (captain JWT or service role) is the only caller.
-- Contract: docs/ghl-calendar-appointment-write.md.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Pre-image guard: the table must be exactly the 20260921062158 shape, or
-- exactly this migration's result (re-run). Anything else refuses.
DO $$
DECLARE
  col record;
  state_def text;
  added int;
  base constant jsonb := jsonb_build_object(
    'location_id', jsonb_build_object('data_type','text','is_nullable','NO'),
    'idempotency_key', jsonb_build_object('data_type','text','is_nullable','NO'),
    'fingerprint', jsonb_build_object('data_type','text','is_nullable','NO'),
    'assigned_user_id', jsonb_build_object('data_type','text','is_nullable','NO'),
    'start_time', jsonb_build_object('data_type','timestamp with time zone','is_nullable','NO'),
    'end_time', jsonb_build_object('data_type','timestamp with time zone','is_nullable','NO'),
    'state', jsonb_build_object('data_type','text','is_nullable','NO'),
    'lease_token', jsonb_build_object('data_type','uuid','is_nullable','NO'),
    'lease_until', jsonb_build_object('data_type','timestamp with time zone','is_nullable','NO'),
    'result', jsonb_build_object('data_type','jsonb','is_nullable','YES'),
    'created_at', jsonb_build_object('data_type','timestamp with time zone','is_nullable','NO')
  );
  release_cols constant jsonb := jsonb_build_object(
    'released_at', jsonb_build_object('data_type','timestamp with time zone','is_nullable','YES'),
    'released_by', jsonb_build_object('data_type','text','is_nullable','YES'),
    'release_reason', jsonb_build_object('data_type','text','is_nullable','YES')
  );
  expected jsonb := base || release_cols;
BEGIN
  IF to_regclass('public.ghl_calendar_appointment_requests') IS NULL THEN
    RAISE EXCEPTION 'ghl_calendar_appointment_release: public.ghl_calendar_appointment_requests is missing';
  END IF;
  FOR col IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ghl_calendar_appointment_requests'
  LOOP
    IF NOT expected ? col.column_name THEN
      RAISE EXCEPTION 'ghl_calendar_appointment_release: unexpected column %', col.column_name;
    END IF;
    IF expected->col.column_name->>'data_type' IS DISTINCT FROM col.data_type
       OR expected->col.column_name->>'is_nullable' IS DISTINCT FROM col.is_nullable THEN
      RAISE EXCEPTION 'ghl_calendar_appointment_release: column % type drift', col.column_name;
    END IF;
  END LOOP;
  FOR col IN SELECT jsonb_object_keys(base) AS column_name
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ghl_calendar_appointment_requests'
        AND column_name = col.column_name
    ) THEN
      RAISE EXCEPTION 'ghl_calendar_appointment_release: missing column %', col.column_name;
    END IF;
  END LOOP;
  SELECT count(*) INTO added
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'ghl_calendar_appointment_requests'
    AND column_name IN ('released_at', 'released_by', 'release_reason');
  IF added NOT IN (0, 3) THEN
    RAISE EXCEPTION 'ghl_calendar_appointment_release: release columns partially present';
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO state_def
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.ghl_calendar_appointment_requests'::regclass
    AND c.conname = 'ghl_calendar_appointment_requests_state_check';
  IF state_def IS DISTINCT FROM
       'CHECK ((state = ANY (ARRAY[''reserved''::text, ''sending''::text, ''complete''::text])))'
     AND state_def IS DISTINCT FROM
       'CHECK ((state = ANY (ARRAY[''reserved''::text, ''sending''::text, ''complete''::text, ''released''::text])))'
  THEN
    RAISE EXCEPTION 'ghl_calendar_appointment_release: state check drift: %', state_def;
  END IF;
  IF to_regprocedure('public.reserve_ghl_calendar_appointment(text,text,text,text,timestamptz,timestamptz,uuid)') IS NULL
     OR to_regprocedure('public.mark_ghl_calendar_appointment_sending(text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'ghl_calendar_appointment_release: writer functions are missing';
  END IF;
END $$;

ALTER TABLE public.ghl_calendar_appointment_requests
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_by text,
  ADD COLUMN IF NOT EXISTS release_reason text;

ALTER TABLE public.ghl_calendar_appointment_requests
  DROP CONSTRAINT IF EXISTS ghl_calendar_appointment_requests_state_check,
  ADD CONSTRAINT ghl_calendar_appointment_requests_state_check
    CHECK (state IN ('reserved', 'sending', 'complete', 'released')),
  DROP CONSTRAINT IF EXISTS ghl_calendar_appointment_requests_release_check,
  ADD CONSTRAINT ghl_calendar_appointment_requests_release_check CHECK (
    (state = 'released') = (
      released_at IS NOT NULL AND
      released_by IS NOT NULL AND length(btrim(released_by)) > 0 AND
      release_reason IS NOT NULL AND length(btrim(release_reason)) BETWEEN 10 AND 500
    )
  );

-- Reserve's overlap test already ignores a row that is neither sending,
-- complete nor inside a live lease, so a released row (lease set to epoch)
-- frees the person's window without touching the reserve function. The
-- released key itself stays terminal: mark-sending needs state reserved and
-- complete needs state sending, so it can never post or complete again.
CREATE OR REPLACE FUNCTION public.release_ghl_calendar_appointment_sending(
  p_location_id text, p_key text, p_reason text, p_released_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  person text;
  existing public.ghl_calendar_appointment_requests%ROWTYPE;
  reason text := btrim(coalesce(p_reason, ''));
  actor text := btrim(coalesce(p_released_by, ''));
BEGIN
  IF nullif(p_location_id, '') IS NULL OR nullif(p_key, '') IS NULL
    OR actor = '' OR length(reason) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'invalid release';
  END IF;
  -- Same lock order as reserve: key, then person.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ghl-appointment-key:' || p_location_id || ':' || p_key, 0));
  SELECT assigned_user_id INTO person FROM public.ghl_calendar_appointment_requests
    WHERE location_id = p_location_id AND idempotency_key = p_key;
  IF person IS NULL THEN RETURN jsonb_build_object('decision', 'not_found'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ghl-appointment-person:' || p_location_id || ':' || person, 0));
  SELECT * INTO existing FROM public.ghl_calendar_appointment_requests
    WHERE location_id = p_location_id AND idempotency_key = p_key FOR UPDATE;
  IF existing.state = 'released' THEN
    RETURN jsonb_build_object('decision', 'already_released',
      'released_at', existing.released_at, 'released_by', existing.released_by,
      'release_reason', existing.release_reason);
  END IF;
  IF existing.state <> 'sending' THEN
    RETURN jsonb_build_object('decision', 'not_sending', 'state', existing.state);
  END IF;
  -- The post can only have started before the lease ran out. Ten minutes past
  -- that, no edge worker is still waiting on GHL, so the row is stuck, not busy.
  IF existing.lease_until > clock_timestamp() - interval '10 minutes' THEN
    RETURN jsonb_build_object('decision', 'too_recent', 'lease_until', existing.lease_until);
  END IF;
  UPDATE public.ghl_calendar_appointment_requests
    SET state = 'released', lease_until = 'epoch', released_at = clock_timestamp(),
        released_by = actor, release_reason = reason
    WHERE location_id = p_location_id AND idempotency_key = p_key AND state = 'sending'
    RETURNING * INTO existing;
  RETURN jsonb_build_object('decision', 'released',
    'released_at', existing.released_at, 'released_by', existing.released_by,
    'release_reason', existing.release_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.release_ghl_calendar_appointment_sending(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_ghl_calendar_appointment_sending(text,text,text,text) TO service_role;
