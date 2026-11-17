-- P4-01.9: one read-only shape over the decisions already kept by each source.
CREATE OR REPLACE VIEW public.job_decision_log WITH (security_invoker = true) AS
SELECT job_id, at, 'note'::text AS subject_kind, item_id::text AS subject_id,
  coalesce(from_status, 'new') || ' to ' || to_status AS decision,
  by, coalesce(evidence, '[]'::jsonb) AS evidence,
  'context_ledger_transitions'::text AS source_table
FROM public.context_ledger_transitions
UNION ALL
SELECT CASE WHEN attribution_status IN ('luna','thread') THEN job_id ELSE NULL::uuid END,
  coalesce(attributed_at, attribution_checked_at), 'message', id::text,
  CASE WHEN attribution_status IN ('luna','thread') THEN 'placed'
    ELSE 'rested: ' || (metadata ->> 'luna_outcome') END,
  'model:place-message',
  jsonb_build_array(jsonb_build_object('table', 'jobs', 'ids', to_jsonb(candidate_job_ids))),
  'business_events'
FROM public.business_events WHERE metadata ? 'luna_outcome'
UNION ALL
SELECT job_id, coalesce(decided_at, created_at), 'money_action', id::text,
  action || ': ' || status,
  CASE WHEN decided_by IS NOT NULL THEN 'person:' || decided_by
    ELSE 'model:' || left(actor, 70) END,
  jsonb_build_array(jsonb_build_object('table', 'agent_action_proposals', 'id', id, 'params_sha256', params_sha256)),
  'agent_action_proposals'
FROM public.agent_action_proposals WHERE status <> 'observed'
UNION ALL
SELECT job_id, read_at, 'weekly_read', week::text,
  (jsonb_array_length(coalesce(marks, '[]'::jsonb)) + jsonb_array_length(coalesce(missing, '[]'::jsonb)))
    || ' wrong of ' || (story_total + notes_total),
  'person:' || read_by, coalesce(marks, '[]'::jsonb), 'job_truth_weekly_samples'
FROM public.job_truth_weekly_samples WHERE read_at IS NOT NULL;

REVOKE ALL ON public.job_decision_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.job_decision_log TO service_role;
COMMENT ON VIEW public.job_decision_log IS
  'Every decision in one shape: what, decided, by (person:, rule: or model:), evidence, when. Phase 2''s cost decisions use the same by form and can be added as a fifth select.';
