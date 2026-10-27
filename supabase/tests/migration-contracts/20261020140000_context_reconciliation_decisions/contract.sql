-- Contract for 20261020140000_context_reconciliation_decisions (CTX-R1/R1b). The full
-- end-to-end proof (33 steps, 35 mutants) runs on its own fixture outside this repo; this
-- contract proves the promises against the real stacked schema, the live ladder triggers and the
-- party-roles trigger included. Every fixture write is rolled back.
\set ON_ERROR_STOP 1

-- 1. Shape: both tables exist with RLS on, no browser grant, and the store is append-only.
DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_reconciliation_decisions'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_placement_links'::regclass) THEN
    RAISE EXCEPTION 'recon contract: RLS is not on';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     AND (has_table_privilege('authenticated', 'public.context_reconciliation_decisions', 'SELECT')
          OR has_table_privilege('anon', 'public.context_placement_links', 'SELECT')
          OR has_function_privilege('authenticated', 'public.context_recon_record_decision(uuid,text,text,uuid[],text,uuid,text)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.context_job_view(uuid)', 'EXECUTE')
          OR has_sequence_privilege('authenticated', 'public.context_reconciliation_decisions_id_seq', 'USAGE')) THEN
    RAISE EXCEPTION 'recon contract: a browser role holds a grant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.business_events'::regclass
                 AND tgname = 'context_aa_recon_hold_decided' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'recon contract: hold trigger missing';
  END IF;
END $$;

BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, ghl_contact_id, created_at) VALUES
  ('7c000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'SWF-97001', 'recon-contract-1', '2026-09-01'),
  ('7c000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-97002', 'recon-contract-1', '2026-09-01'),
  ('7c000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'SWF-97003', 'recon-contract-2', '2026-09-01');
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('7c100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Contract staff', 'ops_manager'),
  ('7c100000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Contract trade', 'lead_installer');
INSERT INTO public.business_events (id, channel, direction, occurred_at, contact_id, payload, event_type, source)
VALUES ('7c200000-0000-0000-0000-000000000001', 'sms', 'inbound', '2026-10-18 01:00Z', 'recon-contract-1',
        '{"body":"What time tomorrow?"}', 'sms.inbound', 'recon-contract');
-- Put the row in the queue the way the ladder leaves an ambiguous message.
UPDATE public.business_events SET job_id = NULL, attribution_status = 'unplaced',
  candidate_job_ids = ARRAY['7c000000-0000-0000-0000-00000000000a', '7c000000-0000-0000-0000-00000000000b']::uuid[]
WHERE id = '7c200000-0000-0000-0000-000000000001';

DO $$
DECLARE ev uuid := '7c200000-0000-0000-0000-000000000001'; h text; d bigint;
  a uuid := '7c000000-0000-0000-0000-00000000000a'; b uuid := '7c000000-0000-0000-0000-00000000000b';
  c uuid := '7c000000-0000-0000-0000-00000000000c'; staff uuid := '7c100000-0000-0000-0000-000000000001';
  held_before bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.context_recon_queue('2026-10-20 05:00Z') WHERE event_id = ev
                 AND cause = 'ambiguity:several_candidates') THEN
    RAISE EXCEPTION 'recon contract: ambiguous row not queued as several candidates';
  END IF;
  h := public.context_recon_evidence_hash(ev);

  -- 2. The writer refuses a non-staff person, no person, a stale hash and a job never offered.
  BEGIN PERFORM public.context_recon_record_decision(ev, h, 'confirm', ARRAY[a], 'ambiguity:several_candidates', '7c100000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'recon contract: trade recorded a decision'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.context_recon_record_decision(ev, h, 'confirm', ARRAY[a], 'ambiguity:several_candidates', NULL);
    RAISE EXCEPTION 'recon contract: no person recorded a decision'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.context_recon_record_decision(ev, md5('stale'), 'confirm', ARRAY[a], 'ambiguity:several_candidates', staff);
    RAISE EXCEPTION 'recon contract: stale hash accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END;
  BEGIN PERFORM public.context_recon_record_decision(ev, h, 'confirm', ARRAY[c], 'ambiguity:several_candidates', staff);
    RAISE EXCEPTION 'recon contract: unoffered job accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

  -- 3. A staff decision places the row by a person and takes it out of the queue.
  d := public.context_recon_record_decision(ev, h, 'confirm', ARRAY[b], 'ambiguity:several_candidates', staff);
  IF (SELECT job_ids FROM public.context_recon_placement(ev)) IS DISTINCT FROM ARRAY[b] THEN
    RAISE EXCEPTION 'recon contract: decision does not place the row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.context_recon_queue() WHERE event_id = ev) THEN
    RAISE EXCEPTION 'recon contract: decided row still queued';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.context_event_jobs(ev) WHERE job_id = b AND placement = 'certain' AND by = 'person') THEN
    RAISE EXCEPTION 'recon contract: row does not read certain by a person';
  END IF;

  -- 4. Append-only.
  BEGIN UPDATE public.context_reconciliation_decisions SET cause = 'x' WHERE id = d;
    RAISE EXCEPTION 'recon contract: decision updated'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN DELETE FROM public.context_reconciliation_decisions WHERE id = d;
    RAISE EXCEPTION 'recon contract: decision deleted'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;

  -- 5. Hold (verify V-1): an update that agrees with the decision goes through.
  UPDATE public.business_events SET job_id = b, attribution_status = 'single_open' WHERE id = ev;
  IF (SELECT job_id FROM public.business_events WHERE id = ev) IS DISTINCT FROM b
     OR (SELECT metadata ? 'recon_held' FROM public.business_events WHERE id = ev) THEN
    RAISE EXCEPTION 'recon contract: agreeing update was held';
  END IF;

  -- 6. One that disagrees is held on the decided job and stamped, never silently.
  held_before := (public.context_recon_health('2026-01-01') ->> 'held_total')::bigint;
  UPDATE public.business_events SET job_id = a, attribution_status = 'luna' WHERE id = ev;
  IF (SELECT job_id FROM public.business_events WHERE id = ev) IS DISTINCT FROM b
     OR (SELECT attribution_status FROM public.business_events WHERE id = ev) IS DISTINCT FROM 'single_open' THEN
    RAISE EXCEPTION 'recon contract: disagreeing update was not held';
  END IF;
  IF (SELECT metadata -> 'recon_held' ->> 'tried_job_id' FROM public.business_events WHERE id = ev) IS DISTINCT FROM a::text
     OR (SELECT (metadata -> 'recon_held' ->> 'decision_id')::bigint FROM public.business_events WHERE id = ev) IS DISTINCT FROM d THEN
    RAISE EXCEPTION 'recon contract: held update not stamped';
  END IF;
  IF (public.context_recon_health('2026-01-01') ->> 'held_total')::bigint <> held_before + 1 THEN
    RAISE EXCEPTION 'recon contract: health does not count the held row';
  END IF;

  -- 6b. Keeping the job but turning a linked status unlinked is a move away too (verify V-5).
  UPDATE public.business_events SET attribution_status = 'unplaced' WHERE id = ev;
  IF (SELECT attribution_status FROM public.business_events WHERE id = ev) IS DISTINCT FROM 'single_open'
     OR (SELECT metadata -> 'recon_held' ->> 'tried_status' FROM public.business_events WHERE id = ev) IS DISTINCT FROM 'unplaced' THEN
    RAISE EXCEPTION 'recon contract: same-job unlinking update was not held';
  END IF;
  -- A status change that stays linked on the same job passes.
  UPDATE public.business_events SET attribution_status = 'luna' WHERE id = ev;
  IF (SELECT attribution_status FROM public.business_events WHERE id = ev) IS DISTINCT FROM 'luna' THEN
    RAISE EXCEPTION 'recon contract: same-job linked status change was held';
  END IF;

  -- 7. Changed evidence releases the hold and puts the row back in the queue.
  UPDATE public.business_events SET payload = jsonb_set(payload, '{body}', '"What time tomorrow for the patio?"') WHERE id = ev;
  IF (SELECT state FROM public.context_recon_decision_state(ev)) IS DISTINCT FROM 'evidence_changed'
     OR NOT EXISTS (SELECT 1 FROM public.context_recon_queue() WHERE event_id = ev) THEN
    RAISE EXCEPTION 'recon contract: changed evidence did not reopen the row';
  END IF;
  UPDATE public.business_events SET job_id = a, attribution_status = 'luna' WHERE id = ev;
  IF (SELECT job_id FROM public.business_events WHERE id = ev) IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'recon contract: hold applied to changed evidence';
  END IF;

  -- 8. The evidence keys cover call times and transcript turns (verify V-2).
  IF NOT (public.context_recon_evidence_keys() @> ARRAY['start_time', 'turns', 'words', 'due_date']) THEN
    RAISE EXCEPTION 'recon contract: evidence keys incomplete';
  END IF;
END $$;
ROLLBACK;

-- 9. The near-match reads candidate_job_ids by containment, so the GIN index can serve it (verify V-3).
DO $$
BEGIN
  IF position('candidate_job_ids @> ARRAY[p_job]' IN pg_get_functiondef('public.context_job_view(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'recon contract: job view does not use containment on candidate_job_ids';
  END IF;
END $$;

-- 10. INT-14 (Integrated Job Framework, case a): a Context decision linking invoice evidence to
-- a job never moves revenue. The rule, shared with the CFO side (#1163,
-- docs/invoice-job-link-rule.md, case b is xero-sync's links), verbatim:
--   "An invoice→job decision decides only which job an invoice counts on, never its money:
--    total, amount due, amount paid and status come only from Xero's own record. xero-sync's
--    reference and exact client-name links may set the job on an invoice that has none, and
--    never move one already on a job. A Context decision never writes the invoice row, so it
--    never moves revenue."
-- Here a person decides a payment row onto job B while the mirror has the invoice on job A:
-- the row reads on B, the money stays on A, and the invoice row is unchanged.
BEGIN;
INSERT INTO public.jobs (id, org_id, type, status, job_number, ghl_contact_id, created_at) VALUES
  ('7c000000-0000-0000-0000-0000000014a0', '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'SWF-97014', 'int14-contract', '2026-09-01'),
  ('7c000000-0000-0000-0000-0000000014b0', '00000000-0000-0000-0000-000000000001', 'patio', 'accepted', 'SWP-97015', 'int14-contract', '2026-09-01');
INSERT INTO public.users (id, org_id, name, role) VALUES
  ('7c100000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'INT-14 staff', 'ops_manager');
INSERT INTO public.xero_invoices (id, org_id, xero_invoice_id, job_id, invoice_number, reference, invoice_type,
                                  status, total, amount_due, amount_paid, raw_json)
VALUES ('7c300000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001',
        '7c3a0000-0000-0000-0000-000000000014', '7c000000-0000-0000-0000-0000000014a0', 'INV-97014',
        'SWF-97014', 'ACCREC', 'AUTHORISED', 1100, 600, 500,
        '{"Status":"AUTHORISED","AmountCredited":0,"Payments":[{"Date":"2026-10-10","Amount":500}]}');
INSERT INTO public.business_events (id, channel, direction, occurred_at, contact_id, payload, event_type, source,
                                    entity_type, entity_id)
VALUES ('7c200000-0000-0000-0000-000000000014', 'xero', 'inbound', '2026-10-10 02:00Z', 'int14-contract',
        '{"invoice_number":"INV-97014","amount":500}', 'invoice.payment_received', 'int14-contract',
        'invoice', '7c300000-0000-0000-0000-000000000014');
UPDATE public.business_events SET job_id = NULL, attribution_status = 'unplaced',
  candidate_job_ids = ARRAY['7c000000-0000-0000-0000-0000000014a0', '7c000000-0000-0000-0000-0000000014b0']::uuid[]
WHERE id = '7c200000-0000-0000-0000-000000000014';

DO $$
DECLARE ev uuid := '7c200000-0000-0000-0000-000000000014'; inv uuid := '7c300000-0000-0000-0000-000000000014';
  a uuid := '7c000000-0000-0000-0000-0000000014a0'; b uuid := '7c000000-0000-0000-0000-0000000014b0';
  staff uuid := '7c100000-0000-0000-0000-000000000014'; before_row jsonb; d bigint;
BEGIN
  SELECT to_jsonb(x) INTO before_row FROM public.xero_invoices x WHERE x.id = inv;
  d := public.context_recon_record_decision(ev, public.context_recon_evidence_hash(ev), 'correct', ARRAY[b],
                                            'ambiguity:several_candidates', staff);
  -- The evidence row reads on B, by a person.
  IF NOT EXISTS (SELECT 1 FROM public.context_event_jobs(ev) WHERE job_id = b AND placement = 'certain' AND by = 'person') THEN
    RAISE EXCEPTION 'INT-14 contract: the decision did not place the invoice evidence on job B';
  END IF;
  -- The invoice row is unchanged: job, amount, status, amount_due, payment, everything.
  IF (SELECT to_jsonb(x) FROM public.xero_invoices x WHERE x.id = inv) IS DISTINCT FROM before_row THEN
    RAISE EXCEPTION 'INT-14 contract: a Context decision changed the invoice row';
  END IF;
  -- The money stays on A, from Xero's record, and never appears on B.
  IF NOT EXISTS (SELECT 1 FROM public.context_job_owed_lines(ARRAY[a]) l WHERE l.invoice_id = inv AND l.due = 600) THEN
    RAISE EXCEPTION 'INT-14 contract: the invoice''s money left job A';
  END IF;
  IF EXISTS (SELECT 1 FROM public.context_job_owed_lines(ARRAY[b]) l WHERE l.invoice_id = inv) THEN
    RAISE EXCEPTION 'INT-14 contract: the decision moved the invoice''s money onto job B';
  END IF;
  IF (public.context_job_view(b) ->> 'owed_due')::numeric <> 0
     OR jsonb_array_length(public.context_job_view(b) -> 'money') <> 0 THEN
    RAISE EXCEPTION 'INT-14 contract: job B''s view shows the invoice''s money';
  END IF;
  -- The writer touches only the decision and link tables (static, so a new write is caught too).
  IF pg_get_functiondef('public.context_recon_record_decision(uuid,text,text,uuid[],text,uuid,text)'::regprocedure)
     ~* '(update|insert\s+into|delete\s+from)\s+(public\.)?(xero_invoices|xero_payments|jobs)\M' THEN
    RAISE EXCEPTION 'INT-14 contract: the decision writer writes an invoice, payment or job row';
  END IF;
END $$;
ROLLBACK;
