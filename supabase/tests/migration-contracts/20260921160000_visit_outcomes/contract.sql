BEGIN;
DO $$
DECLARE
  actor uuid := '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73';
  payload jsonb := '{"booking_key":"contract-visit", "contact_id":"ghl-contact", "scoper_user_id":"5862cf1d-0a3b-4836-8fd1-d69f95aa2f73", "scoper_name":"Nithin", "visit_start":"2026-09-15T10:00:00+08:00", "outcome":"happened", "quote_owed":true}'::jsonb;
  first_row public.visit_outcomes;
  correction public.visit_outcomes;
  retry public.visit_outcomes;
  page jsonb;
  bad jsonb;
  role_name text;
BEGIN
  first_row := public.record_visit_outcome(payload || '{"recorded_at":"2000-01-01", "source":"forged", "recorded_by_user_id":"00000000-0000-0000-0000-000000000001"}', actor);
  IF first_row.recorded_by_user_id <> actor OR first_row.source <> 'booking_screen'
    OR first_row.recorded_at < now() - interval '5 seconds' OR first_row.quote_owed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'contract: server attribution/default source failed';
  END IF;
  retry := public.record_visit_outcome(payload, actor);
  IF retry.id <> first_row.id THEN RAISE EXCEPTION 'contract: double tap inserted two rows'; END IF;

  -- Invalid shape is rejected by SQL too, not only by browser/edge validation.
  FOR bad IN SELECT value FROM jsonb_array_elements('[
    {"outcome":"unknown"}, {"reason":"rescheduled"},
    {"outcome":"did_not_happen"}, {"outcome":"did_not_happen","reason":"unknown"},
    {"note":"two\nlines"}, {"note":"two\tlines"}, {"note":"two\u2028lines"},
    {"contact_id":""}, {"scoper_name":""}, {"visit_start":"infinity"}
  ]'::jsonb) LOOP
    BEGIN
      PERFORM public.record_visit_outcome(payload || bad || jsonb_build_object('booking_key', gen_random_uuid()::text), actor);
      RAISE EXCEPTION 'contract: invalid payload accepted: %', bad;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.record_visit_outcome(payload || jsonb_build_object('booking_key', 'long-note', 'note', repeat('x',201)), actor);
    RAISE EXCEPTION 'contract: long note accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Existing booking requires an explicit current supersedes pointer, even
  -- after the retry window. Old records are never overwritten.
  BEGIN
    PERFORM public.record_visit_outcome(payload || '{"quote_owed":false}', actor);
    RAISE EXCEPTION 'contract: implicit correction accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'contract:%' THEN RAISE; END IF;
  END;
  correction := public.record_visit_outcome(payload || jsonb_build_object('supersedes', first_row.id, 'quote_owed', false), actor);
  retry := public.record_visit_outcome(payload || jsonb_build_object('supersedes', first_row.id, 'quote_owed', false), actor);
  IF retry.id <> correction.id OR correction.quote_owed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'contract: correction retry or untick failed';
  END IF;
  BEGIN
    PERFORM public.record_visit_outcome(payload || jsonb_build_object('supersedes', first_row.id, 'note', 'stale'), actor);
    RAISE EXCEPTION 'contract: stale correction accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'contract:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.record_visit_outcome(payload || jsonb_build_object('booking_key', 'other', 'supersedes', correction.id), actor);
    RAISE EXCEPTION 'contract: cross-booking correction accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'contract:%' THEN RAISE; END IF;
  END;

  page := public.list_visit_outcomes('2026-09-15T00:00:00+08:00', '2026-09-16T00:00:00+08:00', actor, 'ghl-contact', true);
  IF jsonb_array_length(page->'outcomes') <> 1 OR page->'outcomes'->0->>'id' <> correction.id::text
    OR jsonb_array_length(page->'history') <> 2 THEN
    RAISE EXCEPTION 'contract: current/history response wrong: %', page;
  END IF;
  -- Correct date + contact too. Filtering cannot resurrect the old outcome.
  correction := public.record_visit_outcome(payload || jsonb_build_object('supersedes', correction.id, 'contact_id', 'fixed-contact', 'visit_start', '2026-09-16T10:00:00+08:00'), actor);
  page := public.list_visit_outcomes('2026-09-15T00:00:00+08:00', '2026-09-16T00:00:00+08:00');
  IF page->'outcomes' <> '[]'::jsonb THEN RAISE EXCEPTION 'contract: superseded date resurrected'; END IF;
  page := public.list_visit_outcomes('2026-09-01', '2026-10-01', NULL, 'ghl-contact');
  IF page->'outcomes' <> '[]'::jsonb THEN RAISE EXCEPTION 'contract: superseded contact resurrected'; END IF;
  page := public.list_visit_outcomes('2026-09-16T02:00:00Z', '2026-09-16T02:00:01Z', NULL, 'fixed-contact', true);
  IF jsonb_array_length(page->'history') <> 3 OR jsonb_array_length(page->'outcomes') <> 1 THEN RAISE EXCEPTION 'contract: history must include old dates/contacts'; END IF;
  page := public.list_visit_outcomes('2026-09-15T02:00:00Z', '2026-09-16T02:00:00Z');
  IF page->'outcomes' <> '[]'::jsonb THEN RAISE EXCEPTION 'contract: upper bound must be exclusive'; END IF;

  -- Paging occurs over current bookings, not their history rows.
  PERFORM public.record_visit_outcome(payload || '{"booking_key":"contract-visit-2"}', actor);
  page := public.list_visit_outcomes('2026-09-01', '2026-10-01', NULL, NULL, true, 1, 0);
  IF jsonb_array_length(page->'outcomes') <> 1 OR page->>'has_more' <> 'true' OR jsonb_array_length(page->'history') <> 1 THEN
    RAISE EXCEPTION 'contract: first page wrong';
  END IF;
  page := public.list_visit_outcomes('2026-09-01', '2026-10-01', NULL, NULL, false, 1, 1);
  IF page->'outcomes'->0->>'id' <> correction.id::text OR page->>'has_more' <> 'false' OR page ? 'history' THEN RAISE EXCEPTION 'contract: second page wrong'; END IF;
  page := public.list_visit_outcomes('2026-09-01', '2026-10-01', '00000000-0000-0000-0000-000000000001');
  IF page->'outcomes' <> '[]'::jsonb THEN RAISE EXCEPTION 'contract: scoper filter ignored'; END IF;

  BEGIN
    UPDATE public.visit_outcomes SET note = 'rewrite' WHERE id = first_row.id;
    RAISE EXCEPTION 'contract: UPDATE allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM public.visit_outcomes WHERE id = first_row.id;
    RAISE EXCEPTION 'contract: DELETE allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    TRUNCATE public.visit_outcomes;
    RAISE EXCEPTION 'contract: TRUNCATE allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.visit_outcomes'::regclass) THEN RAISE EXCEPTION 'contract: missing RLS'; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF has_table_privilege(role_name, 'public.visit_outcomes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      OR has_function_privilege(role_name, 'public.record_visit_outcome(jsonb,uuid)', 'EXECUTE')
      OR has_function_privilege(role_name, 'public.list_visit_outcomes(timestamptz,timestamptz,uuid,text,boolean,integer,integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'contract: client access granted to %', role_name;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.visit_outcomes', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'contract: service role can bypass append RPC'; END IF;
  IF NOT has_function_privilege('service_role', 'public.record_visit_outcome(jsonb,uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'contract: service role cannot record outcomes'; END IF;
END $$;
ROLLBACK;
