-- P4-01.1: private batched model-call metadata. No prompt or answer text.
CREATE TABLE IF NOT EXISTS public.context_ai_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  ai_job text NOT NULL CHECK (ai_job ~ '^[a-z][a-z0-9-]{1,40}$'),
  spec_id text NOT NULL,
  spec_version integer NOT NULL CHECK (spec_version >= 0),
  spec_sha256 text,
  engine text NOT NULL CHECK (engine IN ('codex','claude')),
  model text NOT NULL,
  effort text,
  job_id uuid,
  subject text,
  outcome text NOT NULL CHECK (outcome IN ('answered','invalid','failed','timeout','rate_limited')),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  tokens_in integer,
  tokens_out integer,
  retry boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'live' CHECK (source IN ('live','harness'))
);
CREATE INDEX IF NOT EXISTS context_ai_calls_job_at ON public.context_ai_calls (ai_job, at DESC);
-- Global time reads and bounded retention use this index, not a whole-table sort.
CREATE INDEX IF NOT EXISTS context_ai_calls_at_id ON public.context_ai_calls (at, id);
ALTER TABLE public.context_ai_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_ai_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.context_ai_calls TO service_role;

CREATE OR REPLACE FUNCTION public.context_ai_calls_log(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DECLARE v_count integer; BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'context_ai_calls_array_required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'context_ai_calls_batch_too_large' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.context_ai_calls (
    at, ai_job, spec_id, spec_version, spec_sha256, engine, model, effort,
    job_id, subject, outcome, duration_ms, tokens_in, tokens_out, retry, source
  )
  SELECT coalesce(r.at, now()), r.ai_job, r.spec_id, r.spec_version, r.spec_sha256,
    r.engine, r.model, r.effort, r.job_id, r.subject, r.outcome, r.duration_ms,
    r.tokens_in, r.tokens_out, coalesce(r.retry, false), coalesce(r.source, 'live')
  FROM jsonb_to_recordset(p_rows) AS r (
    at timestamptz, ai_job text, spec_id text, spec_version integer, spec_sha256 text,
    engine text, model text, effort text, job_id uuid, subject text, outcome text,
    duration_ms integer, tokens_in integer, tokens_out integer, retry boolean, source text
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.context_ai_calls_log(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ai_calls_log(jsonb) TO service_role;

CREATE OR REPLACE VIEW public.context_ai_calls_daily AS
SELECT (at AT TIME ZONE 'Australia/Perth')::date AS day,
  ai_job, spec_id, spec_version, engine, model, effort,
  count(*) AS calls,
  count(*) FILTER (WHERE outcome = 'answered') AS answered,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM public.context_ai_calls
GROUP BY (at AT TIME ZONE 'Australia/Perth')::date,
  ai_job, spec_id, spec_version, engine, model, effort;
REVOKE ALL ON public.context_ai_calls_daily FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.context_ai_calls_daily TO service_role;

-- No schedule or retention age is chosen here. The director supplies the cutoff.
CREATE OR REPLACE FUNCTION public.context_ai_calls_trim(p_before timestamptz, p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DECLARE v_count integer; BEGIN
  WITH oldest AS (
    SELECT id FROM public.context_ai_calls WHERE at < p_before
    ORDER BY at, id LIMIT greatest(1, least(coalesce(p_limit, 500), 500))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.context_ai_calls c USING oldest o WHERE c.id = o.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.context_ai_calls_trim(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ai_calls_trim(timestamptz, integer) TO service_role;
