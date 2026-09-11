-- Weekly collector snapshots; never infer completion or zero-fill missing measures.
CREATE TABLE public.sales_performance_weeks (
  org_id uuid NOT NULL REFERENCES public.organisations(id),
  week_start date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  lane text NOT NULL CHECK (lane IN ('patio', 'fencing')),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  coverage jsonb NOT NULL CHECK (jsonb_typeof(coverage) = 'object' AND coverage ? 'gaps' AND jsonb_typeof(coverage->'gaps') = 'array' AND coverage @> '{"collection_complete":true}'::jsonb),
  queues jsonb NOT NULL CHECK (jsonb_typeof(queues) = 'object'),
  notes jsonb,
  run_id text NOT NULL CHECK (length(trim(run_id)) BETWEEN 1 AND 200),
  definition_version text NOT NULL CHECK (length(trim(definition_version)) BETWEEN 1 AND 200),
  computed_at timestamptz NOT NULL CHECK (isfinite(computed_at)),
  PRIMARY KEY (org_id, week_start, lane)
);
ALTER TABLE public.sales_performance_weeks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_performance_weeks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sales_performance_weeks TO authenticated;
GRANT ALL ON public.sales_performance_weeks TO service_role;
CREATE POLICY sales_performance_staff_read ON public.sales_performance_weeks
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = auth.uid()
      AND u.org_id = sales_performance_weeks.org_id
      AND lower(u.role::text) IN ('admin', 'owner', 'ops_manager')
  ));

-- A single conflict update deliberately excludes notes. A concurrent note save
-- and rerun serialize on the row without either restoring an old notes value.
CREATE FUNCTION public.sales_performance_write_v1(
  p_org_id uuid, p_week_start date, p_lane text, p_metrics jsonb,
  p_coverage jsonb, p_queues jsonb, p_run_id text,
  p_definition_version text, p_computed_at timestamptz
) RETURNS public.sales_performance_weeks
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE result public.sales_performance_weeks;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.sales_performance_weeks AS w
    (org_id, week_start, lane, metrics, coverage, queues, run_id, definition_version, computed_at)
  VALUES (p_org_id, p_week_start, p_lane, p_metrics, p_coverage, p_queues, p_run_id, p_definition_version, p_computed_at)
  ON CONFLICT (org_id, week_start, lane) DO UPDATE SET
    metrics = EXCLUDED.metrics, coverage = EXCLUDED.coverage, queues = EXCLUDED.queues,
    run_id = EXCLUDED.run_id, definition_version = EXCLUDED.definition_version,
    computed_at = EXCLUDED.computed_at
  RETURNING * INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.sales_performance_write_v1(uuid,date,text,jsonb,jsonb,jsonb,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_performance_write_v1(uuid,date,text,jsonb,jsonb,jsonb,text,text,timestamptz) TO service_role;

-- Only the authenticated profile supplies tenant and attribution. Table UPDATE
-- remains unavailable to browser callers; this RPC can change notes only.
CREATE FUNCTION public.sales_performance_note_v1(p_week_start date, p_lane text, p_note text)
RETURNS public.sales_performance_weeks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.users%ROWTYPE; result public.sales_performance_weeks;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'user_jwt_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO actor FROM public.users WHERE id = auth.uid();
  IF actor.org_id IS NULL OR lower(actor.role::text) NOT IN ('admin', 'owner', 'ops_manager') OR actor.role IS NULL THEN
    RAISE EXCEPTION 'operator_access_required' USING ERRCODE = '42501';
  END IF;
  IF p_week_start IS NULL OR extract(isodow FROM p_week_start) <> 1 OR p_lane IS NULL OR p_lane NOT IN ('patio', 'fencing') OR p_note IS NULL OR length(p_note) > 10000 THEN
    RAISE EXCEPTION 'invalid_note_input' USING ERRCODE = '22023';
  END IF;
  UPDATE public.sales_performance_weeks SET notes = jsonb_build_object(
    'text', p_note, 'author_id', actor.id, 'author_name', actor.name, 'updated_at', clock_timestamp()
  ) WHERE org_id = actor.org_id AND week_start = p_week_start AND lane = p_lane
  RETURNING * INTO result;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found' USING ERRCODE = 'P0002'; END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.sales_performance_note_v1(date,text,text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.sales_performance_note_v1(date,text,text) TO authenticated;
