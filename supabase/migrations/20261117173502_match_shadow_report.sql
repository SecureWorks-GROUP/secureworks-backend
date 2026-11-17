-- P2-02.14: on-demand comparison only. No schedules, writes or switch changes.
CREATE INDEX match_shadow_runs_period_idx ON public.match_shadow_runs(created_at DESC);
CREATE INDEX match_clues_run_idx ON public.match_clues(run_id, subject_kind, subject_id);

CREATE FUNCTION public.match_shadow_report(p_days int DEFAULT 7)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON (s.subject_id COLLATE "C") s.*
  FROM public.match_shadow_runs s
  WHERE s.subject_kind = 'cost_document' AND s.subject_id LIKE 'xero_bill:%'
    AND s.created_at >= now() - make_interval(days => p_days)
  ORDER BY s.subject_id COLLATE "C", s.created_at DESC, s.id DESC
), bills AS MATERIALIZED (
  SELECT s.*, x.sub_total AS amount_ex,
    coalesce(f.jobs, '[]'::jsonb) AS legacy_jobs,
    CASE WHEN jsonb_array_length(f.jobs) = 1 THEN f.jobs->0
      WHEN jsonb_array_length(f.jobs) > 1 THEN f.jobs
      WHEN q.status = 'not_job_related' THEN '"not_job_related"'::jsonb
      ELSE '"open"'::jsonb END AS legacy_job,
    coalesce(c.clues, '[]'::jsonb) AS clues
  FROM latest s
  JOIN public.xero_invoices x ON x.xero_invoice_id = substring(s.subject_id FROM 11)
    AND x.invoice_type = 'ACCPAY'
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(t.job_id ORDER BY t.job_id) AS jobs FROM (
      SELECT DISTINCT f.job_id FROM public.job_materials_facts f
      WHERE f.xero_invoice_id = x.xero_invoice_id AND f.org_id = x.org_id
    ) t
  ) f ON true
  LEFT JOIN public.materials_reconciliation_queue q
    ON q.xero_invoice_id = x.xero_invoice_id AND q.org_id = x.org_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'clue_code', c.clue_code,
      'family', c.family, 'root', c.root, 'outcome', c.outcome,
      'job_id', c.job_id, 'detail', c.detail) ORDER BY c.id) AS clues
    FROM public.match_clues c WHERE c.run_id = s.run_id
      AND c.subject_kind = s.subject_kind AND c.subject_id = s.subject_id
  ) c ON true
), totals AS (
 SELECT count(*) AS documents,
   CASE WHEN count(amount_ex) = count(*) THEN coalesce(sum(amount_ex),0) END AS dollars,
   count(*) FILTER (WHERE result->>'result' = 'auto') AS auto_count,
   CASE WHEN count(amount_ex) FILTER (WHERE result->>'result' = 'auto') = count(*) FILTER (WHERE result->>'result' = 'auto') THEN coalesce(sum(amount_ex) FILTER (WHERE result->>'result' = 'auto'),0) END AS auto_dollars,
   count(*) FILTER (WHERE result->>'result' = 'auto' AND legacy_jobs = jsonb_build_array(result->>'job_id')) AS same_job,
   coalesce(jsonb_agg(jsonb_build_object('subject_id',subject_id,'matcher_job',result->>'job_id',
     'legacy_job',legacy_job,'clues',clues) ORDER BY subject_id COLLATE "C")
     FILTER (WHERE result->>'result' = 'auto' AND legacy_jobs <> jsonb_build_array(result->>'job_id')), '[]') AS different_job,
   count(*) FILTER (WHERE result->>'result' = 'suggest') AS suggest_count,
   CASE WHEN count(amount_ex) FILTER (WHERE result->>'result' = 'suggest') = count(*) FILTER (WHERE result->>'result' = 'suggest') THEN coalesce(sum(amount_ex) FILTER (WHERE result->>'result' = 'suggest'),0) END AS suggest_dollars,
   count(*) FILTER (WHERE result->>'result' = 'suggest' AND (
     (result->>'outcome' = 'job' AND legacy_jobs = jsonb_build_array(result->>'job_id')) OR
     (result->>'outcome' = 'overhead' AND legacy_job = '"not_job_related"'::jsonb))) AS suggestion_equals,
   count(*) FILTER (WHERE result->>'result' = 'none') AS none_count,
   CASE WHEN count(amount_ex) FILTER (WHERE result->>'result' = 'none') = count(*) FILTER (WHERE result->>'result' = 'none') THEN coalesce(sum(amount_ex) FILTER (WHERE result->>'result' = 'none'),0) END AS none_dollars
 FROM bills
), stop_counts AS (
 SELECT code, count(*) AS n FROM bills b CROSS JOIN LATERAL (
   SELECT DISTINCT v->>'code' AS code FROM jsonb_array_elements(coalesce(b.stops,'[]')) a(v)
 ) s WHERE code IS NOT NULL GROUP BY code
)
SELECT jsonb_build_object('documents',t.documents,'dollars',t.dollars,
 'auto',jsonb_build_object('count',t.auto_count,'dollars',t.auto_dollars,
   'same_job_as_legacy',t.same_job,'different_job',t.different_job),
 'suggest',jsonb_build_object('count',t.suggest_count,'dollars',t.suggest_dollars,
   'suggestion_equals_legacy',t.suggestion_equals),
 'none',jsonb_build_object('count',t.none_count,'dollars',t.none_dollars),
 'stops',coalesce((SELECT jsonb_object_agg(code,n) FROM stop_counts),'{}')) FROM totals t
$fn$;
REVOKE ALL ON FUNCTION public.match_shadow_report(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_shadow_report(int) TO service_role;
