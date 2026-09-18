-- Executed against disposable PostgreSQL after the payable-split migration.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.trade_invoices'::regclass
      AND conname = 'trade_invoices_super_gst_split_check'
  ) THEN
    RAISE EXCEPTION 'money split arithmetic constraint missing';
  END IF;
END;
$$;

-- Historical 12% carve-out rows remain updatable.
UPDATE public.trade_invoices
SET status = 'paid'
WHERE id = '18000000-0000-4000-8000-000000000001'
  AND net_pay = 880;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.trade_invoices
    WHERE id = '18000000-0000-4000-8000-000000000001'
      AND status = 'paid'
      AND net_pay = 880
      AND super_amount = 120
  ) THEN
    RAISE EXCEPTION 'legacy 12%% withhold row was rejected or rewritten';
  END IF;
END;
$$;

-- Captain 2026-09-18 $1000 example: remittance $120, net_pay $940.
INSERT INTO public.trade_invoices (
  id, subtotal_ex, gst, total_inc, status,
  gst_on, super_rate, super_amount, gross_earned, net_pay
) VALUES (
  '18000000-0000-4000-8000-000000000002',
  1000, 0, 1000, 'draft',
  false, 0.12, 120, 1000, 940
);

INSERT INTO public.trade_invoices (
  id, subtotal_ex, gst, total_inc, status,
  gst_on, super_rate, super_amount, gross_earned, net_pay
) VALUES (
  '18000000-0000-4000-8000-000000000003',
  1000, 100, 1100, 'draft',
  true, 0.12, 120, 1000, 940
);

-- Rounding case $1333.33: super 160, worker withhold 80, net 1253.33.
INSERT INTO public.trade_invoices (
  id, subtotal_ex, gst, total_inc, status,
  gst_on, super_rate, super_amount, gross_earned, net_pay
) VALUES (
  '18000000-0000-4000-8000-000000000004',
  1333.33, 0, 1333.33, 'draft',
  false, 0.12, 160.00, 1333.33, 1253.33
);

-- Tampered net_pay is refused.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (
      id, subtotal_ex, gst, total_inc, status,
      gst_on, super_rate, super_amount, gross_earned, net_pay
    ) VALUES (
      '18000000-0000-4000-8000-000000000005',
      1000, 0, 1000, 'draft',
      false, 0.12, 120, 1000, 900
    );
    RAISE EXCEPTION 'tampered net_pay was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Reducing super remittance below 12% is still refused.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (
      id, subtotal_ex, gst, total_inc, status,
      gst_on, super_rate, super_amount, gross_earned, net_pay
    ) VALUES (
      '18000000-0000-4000-8000-000000000006',
      1000, 0, 1000, 'draft',
      false, 0.12, 60, 1000, 940
    );
    RAISE EXCEPTION 'reduced super remittance was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;
