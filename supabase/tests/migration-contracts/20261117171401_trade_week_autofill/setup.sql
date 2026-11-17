-- P1-16.1 uses the invoice tables supplied by the registered stack.
-- Keep an old-shape row to prove that unknown suggestion facts stay unknown.
INSERT INTO public.trade_invoices (id, invoice_number, gst_on, super_rate, super_amount, gross_earned, net_pay)
VALUES ('f1160000-0000-4000-8000-000000000001', 'ZZTEST-AUTOFILL-OLD', false, 0.12, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;
