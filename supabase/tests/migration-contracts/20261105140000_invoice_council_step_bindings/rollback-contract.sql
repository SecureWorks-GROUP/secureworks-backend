DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.quote_invoice_council_bindings WHERE quote_revision_id='77000000-0000-4000-8000-000000000004' AND state='eligible') OR NOT EXISTS(SELECT 1 FROM public.invoice_milestone_draft_claims WHERE reference='WS6-COUNCIL-CONTRACT') THEN RAISE EXCEPTION 'Council rollback lost accepted binding or claim'; END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pin_council_invoice_step_when_quote_released') THEN RAISE EXCEPTION 'Council rollback retained new quote capture'; END IF;
END $$;
