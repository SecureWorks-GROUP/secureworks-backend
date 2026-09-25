-- Quote v2 stage 3 local proof fixture. DISPOSABLE LOCAL DATABASE ONLY
-- (scripts/quote-v2/test-server-build-local.sh). Four local job rows and a
-- few price book rows marked as test data. Nothing here is a production write.
INSERT INTO public.jobs (id, org_id, status, type, job_number, site_suburb) VALUES
  ('00000000-0000-4000-8000-000000261423', '00000000-0000-0000-0000-000000000001', 'draft', 'fencing', 'SWF-261423', 'Gwelup'),
  ('00000000-0000-4000-8000-000000026051', '00000000-0000-0000-0000-000000000001', 'draft', 'patio', 'SWP-26051', 'Canning Vale'),
  ('00000000-0000-4000-8000-00000000c1c0', '00000000-0000-0000-0000-000000000001', 'draft', 'miscellaneous', 'KIKO-DRAFT', 'Balcatta'),
  ('00000000-0000-4000-8000-0000000000b0', '00000000-0000-0000-0000-000000000001', 'draft', 'patio', 'TEST-PB-1', 'Testville');

INSERT INTO public.price_book_items (item_key, family, category, description, unit, created_by) VALUES
  ('steel-rhs-100x50x2', 'patio', 'steel', 'RHS 100x50x2.0 galvanised', 'lm', 'quote-v2-proof'),
  ('patio-post-90x90', 'patio', 'steel', 'Post SHS 90x90x2.0, 3.0 m', 'each', 'quote-v2-proof');
INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, per_length_mm, as_at, evidence_kind, evidence_ref, recorded_by) VALUES
  ('steel-rhs-100x50x2', 'BD Metals', 26.5738, 6500, '2026-01-27', 'invoice', 'local proof: invoice 00022187 rate', 'quote-v2-proof'),
  ('steel-rhs-100x50x2', 'BD Metals', 28.9091, 5500, '2026-01-27', 'invoice', 'local proof: 5.5 m length rate', 'quote-v2-proof'),
  ('steel-rhs-100x50x2', 'BD Metals', 26.1000, 8000, '2026-01-27', 'invoice', 'local proof: 8.0 m length rate', 'quote-v2-proof'),
  ('patio-post-90x90', 'BD Metals', 118.5000, NULL, '2026-01-27', 'invoice', 'local proof: post price', 'quote-v2-proof');
INSERT INTO public.price_book_stock_lengths (item_key, supplier, lengths_mm, as_at, evidence_kind, evidence_ref, recorded_by) VALUES
  ('steel-rhs-100x50x2', 'BD Metals', ARRAY[5500, 6500, 8000], '2026-01-27', 'tool_constant', 'local proof: patio tool stock list', 'quote-v2-proof');
INSERT INTO public.price_book_cut_rules (item_key, rule, kerf_mm, as_at, evidence_kind, evidence_ref, recorded_by) VALUES
  ('steel-rhs-100x50x2', 'one_per_stick', 3, '2026-01-27', 'tool_constant', 'local proof: beams one per stick', 'quote-v2-proof');
