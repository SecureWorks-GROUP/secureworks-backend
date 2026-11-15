\set ON_ERROR_STOP on
-- In the registered stack the migration ran on no matching bills: it must have written nothing.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE assigned_by = 'marnin (approved list, migration 20261116003000)')
     OR EXISTS (SELECT 1 FROM public.materials_reconciliation_queue WHERE assigned_by = 'marnin (approved list, migration 20261116003000)')
     OR EXISTS (SELECT 1 FROM public.job_events WHERE detail_json ->> 'assigned_by' = 'marnin (approved list, migration 20261116003000)') THEN
    RAISE EXCEPTION 'SP-0: the migration wrote rows with no matching bills';
  END IF;
END $$;

BEGIN;
\ir fixtures.sql
-- One bill's own insert fails (as a fact landing from another route between check and insert
-- would): that bill alone is left as it was, the others still land, the migration does not fail.
CREATE FUNCTION pg_temp.sp_refuse_one() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF NEW.xero_invoice_id = '971fee47-2e4c-4da0-b92d-3575fed1a448' THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'sp fixture: duplicate fact';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER sp_refuse_one BEFORE INSERT ON public.job_materials_facts
  FOR EACH ROW EXECUTE FUNCTION pg_temp.sp_refuse_one();
\ir ../../../migrations/20261116003000_sep_reconcile_placements.sql
DROP TRIGGER sp_refuse_one ON public.job_materials_facts;

