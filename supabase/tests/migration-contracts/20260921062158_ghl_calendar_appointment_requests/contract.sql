BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb; t uuid := '11111111-1111-4111-8111-111111111111';
  t2 uuid := '22222222-2222-4222-8222-222222222222';
  s timestamptz := now() + interval '1 day'; e timestamptz := now() + interval '1 day 1 hour';
BEGIN
  r := public.reserve_ghl_calendar_appointment('loc-contract','key1',repeat('a',64),'person',s,e,t);
  IF r->>'decision' <> 'acquired' THEN RAISE EXCEPTION 'first reservation not acquired: %', r; END IF;
  r := public.reserve_ghl_calendar_appointment('loc-contract','key1',repeat('a',64),'person',s,e,t2);
  IF r->>'decision' <> 'busy' THEN RAISE EXCEPTION 'concurrent key not fenced'; END IF;
  r := public.reserve_ghl_calendar_appointment('loc-contract','key1',repeat('b',64),'person',s,e,t);
  IF r->>'decision' <> 'conflict' THEN RAISE EXCEPTION 'payload reuse accepted'; END IF;
  r := public.reserve_ghl_calendar_appointment('loc-contract','key2',repeat('b',64),'person',s,e,t);
  IF r->>'decision' <> 'overlap' THEN RAISE EXCEPTION 'person overlap accepted'; END IF;
  r := public.reserve_ghl_calendar_appointment('loc-contract','adjacent',repeat('b',64),'person',e,e+interval '1 hour',t);
  IF r->>'decision' <> 'acquired' THEN RAISE EXCEPTION 'adjacent blocked'; END IF;
  IF public.mark_ghl_calendar_appointment_sending('loc-contract','key1',t2) THEN RAISE EXCEPTION 'stale token sent'; END IF;
  RESET ROLE;
  UPDATE public.ghl_calendar_appointment_requests SET lease_until = now() - interval '1 second'
    WHERE location_id = 'loc-contract' AND idempotency_key = 'key1';
  SET LOCAL ROLE service_role;
  IF public.mark_ghl_calendar_appointment_sending('loc-contract','key1',t) THEN RAISE EXCEPTION 'expired token sent'; END IF;
  r := public.reserve_ghl_calendar_appointment('loc-contract','key1',repeat('a',64),'person',s,e,t2);
  IF r->>'decision' <> 'acquired' THEN RAISE EXCEPTION 'expired pre-send reservation did not resume'; END IF;
  IF public.mark_ghl_calendar_appointment_sending('loc-contract','key1',t) THEN RAISE EXCEPTION 'replaced token sent'; END IF;
  IF NOT public.mark_ghl_calendar_appointment_sending('loc-contract','key1',t2) THEN RAISE EXCEPTION 'current token did not send'; END IF;
  IF public.mark_ghl_calendar_appointment_sending('loc-contract','key1',t2) THEN RAISE EXCEPTION 'token sent twice'; END IF;
  RESET ROLE;
  UPDATE public.ghl_calendar_appointment_requests SET lease_until = now() - interval '1 day'
    WHERE location_id = 'loc-contract' AND idempotency_key = 'key1';
  SET LOCAL ROLE service_role;
  r := public.reserve_ghl_calendar_appointment('loc-contract','key1',repeat('a',64),'person',s,e,t2);
  IF r->>'decision' <> 'existing' OR r->'request'->>'state' <> 'sending' THEN RAISE EXCEPTION 'uncertain send reacquired'; END IF;
  r := public.reserve_ghl_calendar_appointment('loc-contract','key2',repeat('b',64),'person',s,e,t);
  IF r->>'decision' <> 'overlap' THEN RAISE EXCEPTION 'expired sending fence disappeared'; END IF;
  RESET ROLE;
  UPDATE public.ghl_calendar_appointment_requests SET state = 'complete', result = jsonb_build_object(
    'appointmentId','appt1','calendarId','cal1','startTime',s,'endTime',e)
    WHERE location_id = 'loc-contract' AND idempotency_key = 'key1';
  SET LOCAL ROLE service_role;
  r := public.reserve_ghl_calendar_appointment('loc-contract','key1',repeat('a',64),'person',s,e,t);
  IF r->'request'->'result'->>'appointmentId' <> 'appt1' THEN RAISE EXCEPTION 'retry lost appointment'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM * FROM public.ghl_calendar_appointment_requests;
    RAISE EXCEPTION 'authenticated read allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.reserve_ghl_calendar_appointment('x','y',repeat('a',64),'z',now(),now()+interval '1 day',gen_random_uuid());
    RAISE EXCEPTION 'authenticated reserve allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.mark_ghl_calendar_appointment_sending('x','y',gen_random_uuid());
    RAISE EXCEPTION 'authenticated send allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
ROLLBACK;
