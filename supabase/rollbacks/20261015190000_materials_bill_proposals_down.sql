-- Down for 20261015190000_materials_bill_proposals.sql.
-- Refuses while an agent placement or a void-closed queue row exists: undo those
-- first (delete the agent_prematch facts and re-open their queue rows; re-open the
-- void_in_xero rows), so the narrower checks can be restored without losing money.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.job_materials_facts WHERE automation_source = 'agent_prematch') THEN
    RAISE EXCEPTION 'materials_bill_proposals down: agent_prematch facts exist; delete them and re-open their queue rows first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.materials_reconciliation_queue WHERE status = 'void_in_xero') THEN
    RAISE EXCEPTION 'materials_bill_proposals down: void_in_xero queue rows exist; re-open them first';
  END IF;
END $$;

ALTER TABLE public.materials_reconciliation_queue
  DROP CONSTRAINT IF EXISTS materials_recon_status_chk;
ALTER TABLE public.materials_reconciliation_queue
  ADD CONSTRAINT materials_recon_status_chk
  CHECK (status IN ('open', 'assigned', 'not_job_related'));
ALTER TABLE public.materials_reconciliation_queue
  DROP COLUMN IF EXISTS closed_reason;

ALTER TABLE public.job_materials_facts
  DROP CONSTRAINT IF EXISTS job_materials_facts_source_chk;
ALTER TABLE public.job_materials_facts
  ADD CONSTRAINT job_materials_facts_source_chk
  CHECK (automation_source IN ('xero_ref_link', 'po_deterministic', 'manual_queue'));

DROP TABLE IF EXISTS public.materials_bill_proposals;
