-- Contract for 20261021160000_context_recon_dispute (CTX-18). The marker is a clearable row on a
-- captured message. It shows on the job view and on health, and it does not move the queue, the
-- evidence hash, placement or a decision. Every fixture write is rolled back.
\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_recon_disputes'::regclass) THEN
    RAISE EXCEPTION 'recon dispute contract: RLS is not on';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.context_recon_disputes'::regclass) THEN
    RAISE EXCEPTION 'recon dispute contract: a policy is present';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'context_recon_disputes'
               AND column_name IN ('reason', 'disputed_by', 'disputed_at') AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'recon dispute contract: a marker column is not nullable';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_table_privilege('authenticated', 'public.context_recon_disputes', 'SELECT')
          OR has_table_privilege('anon', 'public.context_recon_disputes', 'SELECT')
          OR has_table_privilege('authenticated', 'public.context_recon_disputes', 'INSERT')
          OR has_table_privilege('authenticated', 'public.context_recon_disputes', 'UPDATE')
          OR has_table_privilege('authenticated', 'public.context_recon_disputes', 'DELETE')
          OR has_function_privilege('authenticated', 'public.context_recon_set_dispute(uuid,uuid,text)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_recon_dispute(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'recon dispute contract: a browser role holds a grant';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND (NOT has_table_privilege('service_role', 'public.context_recon_disputes', 'SELECT')
          OR has_table_privilege('service_role', 'public.context_recon_disputes', 'INSERT')
          OR has_table_privilege('service_role', 'public.context_recon_disputes', 'UPDATE')
          OR has_table_privilege('service_role', 'public.context_recon_disputes', 'DELETE')
          OR NOT has_function_privilege('service_role', 'public.context_recon_set_dispute(uuid,uuid,text)', 'EXECUTE')
          OR NOT has_function_privilege('service_role', 'public.context_recon_dispute(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'recon dispute contract: service role grant is wrong';
  END IF;
  IF pg_get_function_result('public.context_recon_queue(timestamptz)'::regprocedure) ILIKE '%dispute%' THEN
    RAISE EXCEPTION 'recon dispute contract: queue return type carries a dispute column';
  END IF;
  IF position('dispute' IN pg_get_functiondef('public.context_recon_evidence_keys()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'recon dispute contract: evidence keys mention a dispute';
  END IF;
  IF position('candidate_job_ids @> ARRAY[p_job]' IN pg_get_functiondef('public.context_job_view(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'recon dispute contract: job view lost the candidate containment';
  END IF;
END $$;

BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, ghl_contact_id, created_at) VALUES
  ('7d000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'SWF-97101', 'recon-dispute-1', '2026-09-01'),
  ('7d000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-97102', 'recon-dispute-1', '2026-09-01');
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('7d100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Dispute staff', 'ops_manager'),
  ('7d100000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Dispute trade', 'lead_installer');
INSERT INTO public.business_events (id, channel, direction, occurred_at, contact_id, payload, event_type, source)
VALUES ('7d200000-0000-0000-0000-000000000001', 'sms', 'inbound', '2026-10-18 01:00Z', 'recon-dispute-1',
        '{"body":"Which job is this?"}', 'sms.inbound', 'recon-dispute-contract');
UPDATE public.business_events SET job_id = NULL, attribution_status = 'unplaced',
  candidate_job_ids = ARRAY['7d000000-0000-0000-0000-00000000000a', '7d000000-0000-0000-0000-00000000000b']::uuid[]
WHERE id = '7d200000-0000-0000-0000-000000000001';

DO $$
DECLARE ev uuid := '7d200000-0000-0000-0000-000000000001';
  a uuid := '7d000000-0000-0000-0000-00000000000a';
  staff uuid := '7d100000-0000-0000-0000-000000000001';
  h text; open_before bigint; held_before bigint; v_job uuid; v_status text;
  shown text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_queue('2026-10-20 05:00Z') WHERE event_id = ev) THEN
    RAISE EXCEPTION 'recon dispute contract: fixture row is not queued';
  END IF;
  h := public.context_recon_evidence_hash(ev);
  open_before := (public.context_recon_health('2026-01-01') ->> 'disputed_open')::bigint;
  held_before := (public.context_recon_health('2026-01-01') ->> 'held_total')::bigint;
  SELECT job_id, attribution_status INTO v_job, v_status FROM public.business_events WHERE id = ev;

  BEGIN PERFORM public.context_recon_set_dispute(ev, '7d100000-0000-0000-0000-000000000002', 'no');
    RAISE EXCEPTION 'recon dispute contract: trade recorded a marker';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.context_recon_set_dispute(ev, NULL, 'no');
    RAISE EXCEPTION 'recon dispute contract: no person recorded a marker';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.context_recon_set_dispute('7d200000-0000-0000-0000-000000000099', staff, 'no');
    RAISE EXCEPTION 'recon dispute contract: unknown message accepted';
  EXCEPTION WHEN no_data_found THEN NULL; END;

  PERFORM public.context_recon_set_dispute(ev, staff, 'the ladder put this on the wrong job');
  SELECT m ->> 'dispute_reason' INTO shown
  FROM jsonb_array_elements(public.context_job_view(a) -> 'messages') m
  WHERE m ->> 'event' = ev::text;
  IF shown IS DISTINCT FROM 'the ladder put this on the wrong job' THEN
    RAISE EXCEPTION 'recon dispute contract: job view does not show the marker';
  END IF;
  IF (public.context_job_view(a) ->> 'disputed_messages')::bigint <> 1 THEN
    RAISE EXCEPTION 'recon dispute contract: disputed_messages is not 1';
  END IF;
  IF (SELECT reason FROM public.context_recon_dispute(ev)) IS DISTINCT FROM 'the ladder put this on the wrong job'
     OR (SELECT disputed_by FROM public.context_recon_dispute(ev)) IS DISTINCT FROM 'person:' || staff::text
     OR (SELECT disputed_at FROM public.context_recon_dispute(ev)) IS NULL THEN
    RAISE EXCEPTION 'recon dispute contract: dispute read does not match the mark';
  END IF;
  IF public.context_recon_evidence_hash(ev) IS DISTINCT FROM h THEN
    RAISE EXCEPTION 'recon dispute contract: evidence hash moved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.context_reconciliation_decisions WHERE subject_id = ev) THEN
    RAISE EXCEPTION 'recon dispute contract: a marker wrote a decision';
  END IF;
  IF (SELECT job_id FROM public.business_events WHERE id = ev) IS DISTINCT FROM v_job
     OR (SELECT attribution_status FROM public.business_events WHERE id = ev) IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION 'recon dispute contract: the marker wrote the message';
  END IF;
  IF (public.context_recon_health('2026-01-01') ->> 'held_total')::bigint <> held_before THEN
    RAISE EXCEPTION 'recon dispute contract: a marker counted as a hold';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_queue('2026-10-20 05:00Z') WHERE event_id = ev) THEN
    RAISE EXCEPTION 'recon dispute contract: a dispute took the row off the queue';
  END IF;
  IF (public.context_recon_health('2026-01-01') ->> 'disputed_open')::bigint <> open_before + 1 THEN
    RAISE EXCEPTION 'recon dispute contract: health does not count the marker';
  END IF;
  IF (SELECT count(*) FROM public.context_recon_disputes WHERE event_id = ev) <> 1 THEN
    RAISE EXCEPTION 'recon dispute contract: the marker is not one row';
  END IF;

  PERFORM public.context_recon_set_dispute(ev, staff, '  still the wrong job  ');
  IF (SELECT reason FROM public.context_recon_dispute(ev)) IS DISTINCT FROM 'still the wrong job'
     OR (SELECT count(*) FROM public.context_recon_disputes WHERE event_id = ev) <> 1 THEN
    RAISE EXCEPTION 'recon dispute contract: a second mark did not replace the first';
  END IF;

  PERFORM public.context_recon_record_decision(ev, h, 'confirm', ARRAY[a], 'ambiguity:several_candidates', staff);
  IF EXISTS (SELECT 1 FROM public.context_recon_queue() WHERE event_id = ev) THEN
    RAISE EXCEPTION 'recon dispute contract: a dispute put a decided row back on the queue';
  END IF;
  IF (SELECT m ->> 'dispute_reason' FROM jsonb_array_elements(public.context_job_view(a) -> 'messages') m
      WHERE m ->> 'event' = ev::text) IS DISTINCT FROM 'still the wrong job' THEN
    RAISE EXCEPTION 'recon dispute contract: a decision hid the marker';
  END IF;

  PERFORM public.context_recon_set_dispute(ev, staff, NULL);
  IF EXISTS (SELECT 1 FROM public.context_recon_dispute(ev) WHERE reason IS NOT NULL OR disputed_at IS NOT NULL)
     OR (public.context_recon_health('2026-01-01') ->> 'disputed_open')::bigint <> open_before
     OR (SELECT m ->> 'dispute_reason' FROM jsonb_array_elements(public.context_job_view(a) -> 'messages') m
         WHERE m ->> 'event' = ev::text) IS NOT NULL THEN
    RAISE EXCEPTION 'recon dispute contract: clear left the marker';
  END IF;

  PERFORM public.context_recon_set_dispute(ev, staff, 'once more');
  PERFORM public.context_recon_set_dispute(ev, staff, '   ');
  IF EXISTS (SELECT 1 FROM public.context_recon_dispute(ev) WHERE disputed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'recon dispute contract: a blank reason did not clear the marker';
  END IF;

  BEGIN PERFORM public.context_recon_set_dispute(ev, staff, repeat('x', 601));
    RAISE EXCEPTION 'recon dispute contract: long reason accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM public.context_recon_set_dispute(ev, staff, repeat('y', 600));
  IF (SELECT reason FROM public.context_recon_dispute(ev)) IS DISTINCT FROM repeat('y', 600) THEN
    RAISE EXCEPTION 'recon dispute contract: a 600 character reason was not kept';
  END IF;
END $$;
ROLLBACK;
