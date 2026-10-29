-- Prerequisites for 20261029220000_context_job_picture_for_event. Earlier
-- registered cases create business_events, the B0 sender rule
-- (context_event_identity) and the job picture (20261029200000). This adds
-- nothing; it fails closed if one of them is gone from the registered stack.
DO $$
DECLARE f text;
BEGIN
  IF to_regclass('public.business_events') IS NULL THEN
    RAISE EXCEPTION 'job picture for event setup: public.business_events missing from the registered stack';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.context_event_identity(public.business_events)',
                           'public.context_job_picture(uuid[],text[],text[])'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'job picture for event setup: % missing from the registered stack', f;
    END IF;
  END LOOP;
END $$;
