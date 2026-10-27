-- Down for 20261020160000_context_recon_daily_list. Manual only: rollbacks are never applied by the
-- deploy lane. Refuses while any invoice decision exists, so it never deletes a decision. Drops
-- the daily list and the invoice functions and puts back the event-only subject check. Writes
-- no business row. Re-running is a no-op. Run it before 20261020155000's down: the daily list
-- reads that migration's lane, so its own down must come first.

DO $$
BEGIN
  IF to_regclass('public.context_reconciliation_decisions') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.context_reconciliation_decisions WHERE subject_kind = 'invoice') THEN
      RAISE EXCEPTION 'context_recon_daily_list_down_refused: invoice decisions exist';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.context_recon_daily_left_out(timestamptz);
DROP FUNCTION IF EXISTS public.context_recon_daily_list(timestamptz, int);
DROP FUNCTION IF EXISTS public.context_recon_daily_rows(timestamptz);
DROP FUNCTION IF EXISTS public.context_recon_job_choices(uuid[]);
DROP FUNCTION IF EXISTS public.context_recon_job_is_live(text);
DROP FUNCTION IF EXISTS public.context_recon_contact_owed(text[]);
DROP FUNCTION IF EXISTS public.context_recon_record_invoice_decision(uuid, text, text, uuid[], text, uuid, text);
DROP FUNCTION IF EXISTS public.context_recon_invoice_decision_state(uuid);
DROP FUNCTION IF EXISTS public.context_recon_invoice_evidence_hash(uuid);

DO $$
BEGIN
  IF to_regclass('public.context_reconciliation_decisions') IS NOT NULL THEN
    ALTER TABLE public.context_reconciliation_decisions
      DROP CONSTRAINT IF EXISTS context_reconciliation_decisions_subject_kind_check;
    ALTER TABLE public.context_reconciliation_decisions
      ADD CONSTRAINT context_reconciliation_decisions_subject_kind_check CHECK (subject_kind IN ('event'));
  END IF;
END $$;
