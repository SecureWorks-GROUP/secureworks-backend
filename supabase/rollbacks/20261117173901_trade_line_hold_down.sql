-- Do not discard a send, a hold, a decision or a note. One administrative
-- rollback check, not a recurring read. Earlier gap columns stay in place.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.trade_invoices
      WHERE invoice_kind <> 'standard' OR send_id IS NOT NULL OR follows_invoice_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.trade_invoice_lines
      WHERE hold_reason IS NOT NULL OR hold_detail IS NOT NULL OR decided_at IS NOT NULL
        OR sent_amount_ex IS NOT NULL OR sent_values IS NOT NULL
        OR office_change_reason IS NOT NULL OR split_group_id IS NOT NULL
        OR not_job_work_type_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.trade_held_line_notes)
    OR EXISTS (SELECT 1 FROM public.not_job_work_types) THEN
    RAISE EXCEPTION 'trade line hold rollback would discard recorded evidence' USING ERRCODE = '55000';
  END IF;
END $$;
DROP FUNCTION public.trade_send_totals(uuid);
SELECT public.remove_trade_line_hold();
DROP FUNCTION public.remove_trade_line_hold();
DROP FUNCTION public.install_trade_line_hold();
DROP FUNCTION public.trade_held_line_notes_append_only();
DROP TABLE public.trade_held_line_notes;
ALTER TABLE public.trade_invoice_lines DROP CONSTRAINT trade_invoice_lines_not_job_work_type_fkey;
DROP TABLE public.not_job_work_types;
DROP INDEX public.trade_invoice_lines_held_idx;
ALTER TABLE public.trade_invoice_lines
  DROP CONSTRAINT trade_invoice_lines_hold_status_check,
  DROP CONSTRAINT trade_invoice_lines_hold_reason_check,
  DROP COLUMN not_job_work_type_id,
  DROP COLUMN split_group_id,
  DROP COLUMN office_change_reason,
  DROP COLUMN sent_values,
  DROP COLUMN sent_amount_ex,
  DROP COLUMN decided_at,
  DROP COLUMN hold_detail;
ALTER TABLE public.trade_invoices DROP CONSTRAINT trade_invoices_held_money_check;
DROP INDEX public.trade_invoices_send_idx;
ALTER TABLE public.trade_invoices
  DROP COLUMN follows_invoice_id,
  DROP COLUMN send_id,
  DROP COLUMN invoice_kind;
DELETE FROM public.feature_flags WHERE flag_name = 'trade_line_hold_v1';
