-- Two invoices already share a number: the unique index cannot be built.
INSERT INTO public.trade_invoices (id, invoice_number, status)
VALUES (gen_random_uuid(), 'SW-INV-T-000000-001', 'approved'),
       (gen_random_uuid(), 'SW-INV-T-000000-001', 'approved');
