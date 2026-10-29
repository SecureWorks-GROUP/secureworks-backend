-- Before the down: an audit row already written with the two new keys. It must
-- stay as it is (20261029093000's keys check allows both names).
\set ON_ERROR_STOP on
INSERT INTO public.materials_ai_placements (xero_invoice_id, decision, job_id, job_number, confidence, reason, model, outcome,
  second_check_status, agreed_keys, key_evidence)
SELECT 'AK-RB-KEYED', 'job', j.id, j.job_number, 0.95, 'keyed', 'test-model', 'placed', 'not_needed',
       ARRAY['ai_confidence', 'site_address', 'same_supplier'], '{"site_address": "1 rollback st in reference"}'::jsonb
  FROM public.jobs j WHERE j.job_number IS NOT NULL ORDER BY j.job_number LIMIT 1;
