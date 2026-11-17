-- P1-16.3: an additive writer, called only with trade_week_autofill_v1 on.
-- No existing writer, trigger, schedule, switch or stored row changes on merge.
CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v4(
  p_invoice jsonb,
  p_lines jsonb,
  p_requested_prior_draft_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  invoice_id uuid;
  stamped integer; BEGIN
  invoice_id := public.persist_weekly_trade_invoice_v3(p_invoice, p_lines, p_requested_prior_draft_id);
  UPDATE public.trade_invoices
  SET accepted_untouched = (p_invoice->>'accepted_untouched')::boolean,
      confirm_seconds = (p_invoice->>'confirm_seconds')::integer
  WHERE id = invoice_id;

  -- idx_inv_lines_invoice bounds this to the newly saved invoice.
  UPDATE public.trade_invoice_lines AS stored
  SET suggested = COALESCE(input.line->'suggested', '{"source":"added_by_trade"}'::jsonb),
      changed_from_suggestion = (input.line->>'changed_from_suggestion')::boolean,
      sent_values = CASE WHEN input.line ? 'sent_values'
        THEN COALESCE(stored.sent_values, '{}'::jsonb) || (input.line->'sent_values')
        ELSE stored.sent_values END,
      office_review_note = CASE WHEN input.line->>'office_review_note' IS NULL
        OR stored.office_review_note = input.line->>'office_review_note'
        THEN stored.office_review_note
        ELSE concat_ws(' | ', NULLIF(stored.office_review_note, ''), input.line->>'office_review_note') END
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS input(line, ordinality)
  WHERE stored.trade_invoice_id = invoice_id
    AND stored.line_position = COALESCE((input.line->>'line_position')::integer, input.ordinality::integer - 1);
  GET DIAGNOSTICS stamped = ROW_COUNT;
  IF stamped <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'week_send_evidence_incomplete';
  END IF;
  RETURN invoice_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.persist_weekly_trade_invoice_v4(jsonb,jsonb,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_weekly_trade_invoice_v4(jsonb,jsonb,uuid) TO service_role;
COMMENT ON FUNCTION public.persist_weekly_trade_invoice_v4(jsonb,jsonb,uuid) IS
  'P1-16.3: v3 unchanged, then saves the server suggestion and sent-rate evidence in the same transaction. Used only with trade_week_autofill_v1 on.';
