-- Context: stamp context_captured_at on write, and re-attribute soft-bound rows.
--
-- Live finding (2026-09-14): PostgREST inserts often send explicit NULL for
-- omitted columns, which overrides DEFAULT now() on context_captured_at.
-- Extraction candidates require a non-null context_captured_at on inbound
-- attributed evidence, so the daily Luna pass saw zero jobs.
--
-- Also: rerun_context_attribution skipped rows that already had job_id set
-- (soft contact custody) but still had attribution_status NULL, so those
-- rows never received a ladder stamp.

CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Capture time is "when Context accepted the row". If the client sent NULL,
  -- stamp now so fresh evidence can activate daily extraction.
  IF NEW.context_captured_at IS NULL THEN
    NEW.context_captured_at := clock_timestamp();
  END IF;
  NEW := public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.rerun_context_attribution(p_limit integer DEFAULT 250, p_contact_id text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e public.business_events;
  resolved public.business_events;
  n int := 0;
BEGIN
  IF NOT public.automation_lane_enabled('attribution') THEN RETURN 0; END IF;
  FOR e IN
    SELECT * FROM public.business_events
    WHERE (attribution_status = 'admin_bucket' OR attribution_status IS NULL)
      AND (p_contact_id IS NULL OR contact_id = p_contact_id)
    ORDER BY attribution_checked_at NULLS FIRST, occurred_at, id
    LIMIT greatest(0, least(coalesce(p_limit, 250), 1000))
    FOR UPDATE SKIP LOCKED
  LOOP
    resolved := public.resolve_context_attribution(e);
    UPDATE public.business_events SET
      job_id = resolved.job_id,
      contact_id = resolved.contact_id,
      attribution_status = resolved.attribution_status,
      attribution_step = resolved.attribution_step,
      attribution_confidence = resolved.attribution_confidence,
      attributed_at = resolved.attributed_at,
      attribution_checked_at = resolved.attribution_checked_at,
      event_at = resolved.event_at,
      match_status = resolved.match_status,
      match_method = resolved.match_method,
      match_confidence = resolved.match_confidence,
      payload = resolved.payload,
      metadata = resolved.metadata
    WHERE id = e.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Bounded repair: stamp capture time on recent inbound rows that already have
-- words, so today's pass can see them without an unbounded historical backfill.
UPDATE public.business_events e
SET context_captured_at = coalesce(e.event_at, e.occurred_at, clock_timestamp())
WHERE e.context_captured_at IS NULL
  AND e.occurred_at > now() - interval '14 days'
  AND e.direction IS DISTINCT FROM 'outbound'
  AND btrim(public.context_event_text(e)) <> '';
