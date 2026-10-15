-- Contract for 20261015090000_job_profit_quote_rule.
--
-- Synthetic jobs, fixed dates, no customer data. Everything rolls back.
--   JQ-SUP     a costed quote superseded by a current quote with no recorded
--              value: quoted is null, so the superseded quote's costs are no
--              expected cost either (was sent_quote_revision).
--   JQ-DEC     the only costed quote was declined: no quoted, no expected.
--   JQ-FROZEN  accepted, its expected cost frozen at acceptance, but the
--              accepted document carries no recorded value: expected stays
--              frozen_at_acceptance, quoted stays null.
--   JQ-LOG     the current quote's value is only in a quote.sent log row
--              (quote_sent_log_unverified), here 0: quoted is null, not 0.
--   JQ-SPLIT   quotes split by party, the whole-job total only in a logged
--              send-runs row, the client's run share recorded: quoted is
--              null, never the client's share in place of the job's quote.
--   JQ-OK      a current sent quote with a sealed total and costs: quoted and
--              expected both read it (control).
-- The 20261009130000 contract runs against this body too and still passes.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number, created_at) VALUES
  ('b1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'JQ-SUP', '2026-07-01T00:00:00Z'),
  ('b1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'lost', 'fencing', 'JQ-DEC', '2026-07-01T00:00:00Z'),
  ('b1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000001', 'scheduled', 'fencing', 'JQ-FROZEN', '2026-07-01T00:00:00Z'),
  ('b1000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000001', 'archived', 'fencing', 'JQ-LOG', '2026-07-01T00:00:00Z'),
  ('b1000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'JQ-SPLIT', '2026-07-01T00:00:00Z'),
  ('b1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000001', 'quoted', 'fencing', 'JQ-OK', '2026-07-01T00:00:00Z');

UPDATE public.jobs SET expected_costs = '{"lanes": {"labour": {"amount_ex_gst": 700}, "materials": {"amount_ex_gst": 900}, "commission": {"amount_ex_gst": 100}}}'
WHERE job_number = 'JQ-FROZEN';

INSERT INTO public.job_documents (id, job_id, type, sent_at, superseded_at, declined_at, accepted_at, created_at) VALUES
  -- JQ-SUP: v1 costed and superseded; v2 current with no revision
  ('b1300000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'quote', '2026-07-02T00:00:00Z', '2026-07-05T00:00:00Z', NULL, NULL, '2026-07-02T00:00:00Z'),
  ('b1300000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'quote', '2026-07-05T00:00:00Z', NULL, NULL, NULL, '2026-07-05T00:00:00Z'),
  -- JQ-DEC: declined
  ('b1300000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000002', 'quote', '2026-07-02T00:00:00Z', NULL, '2026-07-04T00:00:00Z', NULL, '2026-07-02T00:00:00Z'),
  -- JQ-FROZEN: accepted, no revision on it
  ('b1300000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000003', 'quote', '2026-07-02T00:00:00Z', NULL, NULL, '2026-07-03T00:00:00Z', '2026-07-02T00:00:00Z'),
  -- JQ-LOG: current, valued only by a quote.sent log row
  ('b1300000-0000-4000-8000-000000000005', 'b1000000-0000-4000-8000-000000000004', 'quote', '2026-07-02T00:00:00Z', NULL, NULL, NULL, '2026-07-02T00:00:00Z'),
  -- JQ-OK: current, sealed and costed
  ('b1300000-0000-4000-8000-000000000007', 'b1000000-0000-4000-8000-000000000006', 'quote', '2026-07-02T00:00:00Z', NULL, NULL, NULL, '2026-07-02T00:00:00Z');

-- JQ-SPLIT: the client's run document with its own share recorded.
INSERT INTO public.job_documents (id, job_id, type, run_label, sent_at, data_snapshot_json, created_at) VALUES
  ('b1300000-0000-4000-8000-000000000006', 'b1000000-0000-4000-8000-000000000005', 'quote', 'REAR', '2026-07-02T00:00:00Z',
   '{"run": {"totals": {"client_share_inc": 1965.07, "neighbour_share_inc": 2957.43}}}', '2026-07-02T00:00:00Z');

INSERT INTO public.quote_revisions (job_id, job_document_id, version, sent_at, released_via, totals_snapshot_json, internal_cost_snapshot_json) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'b1300000-0000-4000-8000-000000000001', 1, '2026-07-02T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 3300}', '{"cost_estimates": {"labour_total": 900, "material_total": 1200, "subcontract_commission_total": 150}}'),
  ('b1000000-0000-4000-8000-000000000002', 'b1300000-0000-4000-8000-000000000003', 1, '2026-07-02T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 2200}', '{"cost_estimates": {"labour_total": 500, "material_total": 700, "subcontract_commission_total": 80}}'),
  ('b1000000-0000-4000-8000-000000000006', 'b1300000-0000-4000-8000-000000000007', 1, '2026-07-02T00:00:00Z', 'send-quote/send',
   '{"total_inc_gst": 4400}', '{"cost_estimates": {"labour_total": 1000, "material_total": 1500, "subcontract_commission_total": 200}}');

INSERT INTO public.business_events (entity_type, entity_id, event_type, source, payload, metadata, occurred_at) VALUES
  ('job', 'b1000000-0000-4000-8000-000000000004', 'quote.sent', 'send-quote/send',
   '{"document_id": "b1300000-0000-4000-8000-000000000005", "total_inc_gst": 0}', '{}', '2026-07-02T00:00:00Z'),
  ('job', 'b1000000-0000-4000-8000-000000000005', 'quote.sent', 'send-quote/send-runs',
   '{"total_inc_gst": 4922.50}', '{}', '2026-07-02T00:00:00Z');

DO $$
DECLARE
  r record;
BEGIN
  -- The logged values really are what job_quote_values reports, so the view
  -- is what refuses them.
  PERFORM 1 FROM public.job_quote_values('b1000000-0000-4000-8000-000000000004')
   WHERE value_source = 'quote_sent_log_unverified' AND value_inc_gst = 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'jq setup: JQ-LOG log value not seen by job_quote_values'; END IF;
  PERFORM 1 FROM public.job_quote_values('b1000000-0000-4000-8000-000000000005')
   WHERE whole_quote_source = 'quote_sent_log_unverified' AND value_inc_gst = 1965.07;
  IF NOT FOUND THEN RAISE EXCEPTION 'jq setup: JQ-SPLIT logged whole total or run share not seen'; END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JQ-SUP';
  IF r.quoted_ex IS NOT NULL OR r.expected_source IS NOT NULL OR r.expected_cost_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jq sup: a superseded quote gave quoted % or expected % %', r.quoted_ex, r.expected_source, r.expected_cost_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JQ-DEC';
  IF r.quoted_ex IS NOT NULL OR r.expected_source IS NOT NULL OR r.expected_cost_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jq dec: a declined quote gave quoted % or expected % %', r.quoted_ex, r.expected_source, r.expected_cost_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JQ-FROZEN';
  IF r.expected_source IS DISTINCT FROM 'frozen_at_acceptance' OR r.expected_cost_ex IS DISTINCT FROM 1700 OR r.quoted_ex IS NOT NULL THEN
    RAISE EXCEPTION 'jq frozen: expected % % quoted %', r.expected_source, r.expected_cost_ex, r.quoted_ex;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JQ-LOG';
  IF r.quoted_ex IS NOT NULL OR r.quoted_source IS NOT NULL THEN
    RAISE EXCEPTION 'jq log: an unverified log value read as quoted % from %', r.quoted_ex, r.quoted_source;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JQ-SPLIT';
  IF r.quoted_ex IS NOT NULL OR r.quoted_source IS NOT NULL THEN
    RAISE EXCEPTION 'jq split: quoted % from % (a party share or a logged whole total stood in)', r.quoted_ex, r.quoted_source;
  END IF;

  SELECT * INTO r FROM public.v_job_profit WHERE job_number = 'JQ-OK';
  IF r.quoted_ex IS DISTINCT FROM 4000 OR r.quoted_source IS DISTINCT FROM 'sent_quote:newest_current:quote_revision'
     OR r.expected_source IS DISTINCT FROM 'sent_quote_revision' OR r.expected_cost_ex IS DISTINCT FROM 2700 THEN
    RAISE EXCEPTION 'jq ok: quoted % from %, expected % %', r.quoted_ex, r.quoted_source, r.expected_source, r.expected_cost_ex;
  END IF;
END $$;

ROLLBACK;
