-- Durable idempotency and cross-calendar person reservation. No public callers.
CREATE TABLE public.ghl_calendar_appointment_requests (
  location_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  assigned_user_id text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL CHECK (end_time > start_time),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'sending', 'complete')),
  lease_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, idempotency_key),
  CHECK ((state = 'complete') = (result IS NOT NULL)),
  CHECK (result IS NULL OR (
    jsonb_typeof(result) = 'object' AND
    result ?& ARRAY['appointmentId', 'calendarId', 'startTime', 'endTime'] AND
    length(result->>'appointmentId') > 0
  ))
);
CREATE INDEX ghl_calendar_appointment_person_window
  ON public.ghl_calendar_appointment_requests (location_id, assigned_user_id, start_time, end_time);
ALTER TABLE public.ghl_calendar_appointment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ghl_calendar_appointment_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ghl_calendar_appointment_requests TO service_role;

CREATE FUNCTION public.reserve_ghl_calendar_appointment(
  p_location_id text, p_key text, p_fingerprint text, p_user_id text,
  p_start timestamptz, p_end timestamptz, p_token uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  existing public.ghl_calendar_appointment_requests%ROWTYPE;
BEGIN
  IF nullif(p_location_id, '') IS NULL OR nullif(p_user_id, '') IS NULL
    OR nullif(p_key, '') IS NULL OR p_fingerprint IS NULL OR p_token IS NULL
    OR p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RAISE EXCEPTION 'invalid reservation';
  END IF;
  -- Key lock first, then person lock: same-key payload conflicts and different
  -- calendar requests for one person are serialized in the same transaction.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ghl-appointment-key:' || p_location_id || ':' || p_key, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ghl-appointment-person:' || p_location_id || ':' || p_user_id, 0));
  SELECT * INTO existing FROM public.ghl_calendar_appointment_requests
    WHERE location_id = p_location_id AND idempotency_key = p_key FOR UPDATE;
  IF FOUND THEN
    IF existing.fingerprint <> p_fingerprint OR existing.assigned_user_id <> p_user_id
      OR existing.start_time <> p_start OR existing.end_time <> p_end THEN
      RETURN jsonb_build_object('decision', 'conflict');
    END IF;
    IF existing.state IN ('sending', 'complete') THEN
      RETURN jsonb_build_object('decision', 'existing', 'request',
        jsonb_build_object('fingerprint', existing.fingerprint, 'state', existing.state, 'result', existing.result));
    END IF;
    IF existing.lease_until > clock_timestamp() THEN
      RETURN jsonb_build_object('decision', 'busy');
    END IF;
  END IF;
  IF p_start <= clock_timestamp() THEN RAISE EXCEPTION 'past reservation'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.ghl_calendar_appointment_requests
    WHERE location_id = p_location_id AND assigned_user_id = p_user_id
      AND idempotency_key <> p_key AND start_time < p_end AND end_time > p_start
      AND (state IN ('sending', 'complete') OR lease_until > clock_timestamp())
  ) THEN RETURN jsonb_build_object('decision', 'overlap'); END IF;
  INSERT INTO public.ghl_calendar_appointment_requests
    (location_id, idempotency_key, fingerprint, assigned_user_id, start_time, end_time, lease_token, lease_until)
    VALUES (p_location_id, p_key, p_fingerprint, p_user_id, p_start, p_end, p_token, clock_timestamp() + interval '90 seconds')
  ON CONFLICT (location_id, idempotency_key) DO UPDATE
    SET lease_token = p_token, lease_until = clock_timestamp() + interval '90 seconds';
  RETURN jsonb_build_object('decision', 'acquired');
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_ghl_calendar_appointment(text,text,text,text,timestamptz,timestamptz,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ghl_calendar_appointment(text,text,text,text,timestamptz,timestamptz,uuid) TO service_role;

-- Check expiry using the database clock under the SAME person lock as reserve.
-- A worker whose lease expired cannot post after a new request acquired its slot.
CREATE FUNCTION public.mark_ghl_calendar_appointment_sending(
  p_location_id text, p_key text, p_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE person text;
BEGIN
  SELECT assigned_user_id INTO person FROM public.ghl_calendar_appointment_requests
    WHERE location_id = p_location_id AND idempotency_key = p_key;
  IF person IS NULL THEN RETURN false; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ghl-appointment-person:' || p_location_id || ':' || person, 0));
  UPDATE public.ghl_calendar_appointment_requests SET state = 'sending'
    WHERE location_id = p_location_id AND idempotency_key = p_key
      AND lease_token = p_token AND state = 'reserved'
      AND lease_until > clock_timestamp() AND start_time > clock_timestamp();
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_ghl_calendar_appointment_sending(text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_ghl_calendar_appointment_sending(text,text,uuid) TO service_role;
