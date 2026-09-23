-- Stuck-sending release: only an old sending row, only by service role, with a
-- reason; it frees the person's window, stays terminal, and is never deleted.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb; t uuid := '33333333-3333-4333-8333-333333333333';
  t2 uuid := '44444444-4444-4444-8444-444444444444';
  s timestamptz := now() + interval '2 days'; e timestamptz := now() + interval '2 days 1 hour';
  row_count int;
BEGIN
  r := public.reserve_ghl_calendar_appointment('loc-release','stuck',repeat('c',64),'person-r',s,e,t);
  IF r->>'decision' <> 'acquired' THEN RAISE EXCEPTION 'setup reservation not acquired: %', r; END IF;

  r := public.release_ghl_calendar_appointment_sending('loc-release','stuck','Checked GHL: nothing booked.','captain@example.com');
  IF r->>'decision' <> 'not_sending' OR r->>'state' <> 'reserved' THEN RAISE EXCEPTION 'reserved row released: %', r; END IF;

  IF NOT public.mark_ghl_calendar_appointment_sending('loc-release','stuck',t) THEN RAISE EXCEPTION 'setup send failed'; END IF;
  r := public.release_ghl_calendar_appointment_sending('loc-release','stuck','Checked GHL: nothing booked.','captain@example.com');
  IF r->>'decision' <> 'too_recent' THEN RAISE EXCEPTION 'in-flight send released: %', r; END IF;

  BEGIN
    PERFORM public.release_ghl_calendar_appointment_sending('loc-release','stuck','short','captain@example.com');
    RAISE EXCEPTION 'short reason accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'invalid release' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.release_ghl_calendar_appointment_sending('loc-release','stuck','Checked GHL: nothing booked.','  ');
    RAISE EXCEPTION 'blank actor accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'invalid release' THEN RAISE; END IF;
  END;

  -- The stuck fence still blocks another key for this person.
  r := public.reserve_ghl_calendar_appointment('loc-release','next',repeat('d',64),'person-r',s,e,t2);
  IF r->>'decision' <> 'overlap' THEN RAISE EXCEPTION 'sending fence did not block: %', r; END IF;

  RESET ROLE;
  UPDATE public.ghl_calendar_appointment_requests SET lease_until = now() - interval '11 minutes'
    WHERE location_id = 'loc-release' AND idempotency_key = 'stuck';
  SET LOCAL ROLE service_role;

  r := public.release_ghl_calendar_appointment_sending('loc-release','missing','Checked GHL: nothing booked.','captain@example.com');
  IF r->>'decision' <> 'not_found' THEN RAISE EXCEPTION 'missing row not reported: %', r; END IF;

  r := public.release_ghl_calendar_appointment_sending('loc-release','stuck','  Checked GHL: nothing booked.  ','captain@example.com');
  IF r->>'decision' <> 'released' OR r->>'released_by' <> 'captain@example.com'
     OR r->>'release_reason' <> 'Checked GHL: nothing booked.' OR r->>'released_at' IS NULL THEN
    RAISE EXCEPTION 'stuck row not released: %', r;
  END IF;
  r := public.release_ghl_calendar_appointment_sending('loc-release','stuck','A second, different reason.','someone@example.com');
  IF r->>'decision' <> 'already_released' OR r->>'released_by' <> 'captain@example.com' THEN
    RAISE EXCEPTION 'release not idempotent: %', r;
  END IF;

  -- The released key is terminal: it can never send or complete again.
  r := public.reserve_ghl_calendar_appointment('loc-release','stuck',repeat('c',64),'person-r',s,e,t2);
  IF public.mark_ghl_calendar_appointment_sending('loc-release','stuck',t2) THEN RAISE EXCEPTION 'released key sent again'; END IF;
  -- (That reserve re-leased the dead key for 90 seconds; the writer refuses a
  -- released key before reserving, so only this direct call can do it.)
  RESET ROLE;
  UPDATE public.ghl_calendar_appointment_requests SET lease_until = 'epoch'
    WHERE location_id = 'loc-release' AND idempotency_key = 'stuck';
  SELECT count(*) INTO row_count FROM public.ghl_calendar_appointment_requests
    WHERE location_id = 'loc-release' AND idempotency_key = 'stuck' AND state = 'released';
  IF row_count <> 1 THEN RAISE EXCEPTION 'released row missing'; END IF;
  SET LOCAL ROLE service_role;

  -- The person's window is free for a new key.
  r := public.reserve_ghl_calendar_appointment('loc-release','next',repeat('d',64),'person-r',s,e,t2);
  IF r->>'decision' <> 'acquired' THEN RAISE EXCEPTION 'released fence still blocks: %', r; END IF;

  -- A complete row is never released.
  IF NOT public.mark_ghl_calendar_appointment_sending('loc-release','next',t2) THEN RAISE EXCEPTION 'next send failed'; END IF;
  RESET ROLE;
  UPDATE public.ghl_calendar_appointment_requests SET state = 'complete', lease_until = now() - interval '1 day',
    result = jsonb_build_object('appointmentId','appt-r','calendarId','cal-r','startTime',s,'endTime',e)
    WHERE location_id = 'loc-release' AND idempotency_key = 'next';
  -- A released row must carry who, when and why; a bare state flip is refused.
  BEGIN
    UPDATE public.ghl_calendar_appointment_requests SET state = 'released', result = NULL
      WHERE location_id = 'loc-release' AND idempotency_key = 'next';
    RAISE EXCEPTION 'unrecorded release accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SET LOCAL ROLE service_role;
  r := public.release_ghl_calendar_appointment_sending('loc-release','next','Checked GHL: nothing booked.','captain@example.com');
  IF r->>'decision' <> 'not_sending' OR r->>'state' <> 'complete' THEN RAISE EXCEPTION 'complete row released: %', r; END IF;

  -- Never deleted.
  BEGIN
    DELETE FROM public.ghl_calendar_appointment_requests WHERE location_id = 'loc-release';
    RAISE EXCEPTION 'service role delete allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM public.release_ghl_calendar_appointment_sending('loc-release','stuck','Checked GHL: nothing booked.','x');
    RAISE EXCEPTION 'authenticated release allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN
    PERFORM public.release_ghl_calendar_appointment_sending('loc-release','stuck','Checked GHL: nothing booked.','x');
    RAISE EXCEPTION 'anon release allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;
