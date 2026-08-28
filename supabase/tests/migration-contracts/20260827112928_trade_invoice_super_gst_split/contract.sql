-- Executed against disposable PostgreSQL after the migration.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.trade_invoices'::regclass
      AND tgname = 'trg_trade_invoices_require_money_split'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'required insert trigger missing';
  END IF;
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

-- Historical rows remain explicit legacy truth; the migration must not invent
-- a super withholding that was never recorded.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.trade_invoices
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND gst_on IS NULL
      AND super_rate IS NULL
      AND super_amount IS NULL
      AND gross_earned IS NULL
      AND net_pay IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy invoice was fabricated or removed';
  END IF;
END;
$$;

-- Status-only lifecycle updates on a legacy row remain possible.
UPDATE public.trade_invoices
SET status = 'paid'
WHERE id = '10000000-0000-4000-8000-000000000001';

-- Both GST choices accept a complete, reconciled split.
INSERT INTO public.trade_invoices (
  id, subtotal_ex, gst, total_inc, status,
  gst_on, super_rate, super_amount, gross_earned, net_pay
) VALUES
  (
    '10000000-0000-4000-8000-000000000002',
    1000, 0, 1000, 'draft',
    false, 0.12, 120, 1000, 880
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    1000, 100, 1100, 'draft',
    true, 0.12, 120, 1000, 880
  );

-- A new row without the split fails closed at the insert trigger.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (
      id, subtotal_ex, gst, total_inc, status
    ) VALUES (
      '10000000-0000-4000-8000-000000000004',
      1000, 100, 1100, 'draft'
    );
    RAISE EXCEPTION 'new invoice without split was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- A complete-looking row with incorrect super also fails the arithmetic check.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (
      id, subtotal_ex, gst, total_inc, status,
      gst_on, super_rate, super_amount, gross_earned, net_pay
    ) VALUES (
      '10000000-0000-4000-8000-000000000005',
      1000, 100, 1100, 'draft',
      true, 0.12, 119, 1000, 881
    );
    RAISE EXCEPTION 'incorrect super split was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- The sourced statutory snapshot is enforced rather than accepting any
-- self-consistent percentage.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.trade_invoices (
      id, subtotal_ex, gst, total_inc, status,
      gst_on, super_rate, super_amount, gross_earned, net_pay
    ) VALUES (
      '10000000-0000-4000-8000-000000000006',
      1000, 100, 1100, 'draft',
      true, 0.11, 110, 1000, 890
    );
    RAISE EXCEPTION 'non-statutory super rate was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;
