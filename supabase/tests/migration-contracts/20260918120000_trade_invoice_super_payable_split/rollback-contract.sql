-- After the down migration, the 12% full-carve-out CHECK is restored.
-- Historical 880 rows remain; a 940 insert must fail.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.trade_invoices
    WHERE id = '18000000-0000-4000-8000-000000000001'
      AND net_pay = 880
  ) THEN
    RAISE EXCEPTION 'legacy withhold row missing after rollback';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (
      id, subtotal_ex, gst, total_inc, status,
      gst_on, super_rate, super_amount, gross_earned, net_pay
    ) VALUES (
      '18000000-0000-4000-8000-000000000099',
      1000, 0, 1000, 'draft',
      false, 0.12, 120, 1000, 940
    );
    RAISE EXCEPTION '6%% withhold row was accepted after rollback';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;
