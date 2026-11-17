-- FU12 / P1-03: keep permanent receipt uniqueness and replace draft claims atomically.
-- No install, schedule or switch change. The existing switch remains off.
DO $patch$ DECLARE d text; old_text text; new_text text; BEGIN
  d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  IF strpos(d, '-- FU12: release only') > 0 THEN RETURN; END IF;
  old_text := $old$  INSERT INTO public.trade_invoice_lines (
$old$;
  new_text := $new$  -- FU12: release only the locked, validated draft's receipts, in this transaction.
  -- idx_inv_lines_invoice bounds the delete; any later failure restores the draft.
  IF v_prior_draft_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'trade_reimbursement_line_v1' AND enabled
  ) THEN
    DELETE FROM public.trade_invoice_lines
    WHERE trade_invoice_id = v_prior_draft_id AND expense_receipt_id IS NOT NULL;
  END IF;

  INSERT INTO public.trade_invoice_lines (
$new$;
  IF (length(d) - length(replace(d, old_text, ''))) / length(old_text) <> 1 THEN
    RAISE EXCEPTION 'FU12 receipt release preimage changed';
  END IF;
  d := replace(d, old_text, new_text);
  old_text := $old$(v_invoice_source = 'hourly' AND v_status = 'draft')$old$;
  new_text := $new$(v_invoice_source = 'hourly' AND (
         v_status = 'draft' OR (
           v_status = 'pending_acknowledgment'
           AND EXISTS (SELECT 1 FROM public.feature_flags
             WHERE flag_name = 'trade_reimbursement_line_v1' AND enabled)
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) AS receipt(line)
             WHERE NULLIF(line->>'expense_receipt_id', '') IS NOT NULL)
         )
       ))$new$;
  IF (length(d) - length(replace(d, old_text, ''))) / length(old_text) <> 1 THEN
    RAISE EXCEPTION 'FU12 hourly submit preimage changed';
  END IF;
  EXECUTE replace(d, old_text, new_text);
END $patch$;

CREATE OR REPLACE FUNCTION public.trade_invoice_lines_reimbursement_once()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$ BEGIN
  IF NEW.expense_receipt_id IS NOT NULL THEN
    PERFORM 1 FROM public.expense_receipts WHERE id = NEW.expense_receipt_id FOR UPDATE;
    -- trade_invoice_lines_one_receipt / expense_receipt_idx bounds this lookup.
    IF EXISTS (SELECT 1 FROM public.trade_invoice_lines l JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.expense_receipt_id = NEW.expense_receipt_id AND l.id IS DISTINCT FROM NEW.id
      AND (EXISTS (SELECT 1 FROM public.feature_flags
             WHERE flag_name = 'trade_reimbursement_line_v1' AND enabled)
        OR (i.id <> NEW.trade_invoice_id AND i.status IS DISTINCT FROM 'draft' AND i.status IS DISTINCT FROM 'ops-reject'))) THEN
      RAISE EXCEPTION 'reimbursement_already_claimed' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.trade_invoice_lines_reimbursement_once() FROM PUBLIC, anon, authenticated;
