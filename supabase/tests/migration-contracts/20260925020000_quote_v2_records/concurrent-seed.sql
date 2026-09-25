-- PB-10 race fixture: two proposals for ONE subject (item + supplier), both
-- captured against the same current row. Committed, because two sessions
-- must see it; every name is unique to this proof.
INSERT INTO public.price_book_items (item_key, family, category, description, unit, created_by)
VALUES ('pb10-subject-lock-item', 'misc', 'contract-test', 'PB-10 subject lock proof', 'each', 'concurrent-seed');
INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at, evidence_kind, evidence_ref, recorded_by)
VALUES ('pb10-subject-lock-item', 'PB10 Proof Supplier', 10, '2026-09-01', 'invoice', 'pb10-seed', 'concurrent-seed');
INSERT INTO public.price_book_approvers (scope_kind, scope_value, approver, active, recorded_by)
VALUES ('supplier', 'PB10 Proof Supplier', 'pb10-approver', true, 'concurrent-seed');
SELECT public.price_book_propose('cost',
  '{"item_key":"pb10-subject-lock-item","supplier":"PB10 Proof Supplier"}',
  '{"cost_ex_gst":11,"as_at":"2026-09-20","evidence_kind":"invoice"}', 'first proposal', 'pb10-proposal-a', 'proposer-a');
SELECT public.price_book_propose('cost',
  '{"item_key":"pb10-subject-lock-item","supplier":"PB10 Proof Supplier"}',
  '{"cost_ex_gst":12,"as_at":"2026-09-21","evidence_kind":"invoice"}', 'second proposal', 'pb10-proposal-b', 'proposer-b');
