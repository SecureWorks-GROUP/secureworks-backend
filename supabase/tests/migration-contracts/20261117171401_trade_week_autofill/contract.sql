\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  invoice_id uuid;
  invalid_seconds integer;
  refused_by text;
BEGIN
  IF (SELECT count(*) FROM public.feature_flags
      WHERE flag_name IN ('trade_week_autofill_v1', 'trade_week_auto_send_v1')
        AND enabled = false) <> 2 THEN
    RAISE EXCEPTION 'both week switches must exist and be off';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.trade_invoices
      WHERE id = 'f1160000-0000-4000-8000-000000000001'
        AND accepted_untouched IS NULL AND confirm_seconds IS NULL
        AND office_sent_back_at IS NULL AND auto_sent = false) THEN
    RAISE EXCEPTION 'old invoice suggestion facts must stay unknown';
  END IF;

  -- Neither legacy writer has to know about the new fields.
  INSERT INTO public.trade_invoices (invoice_number, gst_on, super_rate, super_amount, gross_earned, net_pay)
  VALUES ('ZZTEST-AUTOFILL-NEW', false, 0.12, 0, 0, 0) RETURNING id INTO invoice_id;
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoices WHERE id = invoice_id
      AND auto_sent = false AND accepted_untouched IS NULL
      AND confirm_seconds IS NULL AND office_sent_back_at IS NULL) THEN
    RAISE EXCEPTION 'old-shape invoice insert lost its defaults';
  END IF;
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, line_total_ex)
  VALUES (invoice_id, 0);
  IF NOT EXISTS (SELECT 1 FROM public.trade_invoice_lines
      WHERE trade_invoice_id = invoice_id
        AND suggested IS NULL AND changed_from_suggestion IS NULL) THEN
    RAISE EXCEPTION 'old-shape line insert must have no known suggestion';
  END IF;

  FOREACH invalid_seconds IN ARRAY ARRAY[-1, 90000] LOOP
    refused_by := NULL;
    BEGIN
      UPDATE public.trade_invoices SET confirm_seconds = invalid_seconds
      WHERE id = invoice_id;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS refused_by = CONSTRAINT_NAME;
    END;
    IF refused_by IS DISTINCT FROM 'trade_invoices_confirm_seconds_check' THEN
      RAISE EXCEPTION 'confirm_seconds must refuse %', invalid_seconds;
    END IF;
  END LOOP;
  UPDATE public.trade_invoices SET confirm_seconds = 0 WHERE id = invoice_id;
  UPDATE public.trade_invoices SET confirm_seconds = 86400 WHERE id = invoice_id;
END $$;

ROLLBACK;
