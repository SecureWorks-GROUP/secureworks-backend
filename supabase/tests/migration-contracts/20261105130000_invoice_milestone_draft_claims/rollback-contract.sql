DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.invoice_milestone_draft_claims WHERE reference='WS6-CONTRACT-PIN' AND state='draft_confirmed' AND provider_invoice_id IS NOT NULL) THEN RAISE EXCEPTION 'Rollback lost draft identity'; END IF;
  IF has_table_privilege('service_role','public.invoice_milestone_draft_claims','INSERT') OR has_table_privilege('service_role','public.invoice_milestone_draft_claims','UPDATE') THEN RAISE EXCEPTION 'Rollback left dispatch writes enabled'; END IF;
  IF EXISTS(SELECT FROM pg_trigger WHERE tgname='pin_invoice_payer_when_quote_released') THEN RAISE EXCEPTION 'Rollback left quote capture enabled'; END IF;
END $$;
