BEGIN;
-- A receipt batch is one record, its two allocations remain distinct payments.
INSERT INTO public.xero_settlement_evidence
 (org_id,tenant_id,record_type,provider_id,invoice_id,batch_payment_id,amount,is_reconciled,status,captured_at,raw_json)
VALUES
 ('00000000-0000-0000-0000-000000000001','25866cf3-c1e2-4cb2-95fe-1ed081e44705','batch_payment','10000000-0000-0000-0000-000000000001',null,null,1000,true,'AUTHORISED','2026-10-14T13:00Z','{"Payments":[{"PaymentID":"20000000-0000-0000-0000-000000000001","Amount":600},{"PaymentID":"20000000-0000-0000-0000-000000000002","Amount":400}]}'),
 ('00000000-0000-0000-0000-000000000001','25866cf3-c1e2-4cb2-95fe-1ed081e44705','payment','20000000-0000-0000-0000-000000000001','invoice-one','10000000-0000-0000-0000-000000000001',600,true,'AUTHORISED','2026-10-14T13:00Z','{}'),
 ('00000000-0000-0000-0000-000000000001','25866cf3-c1e2-4cb2-95fe-1ed081e44705','payment','20000000-0000-0000-0000-000000000002','invoice-two','10000000-0000-0000-0000-000000000001',400,null,'AUTHORISED','2026-10-14T13:00Z','{}');
UPDATE public.xero_settlement_evidence SET is_reconciled=false,captured_at='2026-10-14T12:00Z'
 WHERE provider_id='20000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF (SELECT is_reconciled FROM public.xero_settlement_evidence WHERE provider_id='20000000-0000-0000-0000-000000000001') IS NOT TRUE THEN
   RAISE EXCEPTION 'Older observation replaced newer reconciliation';
 END IF;
 IF (SELECT is_reconciled FROM public.xero_settlement_evidence WHERE provider_id='20000000-0000-0000-0000-000000000002') IS NOT NULL THEN
   RAISE EXCEPTION 'Unknown reconciliation became false';
 END IF;
 IF (SELECT sum(amount) FROM public.xero_settlement_evidence WHERE record_type='payment') <> 1000 OR
    (SELECT jsonb_array_length(raw_json->'Payments') FROM public.xero_settlement_evidence WHERE record_type='batch_payment') <> 2 THEN
   RAISE EXCEPTION 'Batch allocations lost or double counted';
 END IF;
 IF has_table_privilege('anon','public.xero_settlement_evidence','SELECT') OR
    has_table_privilege('authenticated','public.xero_settlement_evidence','SELECT') OR
    has_table_privilege('service_role','public.xero_settlement_evidence','DELETE') THEN
   RAISE EXCEPTION 'Evidence exposed or deletable';
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.xero_settlement_evidence'::regclass) THEN
   RAISE EXCEPTION 'Evidence RLS missing';
 END IF;
END $$;
SET LOCAL ROLE service_role;
UPDATE public.xero_settlement_evidence SET is_reconciled=true,captured_at='2026-10-14T14:00Z'
 WHERE provider_id='20000000-0000-0000-0000-000000000002';
DO $$ BEGIN
 IF (SELECT count(*) FROM public.xero_settlement_evidence WHERE record_type='payment' AND is_reconciled) <> 2 THEN
   RAISE EXCEPTION 'Service capture could not advance evidence';
 END IF;
END $$;
RESET ROLE;
ROLLBACK;
