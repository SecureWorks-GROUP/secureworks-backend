-- P4 setup. Earlier registered fixtures supply jobs, business_events, event_threads,
-- contact_matches, job_contacts, xero_invoices, purchase_orders, feature_flags,
-- the P1a ladder and candidate set, K1's written_as trigger and B0's helpers.
-- Add only the live columns this case reads that the fixtures omit, as read from
-- production 24 Sep 2026: xero_invoices.invoice_date date and total numeric.
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS invoice_date date,
 ADD COLUMN IF NOT EXISTS total numeric(12,2);

-- Prove every object P4 replaces is production's pre-image (read 24 Sep 2026).
DO $$
DECLARE x record; live text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.resolve_context_attribution(public.business_events)','fe50f14f4ab28d4d6c9dbb70bc85e7df'),
  ('public.attribute_business_event()','7c1b8ffeeed8829288ee42c30e4314e5')) AS t(sig,md5) LOOP
  SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF live IS DISTINCT FROM x.md5 THEN RAISE EXCEPTION 'p4 setup: % is %, not the production pre-image',x.sig,live; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='context_unlinked_rules_v1') THEN
  RAISE EXCEPTION 'p4 setup: production has no context_unlinked_rules_v1 row';
 END IF;
END $$;
