-- Provider evidence only. No invoice/job attribution, bank match or money write.
CREATE TABLE public.xero_settlement_evidence (
  org_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  record_type text NOT NULL CHECK (record_type IN ('payment', 'batch_payment')),
  provider_id uuid NOT NULL,
  invoice_id text,
  batch_payment_id uuid,
  payment_date date,
  amount numeric,
  reference text,
  account jsonb,
  is_reconciled boolean,
  status text,
  provider_updated_at timestamptz,
  captured_at timestamptz NOT NULL,
  raw_json jsonb NOT NULL CHECK (jsonb_typeof(raw_json) = 'object'),
  PRIMARY KEY (org_id, tenant_id, record_type, provider_id),
  CHECK ((record_type = 'payment' AND invoice_id IS NOT NULL)
      OR (record_type = 'batch_payment' AND invoice_id IS NULL))
);
CREATE INDEX xero_settlement_evidence_invoice_idx
  ON public.xero_settlement_evidence (org_id, tenant_id, invoice_id)
  WHERE record_type = 'payment';
ALTER TABLE public.xero_settlement_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.xero_settlement_evidence FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.xero_settlement_evidence TO service_role;
CREATE POLICY service_role_evidence ON public.xero_settlement_evidence
  FOR ALL TO service_role USING (true) WITH CHECK (true);
COMMENT ON TABLE public.xero_settlement_evidence IS
  'Xero GET Payments and BatchPayments snapshots. IsReconciled is provider evidence, not an ingested bank statement line. Batches retain their allocations in raw_json.Payments. No automatic bank matching.';

-- Concurrent syncs cannot replace a newer observation with an older one.
CREATE FUNCTION public.keep_newest_xero_settlement_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.captured_at < OLD.captured_at THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.keep_newest_xero_settlement_evidence() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER keep_newest_xero_settlement_evidence
BEFORE UPDATE ON public.xero_settlement_evidence
FOR EACH ROW EXECUTE FUNCTION public.keep_newest_xero_settlement_evidence();
