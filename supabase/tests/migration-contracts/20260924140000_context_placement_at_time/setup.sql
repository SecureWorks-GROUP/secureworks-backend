-- P1a setup. Earlier registered fixtures supply jobs, business_events (with
-- entity_type, entity_id, source, event_type, channel, candidate_job_ids),
-- contact_matches, event_threads, the L1 ladder, the A1 Luna functions and F1.
-- Add only the live columns this case reads that the fixtures omit, as read
-- from production 23 Sep 2026: jobs.completed_at and jobs.archived (nullable),
-- contact_matches.xero_contact_id, phone and email.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS completed_at timestamptz,
 ADD COLUMN IF NOT EXISTS archived boolean,
 ADD COLUMN IF NOT EXISTS client_phone text, ADD COLUMN IF NOT EXISTS client_email text,
 ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.contact_matches ADD COLUMN IF NOT EXISTS xero_contact_id text,
 ADD COLUMN IF NOT EXISTS phone text, ADD COLUMN IF NOT EXISTS email text;

-- Production's rerun_context_attribution is the 20260914110000 body (md5(prosrc)
-- e55811ae70e8643c3fdfc72c8741b471). That migration is not a registered case, so
-- install its text byte for byte to start from production's pre-image.
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

-- Prove every object P1a replaces is production's pre-image.
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.resolve_context_attribution(public.business_events)','acb80ebe792beeb7e5b537643bf9f184'),
  ('public.rerun_context_attribution(integer,text)','e55811ae70e8643c3fdfc72c8741b471'),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric)','48eabf7e132092cd225ff5060ce58846'),
  ('public.attribute_context_event_with_luna(uuid,uuid,numeric,text)','407832111a538b414897fa0b359232d2')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'p1a setup: % is %, not the production pre-image',x.sig,live; END IF;
 END LOOP;
END $$;
