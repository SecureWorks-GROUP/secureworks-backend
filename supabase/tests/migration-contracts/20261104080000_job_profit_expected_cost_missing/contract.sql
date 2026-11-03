-- Contract for 20261104080000_job_profit_expected_cost_missing (finish-line row A6).
--
-- Synthetic jobs, no customer or staff data. Everything rolls back.
--   A6X-MS   make-safe from 'Synthetic Builders Pty' with its works order and a make-safe invoice basis
--            -> builder_job_no_costing, both documents named, "set what Synthetic Builders Pty pays us"
--   A6X-RP   repair with the builder's works order only -> builder_job_no_costing, "sets what the builder pays us"
--   A6X-RN   repair with no works order and no requesting company -> no_costing (not called a builder job)
--   A6X-IN   insurance with nothing on it -> builder_job_no_costing, no document named
--   A6X-P1   patio, sealed revision 2 with a RATE_MISSING warning -> sealed_scope_rate_missing naming the line
--   A6X-P2   patio, sealed revision 1 selling 'Shed Door' at no cost -> sealed_scope_line_without_cost
--   A6X-P3   patio, sealed revision 1 fully priced -> expected_source frozen_scope_revision, nothing missing
--   A6X-P4   patio, its only sealed revision superseded by a draft -> no_current_sealed_scope
--   A6X-F1   fence, quote Q-9001 sent 24 Mar 2026 with no quote revision -> quote_without_cost_record
--   A6X-F2   fence, a sent quote revision with cost figures -> expected_source sent_quote_revision, nothing missing
--   A6X-F3   fence, nothing on it -> no_quote
--   SWB-90001 build (patio) with a CRM value and nothing else -> no_contract, CRM named
--   Switch job_profit_patio_expected_from_frozen_scope off: A6X-P1 -> sealed_scope_switch_off.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.organisations (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Synthetic org')
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.feature_flags WHERE flag_name = 'job_profit_patio_expected_from_frozen_scope';
INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('job_profit_patio_expected_from_frozen_scope', true);

INSERT INTO public.jobs (id, org_id, status, type, job_number, metadata, pricing_json, created_at) VALUES
  ('a6080000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'processing', 'makesafe', 'A6X-MS', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'processing', 'repair', 'A6X-RP', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'processing', 'repair', 'A6X-RN', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'processing', 'insurance', 'A6X-IN', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio', 'A6X-P1', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio', 'A6X-P2', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio', 'A6X-P3', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000001', 'order_materials', 'patio', 'A6X-P4', '{}', '{}', '2026-08-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000021', '00000000-0000-0000-0000-000000000001', 'rectification', 'fencing', 'A6X-F1', '{}', '{}', '2026-03-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000022', '00000000-0000-0000-0000-000000000001', 'rectification', 'fencing', 'A6X-F2', '{}', '{}', '2026-06-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000023', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'A6X-F3', '{}', '{}', '2026-06-01T00:00:00Z'),
  ('a6080000-0000-4000-8000-000000000031', '00000000-0000-0000-0000-000000000001', 'in_progress', 'patio', 'SWB-90001', '{}',
   '{"source": "ghl", "totalExGST": 4545.45, "totalIncGST": 5000}', '2026-04-01T00:00:00Z');

INSERT INTO public.makesafe_companies (id, slug, name) VALUES
  ('a6080000-0000-4000-8000-0000000000c1', 'synthetic-a6x', 'Synthetic Builders Pty');
INSERT INTO public.makesafe_job_details (job_id, requesting_company_slug, requesting_company_name, requesting_company_id) VALUES
  ('a6080000-0000-4000-8000-000000000001', 'synthetic-a6x', 'sb', 'a6080000-0000-4000-8000-0000000000c1');
INSERT INTO public.job_documents (job_id, type, version, file_name, created_at) VALUES
  ('a6080000-0000-4000-8000-000000000001', 'work_order', 1, 'Works Order.pdf', '2026-08-01T01:00:00Z'),
  ('a6080000-0000-4000-8000-000000000002', 'work_order', 1, 'work_order_SYN-1PO-1.pdf', '2026-08-01T01:00:00Z');
INSERT INTO public.makesafe_docket_revisions (job_id) VALUES ('a6080000-0000-4000-8000-000000000001');

INSERT INTO public.scope_revisions (id, job_id, revision_number, tool_kind, status, scope_hash, pricing_hash, scope_canonical_text, frozen_at) VALUES
  ('a6081000-0000-4000-8000-000000000011', 'a6080000-0000-4000-8000-000000000011', 2, 'patio', 'frozen', repeat('a', 64), repeat('b', 64),
   '{"_pricing_json": {"labourCostEstimate": 1000, "materialCostEstimate": 2000, "commissionCostEstimate": 300, "pricing_warnings": [{"code": "RATE_MISSING", "context": "Fascia Brackets"}], "line_items": [{"description": "Roof", "total_sell": 5000, "total_cost": 2000}]}}',
   '2026-08-10T00:00:00Z'),
  ('a6081000-0000-4000-8000-000000000012', 'a6080000-0000-4000-8000-000000000012', 1, 'patio', 'frozen', repeat('c', 64), repeat('d', 64),
   '{"_pricing_json": {"labourCostEstimate": 1000, "materialCostEstimate": 2000, "commissionCostEstimate": 300, "pricing_warnings": [], "line_items": [{"description": "Roof", "total_sell": 5000, "total_cost": 2000}, {"description": "Shed Door", "total_sell": 500, "total_cost": 0}]}}',
   '2026-08-10T00:00:00Z'),
  ('a6081000-0000-4000-8000-000000000013', 'a6080000-0000-4000-8000-000000000013', 1, 'patio', 'frozen', repeat('e', 64), repeat('f', 64),
   '{"_pricing_json": {"labourCostEstimate": 1000, "materialCostEstimate": 2000, "commissionCostEstimate": 300, "pricing_warnings": [], "line_items": [{"description": "Roof", "total_sell": 5000, "total_cost": 2000}]}}',
   '2026-08-10T00:00:00Z'),
  ('a6081000-0000-4000-8000-000000000014', 'a6080000-0000-4000-8000-000000000014', 1, 'patio', 'frozen', repeat('1', 64), repeat('2', 64),
   '{"_pricing_json": {"labourCostEstimate": 1000, "materialCostEstimate": 2000, "commissionCostEstimate": 300, "pricing_warnings": [], "line_items": []}}',
   '2026-08-10T00:00:00Z');
INSERT INTO public.scope_revisions (id, job_id, revision_number, tool_kind, status, scope_canonical_text) VALUES
  ('a6081000-0000-4000-8000-000000000015', 'a6080000-0000-4000-8000-000000000014', 2, 'patio', 'draft', '{}');
UPDATE public.scope_revisions
   SET status = 'superseded', superseded_at = '2026-08-11T00:00:00Z',
       superseded_by_scope_revision_id = 'a6081000-0000-4000-8000-000000000015'
 WHERE id = 'a6081000-0000-4000-8000-000000000014';

INSERT INTO public.job_documents (id, job_id, type, version, quote_number, sent_at, created_at) VALUES
  ('a6082000-0000-4000-8000-000000000021', 'a6080000-0000-4000-8000-000000000021', 'quote', 1, 'Q-9001', '2026-03-24T02:00:00Z', '2026-03-24T01:59:00Z'),
  ('a6082000-0000-4000-8000-000000000022', 'a6080000-0000-4000-8000-000000000022', 'quote', 1, 'Q-9002', '2026-06-19T07:52:55Z', '2026-06-19T07:52:35Z');
INSERT INTO public.quote_revisions (job_id, job_document_id, version, totals_snapshot_json, released_via, sent_at, internal_cost_snapshot_json) VALUES
  ('a6080000-0000-4000-8000-000000000022', 'a6082000-0000-4000-8000-000000000022', 1,
   '{"total_ex_gst": 3385, "total_inc_gst": 3723.5}', 'send-quote/send', '2026-06-19T07:52:55Z',
   '{"cost_estimates": {"labour_total": 595, "material_total": 1411.5, "subcontract_commission_total": 206.775}}');

CREATE TEMP TABLE w_jp ON COMMIT DROP AS
SELECT p.job_number, p.expected_source, p.expected_cost_ex, p.expected_cost_missing
  FROM public.v_job_profit p
 WHERE p.job_id::text LIKE 'a6080000-0000-4000-8000-%';

DO $$
DECLARE
  r record;
  m jsonb;
BEGIN
  IF (SELECT count(*) FROM w_jp) <> 12 THEN
    RAISE EXCEPTION 'expected cost missing contract: % synthetic jobs in v_job_profit, not 12', (SELECT count(*) FROM w_jp);
  END IF;
  -- Named exactly when there is no expected cost, never beside one.
  FOR r IN SELECT * FROM w_jp LOOP
    IF (r.expected_source IS NULL) <> (r.expected_cost_missing IS NOT NULL) THEN
      RAISE EXCEPTION 'expected cost missing contract: % has expected_source % and expected_cost_missing %',
        r.job_number, r.expected_source, r.expected_cost_missing;
    END IF;
    IF r.expected_cost_missing IS NOT NULL AND NOT (r.expected_cost_missing ?& ARRAY['code', 'document', 'holder']) THEN
      RAISE EXCEPTION 'expected cost missing contract: % names % without code, document and holder', r.job_number, r.expected_cost_missing;
    END IF;
    IF r.expected_cost_missing::text ~ '[–—]' THEN
      RAISE EXCEPTION 'expected cost missing contract: % text carries a dash staff must not read: %', r.job_number, r.expected_cost_missing;
    END IF;
  END LOOP;

  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-MS';
  IF m ->> 'code' <> 'builder_job_no_costing'
     OR position('the builder''s works order and the make-safe invoice basis' IN m ->> 'document') = 0
     OR position('set what Synthetic Builders Pty pays us, not our cost' IN m ->> 'document') = 0
     OR position('Marnin' IN m ->> 'holder') = 0 OR position('Shaun approves it' IN m ->> 'holder') = 0 THEN
    RAISE EXCEPTION 'expected cost missing contract: make-safe A6X-MS named %', m;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-RP';
  IF m ->> 'code' <> 'builder_job_no_costing'
     OR position('the builder''s works order on the job sets what the builder pays us' IN m ->> 'document') = 0 THEN
    RAISE EXCEPTION 'expected cost missing contract: repair A6X-RP named %', m;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-RN';
  IF m ->> 'code' <> 'no_costing' THEN
    RAISE EXCEPTION 'expected cost missing contract: a repair with no builder document A6X-RN named %', m;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-IN';
  IF m ->> 'code' <> 'builder_job_no_costing' OR (m ->> 'document') LIKE '%pays us%' THEN
    RAISE EXCEPTION 'expected cost missing contract: insurance A6X-IN named %', m;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-P1';
  IF m ->> 'code' <> 'sealed_scope_rate_missing'
     OR (m ->> 'document') <> 'Sealed scope revision 2 sealed again with every rate: a rate is missing for Fascia Brackets'
     OR (m ->> 'holder') NOT LIKE 'The salesperson who scoped it%' THEN
    RAISE EXCEPTION 'expected cost missing contract: patio A6X-P1 named %', m;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-P2';
  IF m ->> 'code' <> 'sealed_scope_line_without_cost' OR position('Shed Door sells with no cost' IN m ->> 'document') = 0 THEN
    RAISE EXCEPTION 'expected cost missing contract: patio A6X-P2 named %', m;
  END IF;
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6X-P3';
  IF r.expected_source IS DISTINCT FROM 'frozen_scope_revision' OR r.expected_cost_ex IS DISTINCT FROM 3300::numeric
     OR r.expected_cost_missing IS NOT NULL THEN
    RAISE EXCEPTION 'expected cost missing contract: priced patio A6X-P3 reads % % %', r.expected_source, r.expected_cost_ex, r.expected_cost_missing;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-P4';
  IF m ->> 'code' <> 'no_current_sealed_scope' THEN
    RAISE EXCEPTION 'expected cost missing contract: patio with only a superseded revision A6X-P4 named %', m;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-F1';
  IF m ->> 'code' <> 'quote_without_cost_record'
     OR position('The cost record behind quote Q-9001 sent 24 Mar 2026' IN m ->> 'document') = 0 THEN
    RAISE EXCEPTION 'expected cost missing contract: fence A6X-F1 named %', m;
  END IF;
  SELECT * INTO r FROM w_jp WHERE job_number = 'A6X-F2';
  IF r.expected_source IS DISTINCT FROM 'sent_quote_revision' OR r.expected_cost_ex IS DISTINCT FROM 2213.275
     OR r.expected_cost_missing IS NOT NULL THEN
    RAISE EXCEPTION 'expected cost missing contract: quoted fence A6X-F2 reads % % %', r.expected_source, r.expected_cost_ex, r.expected_cost_missing;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'A6X-F3';
  IF m ->> 'code' <> 'no_quote' THEN
    RAISE EXCEPTION 'expected cost missing contract: fence with nothing A6X-F3 named %', m;
  END IF;
  SELECT expected_cost_missing INTO m FROM w_jp WHERE job_number = 'SWB-90001';
  IF m ->> 'code' <> 'no_contract' OR position('the job value came from the CRM, not a quote' IN m ->> 'document') = 0 THEN
    RAISE EXCEPTION 'expected cost missing contract: build SWB-90001 named %', m;
  END IF;
END $$;

-- job_profit(uuid) returns the view's row, the new column included.
DO $$
BEGIN
  IF (SELECT p.expected_cost_missing ->> 'code' FROM public.job_profit('a6080000-0000-4000-8000-000000000001') p) IS DISTINCT FROM 'builder_job_no_costing' THEN
    RAISE EXCEPTION 'expected cost missing contract: job_profit(uuid) does not carry expected_cost_missing';
  END IF;
END $$;

-- The switch off: a sealed patio revision is named as unread for that reason.
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_profit_patio_expected_from_frozen_scope';
DO $$
DECLARE
  m jsonb;
BEGIN
  SELECT p.expected_cost_missing INTO m FROM public.v_job_profit p WHERE p.job_id = 'a6080000-0000-4000-8000-000000000011';
  IF m ->> 'code' IS DISTINCT FROM 'sealed_scope_switch_off' OR position('Marnin' IN m ->> 'holder') = 0 THEN
    RAISE EXCEPTION 'expected cost missing contract: with the switch off A6X-P1 named %', m;
  END IF;
END $$;

-- Read only for the service role; never for anon or authenticated.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND has_function_privilege('anon', 'public.job_profit_expected_cost_missing(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'expected cost missing contract: anon may run job_profit_expected_cost_missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND has_function_privilege('authenticated', 'public.job_profit_expected_cost_missing(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'expected cost missing contract: authenticated may run job_profit_expected_cost_missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND NOT has_function_privilege('service_role', 'public.job_profit_expected_cost_missing(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'expected cost missing contract: service_role may not run job_profit_expected_cost_missing';
  END IF;
END $$;

ROLLBACK;
