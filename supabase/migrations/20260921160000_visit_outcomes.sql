-- Durable visit business records. No provider writes, sends, or booking triggers.
CREATE TABLE public.visit_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_key text NOT NULL CHECK (length(btrim(booking_key)) BETWEEN 1 AND 300),
  appointment_id text,
  contact_id text NOT NULL CHECK (length(btrim(contact_id)) BETWEEN 1 AND 300),
  opportunity_id text,
  job_id uuid,
  scoper_user_id uuid NOT NULL,
  scoper_name text NOT NULL CHECK (length(btrim(scoper_name)) BETWEEN 1 AND 200),
  visit_start timestamptz NOT NULL CHECK (isfinite(visit_start)),
  outcome text NOT NULL CHECK (outcome IN ('happened', 'did_not_happen')),
  reason text,
  note text CHECK (char_length(note) <= 200 AND note !~ E'[\\n\\r\\t\\x01-\\x1f\\x7f]' AND note !~ U&'[\0085\2028\2029]'),
  quote_owed boolean NOT NULL,
  recorded_by_user_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL DEFAULT 'booking_screen' CHECK (source = 'booking_screen'),
  supersedes uuid UNIQUE REFERENCES public.visit_outcomes(id),
  CHECK ((outcome = 'happened' AND reason IS NULL) OR
    (outcome = 'did_not_happen' AND reason IS NOT NULL AND
      reason IN ('customer_not_home', 'we_did_not_attend', 'rescheduled'))),
  CHECK (supersedes IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX visit_outcomes_one_root ON public.visit_outcomes(booking_key) WHERE supersedes IS NULL;
CREATE INDEX visit_outcomes_scoper_start ON public.visit_outcomes(scoper_user_id, visit_start);
CREATE INDEX visit_outcomes_contact ON public.visit_outcomes(contact_id);
CREATE INDEX visit_outcomes_booking ON public.visit_outcomes(booking_key, recorded_at DESC);
CREATE INDEX visit_outcomes_start ON public.visit_outcomes(visit_start);

ALTER TABLE public.visit_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.visit_outcomes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.visit_outcomes TO service_role;
-- INSERT is available only through the locked RPC; even service-role callers
-- cannot bypass correction-chain validation or database-owned timestamps.
CREATE FUNCTION public.refuse_visit_outcome_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'visit_outcomes is append-only; insert a correction with supersedes' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER visit_outcomes_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
ON public.visit_outcomes FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_visit_outcome_mutation();
REVOKE ALL ON FUNCTION public.refuse_visit_outcome_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_visit_outcome(p_record jsonb, p_recorded_by_user_id uuid)
RETURNS public.visit_outcomes LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  proposed public.visit_outcomes;
  current_row public.visit_outcomes;
  server_now timestamptz;
BEGIN
  proposed := jsonb_populate_record(NULL::public.visit_outcomes, p_record);
  IF proposed.booking_key IS NULL OR btrim(proposed.booking_key) = '' OR p_recorded_by_user_id IS NULL THEN
    RAISE EXCEPTION 'booking_key and authenticated user are required' USING ERRCODE = '23514';
  END IF;
  -- Serialize the whole booking, including two simultaneous first taps or corrections.
  PERFORM pg_advisory_xact_lock(hashtextextended('visit_outcome:' || proposed.booking_key, 0));
  server_now := clock_timestamp();
  SELECT v.* INTO current_row FROM public.visit_outcomes v
  WHERE v.booking_key = proposed.booking_key
    AND NOT EXISTS (SELECT 1 FROM public.visit_outcomes successor WHERE successor.supersedes = v.id);

  -- Sliding 30-second window, not a time bucket. Match the required double-tap
  -- tuple and the rest of the payload so intentional quote/identity corrections
  -- never disappear. A retry of an already-superseded record is a stale conflict.
  IF current_row.id IS NOT NULL
    AND current_row.recorded_at >= server_now - interval '30 seconds'
    AND current_row.recorded_by_user_id = p_recorded_by_user_id
    AND (to_jsonb(current_row) - ARRAY['id','recorded_at','recorded_by_user_id','source']) =
        (to_jsonb(proposed) - ARRAY['id','recorded_at','recorded_by_user_id','source']) THEN
    RETURN current_row;
  END IF;
  IF current_row.id IS NULL AND proposed.supersedes IS NOT NULL THEN
    RAISE EXCEPTION 'No current outcome for booking_key; supersedes must be null';
  ELSIF current_row.id IS NOT NULL AND proposed.supersedes IS DISTINCT FROM current_row.id THEN
    RAISE EXCEPTION 'Outcome exists or correction is stale; supersedes must identify the current outcome';
  END IF;

  INSERT INTO public.visit_outcomes (
    booking_key, appointment_id, contact_id, opportunity_id, job_id,
    scoper_user_id, scoper_name, visit_start, outcome, reason, note, quote_owed,
    recorded_by_user_id, recorded_at, source, supersedes
  ) VALUES (
    proposed.booking_key, proposed.appointment_id, proposed.contact_id, proposed.opportunity_id, proposed.job_id,
    proposed.scoper_user_id, proposed.scoper_name, proposed.visit_start, proposed.outcome, proposed.reason, proposed.note, proposed.quote_owed,
    p_recorded_by_user_id, server_now, 'booking_screen', proposed.supersedes
  ) RETURNING * INTO proposed;
  RETURN proposed;
END;
$$;
REVOKE ALL ON FUNCTION public.record_visit_outcome(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_visit_outcome(jsonb, uuid) TO service_role;

CREATE FUNCTION public.list_visit_outcomes(
  p_since timestamptz, p_until timestamptz,
  p_scoper_user_id uuid DEFAULT NULL, p_contact_id text DEFAULT NULL,
  p_include_history boolean DEFAULT false, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until)
    OR p_until <= p_since OR p_until - p_since > interval '366 days'
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
    OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'Invalid visit outcome range or pagination' USING ERRCODE = '23514';
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT v.* FROM public.visit_outcomes v
    WHERE NOT EXISTS (SELECT 1 FROM public.visit_outcomes successor WHERE successor.supersedes = v.id)
      AND v.visit_start >= p_since AND v.visit_start < p_until
      AND (p_scoper_user_id IS NULL OR v.scoper_user_id = p_scoper_user_id)
      AND (p_contact_id IS NULL OR v.contact_id = p_contact_id)
    ORDER BY v.visit_start, v.booking_key LIMIT p_limit + 1 OFFSET p_offset
  ), page AS MATERIALIZED (
    SELECT * FROM candidates ORDER BY visit_start, booking_key LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'outcomes', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.visit_start, p.booking_key) FROM page p), '[]'::jsonb),
    'limit', p_limit, 'offset', p_offset, 'has_more', (SELECT count(*) > p_limit FROM candidates)
  ) || CASE WHEN p_include_history THEN jsonb_build_object(
    'history', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.booking_key, h.recorded_at, h.id)
      FROM public.visit_outcomes h JOIN page p USING (booking_key)), '[]'::jsonb)
  ) ELSE '{}'::jsonb END INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.list_visit_outcomes(timestamptz,timestamptz,uuid,text,boolean,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_visit_outcomes(timestamptz,timestamptz,uuid,text,boolean,integer,integer) TO service_role;
COMMENT ON TABLE public.visit_outcomes IS 'Append-only visit business records. One current outcome per booking_key; corrections supersede the current row. No customer-message effects. Read contract: docs/visit-outcomes-api.md.';
