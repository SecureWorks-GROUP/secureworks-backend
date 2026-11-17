-- Prerequisites for 20261117130000_dispatch_order_quote_ref_switch. Earlier
-- registered cases already create feature_flags; this only checks it is there.
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'dispatch order quote ref setup: public.feature_flags missing from the registered stack';
  END IF;
END $$;
