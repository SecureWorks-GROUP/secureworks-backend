-- P4-06.1: model choices and harness scores only. No worker or timer is changed.
CREATE TABLE IF NOT EXISTS public.context_ai_job_models (
  ai_job text NOT NULL,
  role text NOT NULL CHECK (role IN ('doer','checker')),
  engine text NOT NULL CHECK (engine IN ('codex','claude')),
  model text NOT NULL,
  effort text NOT NULL,
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 10000 AND 1200000),
  chosen_from_run text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'seed',
  PRIMARY KEY (ai_job, role)
);
ALTER TABLE public.context_ai_job_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_ai_job_models FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.context_ai_job_models TO service_role;

INSERT INTO public.context_ai_job_models (ai_job, role, engine, model, effort, timeout_ms) VALUES
  ('place-message','doer','codex','gpt-6-luna','xhigh',300000),
  ('read-notes','doer','codex','gpt-6-luna','xhigh',1200000),
  ('write-story','doer','codex','gpt-6-luna','xhigh',240000),
  ('check-story','doer','codex','gpt-6-luna','high',150000),
  ('read-bill','doer','codex','gpt-6-luna','xhigh',600000),
  ('read-bill','checker','claude','claude-opus-5-5','high',600000),
  ('read-facts','doer','codex','gpt-6-luna','xhigh',300000),
  ('read-picture','doer','codex','gpt-6-luna','xhigh',300000)
ON CONFLICT (ai_job, role) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.context_ai_harness_runs (
  run_id text NOT NULL,
  ai_job text NOT NULL,
  spec_id text NOT NULL,
  spec_version integer NOT NULL,
  engine text NOT NULL,
  model text NOT NULL,
  effort text NOT NULL,
  sheet_id text NOT NULL,
  cases integer NOT NULL,
  passed integer NOT NULL,
  score numeric(5,4) NOT NULL,
  critical_misses integer NOT NULL,
  median_ms integer NOT NULL,
  p95_ms integer NOT NULL,
  calls integer NOT NULL,
  calls_per_case numeric(6,2) NOT NULL,
  checker_model text,
  ran_at timestamptz NOT NULL DEFAULT now(),
  passes_bar boolean NOT NULL,
  PRIMARY KEY (run_id, ai_job, engine, model, effort)
);
ALTER TABLE public.context_ai_harness_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_ai_harness_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.context_ai_harness_runs TO service_role;
-- Serves the bounded manual retention read, including a stable tie-break.
CREATE INDEX IF NOT EXISTS context_ai_harness_runs_ran_at_key
  ON public.context_ai_harness_runs (ran_at, run_id COLLATE "C", ai_job COLLATE "C",
    engine COLLATE "C", model COLLATE "C", effort COLLATE "C");

CREATE OR REPLACE FUNCTION public.context_ai_harness_save(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DECLARE v_count integer; BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'context_ai_harness_array_required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 200 THEN
    RAISE EXCEPTION 'context_ai_harness_batch_too_large' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.context_ai_harness_runs (
    run_id, ai_job, spec_id, spec_version, engine, model, effort, sheet_id,
    cases, passed, score, critical_misses, median_ms, p95_ms, calls,
    calls_per_case, checker_model, ran_at, passes_bar
  )
  SELECT r.run_id, r.ai_job, r.spec_id, r.spec_version, r.engine, r.model,
    r.effort, r.sheet_id, r.cases, r.passed, r.score, r.critical_misses,
    r.median_ms, r.p95_ms, r.calls, r.calls_per_case, r.checker_model,
    coalesce(r.ran_at, now()), r.passes_bar
  FROM jsonb_to_recordset(p_rows) AS r (
    run_id text, ai_job text, spec_id text, spec_version integer, engine text,
    model text, effort text, sheet_id text, cases integer, passed integer,
    score numeric(5,4), critical_misses integer, median_ms integer, p95_ms integer,
    calls integer, calls_per_case numeric(6,2), checker_model text,
    ran_at timestamptz, passes_bar boolean
  )
  ON CONFLICT (run_id, ai_job, engine, model, effort) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.context_ai_harness_save(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ai_harness_save(jsonb) TO service_role;

-- No schedule or retention age is chosen here. The director supplies the cutoff.
-- Keep the evidence of every currently selected model choice.
CREATE OR REPLACE FUNCTION public.context_ai_harness_trim(p_before timestamptz, p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DECLARE v_count integer; BEGIN
  WITH oldest AS (
    SELECT h.run_id, h.ai_job, h.engine, h.model, h.effort
    FROM public.context_ai_harness_runs h
    WHERE h.ran_at < p_before
      AND NOT EXISTS (
        SELECT 1 FROM public.context_ai_job_models m WHERE m.chosen_from_run = h.run_id
      )
    ORDER BY h.ran_at, h.run_id COLLATE "C", h.ai_job COLLATE "C",
      h.engine COLLATE "C", h.model COLLATE "C", h.effort COLLATE "C"
    LIMIT greatest(1, least(coalesce(p_limit, 200), 200))
    FOR UPDATE OF h SKIP LOCKED
  )
  DELETE FROM public.context_ai_harness_runs h USING oldest o
  WHERE (h.run_id, h.ai_job, h.engine, h.model, h.effort)
      = (o.run_id, o.ai_job, o.engine, o.model, o.effort);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.context_ai_harness_trim(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ai_harness_trim(timestamptz, integer) TO service_role;
