-- Contract for 20261020150000_context_recon_backlog_lane. Proves the settings row, the browser
-- revokes, and the lane rule against the real stacked schema. Every fixture write is rolled back.
\set ON_ERROR_STOP 1

-- 1. Shape: one settings row, live_from null after apply, RLS on, no browser grant.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.context_recon_settings) <> 1 OR public.context_recon_live_from() IS NOT NULL THEN
    RAISE EXCEPTION 'recon lane contract: settings must be one row with live_from null';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_recon_settings'::regclass) THEN
    RAISE EXCEPTION 'recon lane contract: RLS is not on';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_table_privilege('authenticated', 'public.context_recon_settings', 'SELECT')
          OR has_table_privilege('anon', 'public.context_recon_settings', 'UPDATE')
          OR has_function_privilege('authenticated', 'public.context_recon_queue(timestamptz)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_recon_live_from()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'recon lane contract: a browser role holds a grant';
  END IF;
  BEGIN
    INSERT INTO public.context_recon_settings (id) VALUES (false);
    RAISE EXCEPTION 'recon lane contract: a second settings row was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

BEGIN;
INSERT INTO public.business_events (id, channel, direction, occurred_at, contact_id, payload, event_type, source) VALUES
  ('7c400000-0000-0000-0000-000000000001', 'sms', 'inbound', '2026-09-01 01:00Z', 'recon-lane-1', '{"body":"old"}', 'sms.inbound', 'recon-lane'),
  ('7c400000-0000-0000-0000-000000000002', 'sms', 'inbound', '2026-09-01 02:00Z', 'recon-lane-2', '{"body":"old"}', 'sms.inbound', 'recon-lane');
UPDATE public.business_events SET job_id = NULL, attribution_status = 'unplaced', context_captured_at = occurred_at
WHERE id IN ('7c400000-0000-0000-0000-000000000001', '7c400000-0000-0000-0000-000000000002');

DO $$
DECLARE e1 uuid := '7c400000-0000-0000-0000-000000000001'; e2 uuid := '7c400000-0000-0000-0000-000000000002';
BEGIN
  -- 2. With live_from null every row is live.
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_queue() WHERE event_id = e1 AND lane = 'live' AND lane_reason = 'no_live_from') THEN
    RAISE EXCEPTION 'recon lane contract: a row was not live while live_from is null';
  END IF;
  -- 3. live_from after both rows: both are backlog.
  UPDATE public.context_recon_settings SET live_from = '2026-10-01 00:00Z', updated_at = now();
  IF (SELECT count(*) FROM public.context_recon_queue() WHERE event_id IN (e1, e2) AND lane = 'backlog' AND lane_reason = 'captured_before_live_from') <> 2 THEN
    RAISE EXCEPTION 'recon lane contract: old rows were not backlog';
  END IF;
  -- 4. A new row from contact 1 after live_from pulls that contact's old row into the live lane.
  INSERT INTO public.business_events (id, channel, direction, occurred_at, contact_id, payload, event_type, source)
  VALUES ('7c400000-0000-0000-0000-000000000003', 'sms', 'inbound', '2026-10-05 01:00Z', 'recon-lane-1', '{"body":"new"}', 'sms.inbound', 'recon-lane');
  UPDATE public.business_events SET context_captured_at = occurred_at WHERE id = '7c400000-0000-0000-0000-000000000003';
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_queue() WHERE event_id = e1 AND lane = 'live' AND lane_reason = 'contact_active_since_live_from') THEN
    RAISE EXCEPTION 'recon lane contract: an active contact''s old row stayed backlog';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_queue() WHERE event_id = e2 AND lane = 'backlog') THEN
    RAISE EXCEPTION 'recon lane contract: a quiet contact''s old row left the backlog';
  END IF;
  -- 5. Health counts the lanes.
  IF NOT (public.context_recon_health('2026-01-01') ? 'queue_by_lane')
     OR coalesce((public.context_recon_health('2026-01-01') -> 'queue_by_lane' ->> 'backlog')::bigint, 0) < 1 THEN
    RAISE EXCEPTION 'recon lane contract: health does not count the backlog lane';
  END IF;
END $$;
ROLLBACK;
