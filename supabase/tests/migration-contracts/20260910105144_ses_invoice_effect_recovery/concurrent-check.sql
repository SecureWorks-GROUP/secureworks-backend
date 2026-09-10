DO $$
DECLARE
  current_state text;
  checkpoint text;
  claim_events integer;
BEGIN
  SELECT state, external_id
  INTO current_state, checkpoint
  FROM public.ses_external_effects
  WHERE id = '61000000-0000-4000-8000-000000000021'::uuid;

  SELECT count(*)
  INTO claim_events
  FROM public.ses_external_effect_events
  WHERE effect_id = '61000000-0000-4000-8000-000000000021'::uuid
    AND event_kind = 'definite_no_dispatch_redispatch_claimed';

  IF current_state IS DISTINCT FROM 'dispatching'
     OR NULLIF(btrim(checkpoint), '') IS NOT NULL
     OR claim_events IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'concurrent invoice retry did not produce one exclusive claim: state=%, external_id=%, claim_events=%',
      current_state,
      checkpoint,
      claim_events;
  END IF;
END;
$$;
