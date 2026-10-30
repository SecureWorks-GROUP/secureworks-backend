-- Break: the block reads a bill the H7 read calls unknown as counted here, the
-- kind of re-derivation this migration forbids. The contract must catch it.
CREATE OR REPLACE FUNCTION public.context_job_story_bill_outcomes(p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $b$
 SELECT jsonb_build_object('version', 'story-bill-outcomes-v1', 'job_id', p_job_id, 'source', 'context_job_bill_outcomes',
  'contract_version', 'cfo-bill-cost-outcome-v1', 'status', 'ok', 'refused', NULL, 'outcome', NULL, 'digest', md5(p_job_id::text),
  'bills', (SELECT jsonb_agg(jsonb_build_object('xero_invoice_id', e.value ->> 'xero_invoice_id', 'invoice_number', e.value ->> 'invoice_number',
     'supplier', e.value ->> 'supplier', 'bill_status', e.value ->> 'bill_status',
     'where_counted', replace(e.value ->> 'where_counted', 'unknown', 'here'), 'reason', CASE WHEN e.value ->> 'where_counted' = 'held' THEN e.value ->> 'held_reason' ELSE e.value #>> '{here,reason}' END,
     'bill_state', e.value ->> 'bill_state', 'mirror_bill', e.value -> 'mirror_bill', 'held_reason', e.value ->> 'held_reason',
     'other_jobs', (SELECT coalesce(jsonb_agg(jsonb_build_object('job_number', o.value ->> 'job_number', 'counts', o.value ->> 'counts')
       ORDER BY o.value ->> 'job_number' COLLATE "C"), '[]'::jsonb) FROM jsonb_array_elements(e.value -> 'other_jobs') o), 'outcome', CASE WHEN e.value ->> 'where_counted' = 'held' THEN 'held: ' || (e.value ->> 'held_reason')
       ELSE replace(e.value ->> 'where_counted', 'unknown', 'here') END)
     ORDER BY e.value ->> 'invoice_number' COLLATE "C", e.value ->> 'xero_invoice_id' COLLATE "C")
   FROM jsonb_array_elements(public.context_job_bill_outcomes(p_job_id) -> 'bills') e))
 WHERE p_job_id IS NOT NULL AND jsonb_array_length(coalesce(public.context_job_bill_outcomes(p_job_id) -> 'bills', '[]'::jsonb)) > 0
$b$;
