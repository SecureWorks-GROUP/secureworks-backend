-- P1-16.1 uses the invoice tables supplied by the registered stack.
-- Keep an old-shape row to prove that unknown suggestion facts stay unknown.
INSERT INTO public.trade_invoices (id, invoice_number)
VALUES ('f1160000-0000-4000-8000-000000000001', 'ZZTEST-AUTOFILL-OLD')
ON CONFLICT (id) DO NOTHING;
