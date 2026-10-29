-- Before the down: one bill held for the second check, one placed with keys.
\set ON_ERROR_STOP on
INSERT INTO public.materials_ai_placements (xero_invoice_id, decision, job_id, job_number, confidence, reason, model, outcome,
  second_check_status, agreed_keys, held_at)
VALUES ('TK-RB-HELD', 'job', 'b2000000-0000-4000-8000-000000000001', 'SWF-29001', 0.95, 'held', 'test-model', 'held_for_check',
  'due', ARRAY['ai_confidence'], now()),
       ('TK-RB-KEYED', 'job', 'b2000000-0000-4000-8000-000000000001', 'SWF-29001', 0.95, 'keyed', 'test-model', 'placed',
  'not_needed', ARRAY['ai_confidence', 'job_number'], NULL);
