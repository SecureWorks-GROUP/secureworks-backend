-- P1-16.1: never remove week evidence while either feature is enabled.
BEGIN;
LOCK TABLE public.feature_flags IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags
      WHERE flag_name IN ('trade_week_autofill_v1', 'trade_week_auto_send_v1')
        AND enabled = false) <> 2 THEN
    RAISE EXCEPTION 'both week switches must be off before rollback';
  END IF;
END $$;

ALTER TABLE public.trade_invoice_lines
  DROP COLUMN IF EXISTS suggested,
  DROP COLUMN IF EXISTS changed_from_suggestion;
ALTER TABLE public.trade_invoices
  DROP COLUMN IF EXISTS accepted_untouched,
  DROP COLUMN IF EXISTS confirm_seconds,
  DROP COLUMN IF EXISTS auto_sent,
  DROP COLUMN IF EXISTS office_sent_back_at;
DELETE FROM public.feature_flags
WHERE flag_name IN ('trade_week_autofill_v1', 'trade_week_auto_send_v1');
COMMIT;