DO $$
DECLARE c text := 'marnin (approved list, migration 20261116003000)'; n int;
BEGIN
  -- SP-1 a materials bill is placed as Bills to place's Assign places it.
  IF NOT EXISTS (SELECT 1 FROM public.job_materials_facts f
                  WHERE f.xero_invoice_id = '48dd66ca-5e55-4d52-bcfc-1997413b26e3' AND f.job_number = 'SWF-261372'
                    AND f.job_id = 'a0000000-0000-4000-8000-000000000001' AND f.lane = 'materials' AND f.kind = 'actual'
                    AND f.amount_ex_gst = 72.27 AND f.amount_inc_gst = 79.50 AND f.confidence = 'high_manual'
                    AND f.automation_source = 'manual_queue' AND f.match_reason = 'manual_queue:assign-to-job SWF-261372'
                    AND f.fact_date = '2026-11-09' AND f.assigned_by = c
                    AND f.org_id = '00000000-0000-0000-0000-000000000001' AND f.invoice_number = 'INV 91584'
                    AND f.contact_name = 'R&R' AND f.matched_po_id IS NULL) THEN
    RAISE EXCEPTION 'SP-1: INV 91584 not placed on SWF-261372 as a manual queue fact';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.materials_reconciliation_queue q
                  WHERE q.xero_invoice_id = '48dd66ca-5e55-4d52-bcfc-1997413b26e3' AND q.status = 'assigned'
                    AND q.assigned_job_id = 'a0000000-0000-4000-8000-000000000001' AND q.assigned_by = c AND q.assigned_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SP-1: INV 91584 queue row not flipped to assigned';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_events e
                  WHERE e.job_id = 'a0000000-0000-4000-8000-000000000001' AND e.event_type = 'materials_bill_assigned'
                    AND e.detail_json ->> 'xero_invoice_id' = '48dd66ca-5e55-4d52-bcfc-1997413b26e3'
                    AND e.detail_json ->> 'assigned_by' = c) THEN
    RAISE EXCEPTION 'SP-1: INV 91584 has no materials_bill_assigned event';
  END IF;
  -- SP-2 an installer bill (account 306) lands in the labour lane.
  IF NOT EXISTS (SELECT 1 FROM public.job_materials_facts f
                  WHERE f.xero_invoice_id = '7907cc63-3836-43d7-8322-468e3bc1f235' AND f.job_number = 'SWP-26183'
                    AND f.lane = 'labour' AND f.amount_ex_gst = 500) THEN
    RAISE EXCEPTION 'SP-2: 202609 not placed as labour on SWP-26183';
  END IF;
  -- SP-3 the split: two labour rows, 409.00 and 167.00, queue row split.
  SELECT count(*) INTO n FROM public.job_materials_facts f
   WHERE f.xero_invoice_id = 'e4a5d66f-ce5f-4d80-970f-feb422f66119' AND f.lane = 'labour'
     AND ((f.job_id = 'a0000000-0000-4000-8000-000000000009' AND f.amount_ex_gst = 409)
       OR (f.job_id = 'a0000000-0000-4000-8000-00000000000a' AND f.amount_ex_gst = 167));
  IF n <> 2 OR (SELECT count(*) FROM public.job_materials_facts WHERE xero_invoice_id = 'e4a5d66f-ce5f-4d80-970f-feb422f66119') <> 2 THEN
    RAISE EXCEPTION 'SP-3: 202608 not split 409.00 to SWP-26090 and 167.00 to SWP-26102 (% matching rows)', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_materials_facts
              WHERE xero_invoice_id = 'e4a5d66f-ce5f-4d80-970f-feb422f66119' AND assigned_by IS DISTINCT FROM c) THEN
    RAISE EXCEPTION 'SP-3: a 202608 split row does not record the approving person';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.materials_reconciliation_queue
                  WHERE xero_invoice_id = 'e4a5d66f-ce5f-4d80-970f-feb422f66119' AND status = 'split' AND assigned_by = c) THEN
    RAISE EXCEPTION 'SP-3: 202608 queue row not split';
  END IF;
  SELECT count(*) INTO n FROM public.job_events
   WHERE event_type = 'materials_bill_split' AND detail_json ->> 'xero_invoice_id' = 'e4a5d66f-ce5f-4d80-970f-feb422f66119';
  IF n <> 2 THEN RAISE EXCEPTION 'SP-3: expected 2 split events, found %', n; END IF;
  -- SP-4 every guard skips without writing: amount changed, already placed, not open, trade mirror,
  -- draft in Xero, cancelled job, holding job.
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id IN (
               'fe33b791-556b-4ee0-8f8f-6c4f61dca31a', 'bf80a934-7587-4971-8d17-5d7c41a096a7',
               'ed6b5449-284b-47f6-915f-0f5584710ed3', 'a0ef6c13-a1e9-4c74-85cd-216d994c36ae',
               '08ca3a19-2a23-4735-bcf8-2f1aac08e517', '49a7466e-f1ec-41ef-acaa-0af6471694e3')) THEN
    RAISE EXCEPTION 'SP-4: a guarded bill was placed';
  END IF;
  IF (SELECT count(*) FROM public.job_materials_facts WHERE xero_invoice_id = 'a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd') <> 1
     OR NOT EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd' AND assigned_by = 'someone else') THEN
    RAISE EXCEPTION 'SP-4: the existing fact on 1977 was touched';
  END IF;
  SELECT count(*) INTO n FROM public.materials_reconciliation_queue
   WHERE xero_invoice_id IN ('fe33b791-556b-4ee0-8f8f-6c4f61dca31a', 'a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd',
                             'ed6b5449-284b-47f6-915f-0f5584710ed3', 'a0ef6c13-a1e9-4c74-85cd-216d994c36ae',
                             '08ca3a19-2a23-4735-bcf8-2f1aac08e517', '49a7466e-f1ec-41ef-acaa-0af6471694e3')
     AND status = 'open' AND assigned_by IS NULL;
  IF n <> 6 THEN RAISE EXCEPTION 'SP-4: expected 6 guarded queue rows still open, found %', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.materials_reconciliation_queue
                  WHERE xero_invoice_id = 'bf80a934-7587-4971-8d17-5d7c41a096a7' AND status = 'assigned' AND assigned_by IS NULL) THEN
    RAISE EXCEPTION 'SP-4: the already assigned row was changed';
  END IF;
  -- SP-7 line_items that are not an array: placed as materials.
  IF NOT EXISTS (SELECT 1 FROM public.job_materials_facts
                  WHERE xero_invoice_id = '06dc37c6-7b6c-4822-b9e7-91ec1d7f9cb1' AND job_number = 'SWF-261240' AND lane = 'materials') THEN
    RAISE EXCEPTION 'SP-7: 2206/90345729 not placed as materials';
  END IF;
  -- SP-8 in Bills to place but not in our copy of Xero: skipped, left open.
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = '787f150b-17c6-463c-8400-e0071b897efc')
     OR NOT EXISTS (SELECT 1 FROM public.materials_reconciliation_queue
                     WHERE xero_invoice_id = '787f150b-17c6-463c-8400-e0071b897efc' AND status = 'open' AND assigned_by IS NULL) THEN
    RAISE EXCEPTION 'SP-8: a bill missing from our copy of Xero was touched';
  END IF;
  -- SP-9 the bill whose insert failed is left exactly as it was: no fact, queue row open, no event.
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = '971fee47-2e4c-4da0-b92d-3575fed1a448')
     OR EXISTS (SELECT 1 FROM public.job_events WHERE detail_json ->> 'xero_invoice_id' = '971fee47-2e4c-4da0-b92d-3575fed1a448')
     OR NOT EXISTS (SELECT 1 FROM public.materials_reconciliation_queue
                     WHERE xero_invoice_id = '971fee47-2e4c-4da0-b92d-3575fed1a448' AND status = 'open' AND assigned_by IS NULL) THEN
    RAISE EXCEPTION 'SP-9: the failed bill was partly written';
  END IF;
  -- SP-5 nothing else: exactly 5 facts (3 single, 2 split) and 5 events carry this actor.
  SELECT count(*) INTO n FROM public.job_materials_facts WHERE assigned_by = c;
  IF n <> 5 THEN RAISE EXCEPTION 'SP-5: expected 5 facts by this migration, found %', n; END IF;
  SELECT count(*) INTO n FROM public.job_events WHERE detail_json ->> 'assigned_by' = c;
  IF n <> 5 THEN RAISE EXCEPTION 'SP-5: expected 5 events by this migration, found %', n; END IF;
END $$;

-- SP-6 a second run places only the bill whose insert failed the first time (its trigger is gone);
-- nothing already placed is written again.
\ir ../../../migrations/20261116003000_sep_reconcile_placements.sql
DO $$ BEGIN
  IF (SELECT count(*) FROM public.job_materials_facts WHERE assigned_by = 'marnin (approved list, migration 20261116003000)') <> 6
     OR (SELECT count(*) FROM public.job_events WHERE detail_json ->> 'assigned_by' = 'marnin (approved list, migration 20261116003000)') <> 6 THEN
    RAISE EXCEPTION 'SP-6: a second run wrote again';
  END IF;
END $$;
ROLLBACK;
