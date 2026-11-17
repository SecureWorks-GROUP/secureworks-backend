-- Contract for 20261117130000_dispatch_order_quote_ref_switch.sql: the switch
-- is there, seeded off, and a re-run leaves an existing row as it is.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'dispatch_order_quote_ref_line_v1') <> 1 THEN
    RAISE EXCEPTION 'dispatch order quote ref contract: the switch must be seeded once';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'dispatch_order_quote_ref_line_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'dispatch order quote ref contract: dispatch_order_quote_ref_line_v1 must be seeded off';
  END IF;
END $$;

-- A re-apply never turns an existing row off or on.
BEGIN;
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'dispatch_order_quote_ref_line_v1';
INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('dispatch_order_quote_ref_line_v1', false, 'test re-apply')
ON CONFLICT (flag_name) DO NOTHING;
DO $$
BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'dispatch_order_quote_ref_line_v1') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'dispatch order quote ref contract: a re-apply changed an existing row';
  END IF;
END $$;
ROLLBACK;
