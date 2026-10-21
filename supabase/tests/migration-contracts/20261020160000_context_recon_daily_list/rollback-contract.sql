-- After the down migration: the invoice functions and the daily list are gone, the store takes
-- event subjects only again, and the 20261020140000 queue still reads.
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF to_regprocedure('public.context_recon_daily_list(timestamptz,int)') IS NOT NULL
     OR to_regprocedure('public.context_recon_daily_left_out(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.context_recon_daily_rows(timestamptz)') IS NOT NULL
     OR to_regprocedure('public.context_recon_record_invoice_decision(uuid,text,text,uuid[],text,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.context_recon_invoice_evidence_hash(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'recon list rollback: functions remain';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'context_reconciliation_decisions_subject_kind_check') LIKE '%invoice%' THEN
    RAISE EXCEPTION 'recon list rollback: the store still takes invoice subjects';
  END IF;
  PERFORM count(*) FROM public.context_recon_queue();
END $$;
