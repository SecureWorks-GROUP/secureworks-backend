-- Before the down: one bill held for the second check, one the second check
-- disagreed on (left for a person, held_at kept), both still open in Bills to
-- place, and one placed with keys. The reader is on.
\set ON_ERROR_STOP on
UPDATE public.materials_ai_settings SET enabled = true, updated_by = 'test' WHERE id;
INSERT INTO public.materials_ai_placements (xero_invoice_id, decision, job_id, job_number, confidence, reason, model, outcome,
  second_check_status, agreed_keys, held_at)
VALUES ('TK-RB-HELD', 'job', 'b2000000-0000-4000-8000-000000000001', 'SWF-29001', 0.95, 'held', 'test-model', 'held_for_check',
  'due', ARRAY['ai_confidence'], now()),
       ('TK-RB-DIS', 'job', 'b2000000-0000-4000-8000-000000000001', 'SWF-29001', 0.95, 'disagreed', 'test-model', 'left_for_person',
  'disagreed', ARRAY['ai_confidence'], now()),
       ('TK-RB-KEYED', 'job', 'b2000000-0000-4000-8000-000000000001', 'SWF-29001', 0.95, 'keyed', 'test-model', 'placed',
  'not_needed', ARRAY['ai_confidence', 'job_number'], NULL);
INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, contact_name, sub_total, total, invoice_date, status)
VALUES ('TK-RB-HELD', 'TKB-RB-HELD', 'Key Steel', 300, 330, '2026-08-21', 'open'),
       ('TK-RB-DIS', 'TKB-RB-DIS', 'Key Steel', 310, 341, '2026-08-21', 'open');
