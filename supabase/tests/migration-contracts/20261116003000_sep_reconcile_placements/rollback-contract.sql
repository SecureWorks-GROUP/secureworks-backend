\set ON_ERROR_STOP on
-- The down migration ran on the stack (nothing to undo). Prove it also undoes a real run:
-- place the fixtures, run the down file, and check the bills are open again and nothing of
-- this migration is left, while the fact someone else wrote stays.
BEGIN;
\ir fixtures.sql
\ir ../../../migrations/20261116003000_sep_reconcile_placements.sql
\ir ../../../rollbacks/20261116003000_sep_reconcile_placements_down.sql
DO $$ DECLARE c text := 'marnin (approved list, migration 20261116003000)'; BEGIN
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE assigned_by = c)
     OR EXISTS (SELECT 1 FROM public.job_events WHERE detail_json ->> 'assigned_by' = c)
     OR EXISTS (SELECT 1 FROM public.materials_reconciliation_queue WHERE assigned_by = c) THEN
    RAISE EXCEPTION 'SP-R1: rows of this migration remain after the down file';
  END IF;
  IF (SELECT count(*) FROM public.materials_reconciliation_queue
       WHERE xero_invoice_id IN ('48dd66ca-5e55-4d52-bcfc-1997413b26e3', '7907cc63-3836-43d7-8322-468e3bc1f235',
                                 'e4a5d66f-ce5f-4d80-970f-feb422f66119') AND status = 'open') <> 3 THEN
    RAISE EXCEPTION 'SP-R1: the placed bills are not open again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_materials_facts WHERE xero_invoice_id = 'a7a530a5-51bb-4ba9-9c8f-8844f3e3a6dd' AND assigned_by = 'someone else')
     OR NOT EXISTS (SELECT 1 FROM public.materials_reconciliation_queue WHERE xero_invoice_id = 'bf80a934-7587-4971-8d17-5d7c41a096a7' AND status = 'assigned') THEN
    RAISE EXCEPTION 'SP-R2: the down file touched a row this migration did not write';
  END IF;
END $$;
ROLLBACK;
