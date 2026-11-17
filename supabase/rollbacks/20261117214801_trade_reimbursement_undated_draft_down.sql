-- FU17 Also: atomic receipt replacement for an explicitly selected undated draft.
-- No trigger install, schedule, table write or switch change.
DO $patch$ DECLARE d text; old_text text; new_text text; body_md5 text; BEGIN
  d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
    WHERE oid = 'public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure;
  IF body_md5 = '80b4e1c9f292bae2ac7858ac18a4892e' THEN RETURN; END IF;
  IF body_md5 IS DISTINCT FROM '58182c36e4f35a04ef652da81cea4ec7' THEN
    RAISE EXCEPTION 'FU17 undated draft rollback md5 preimage changed: %', body_md5;
  END IF;
  old_text := $old$  IF v_week_start IS NULL THEN
    -- trade_invoices_pkey bounds the explicit draft read. Never choose a
    -- different undated draft by age, receipt ownership or array order.
    SELECT id, xero_bill_id, xero_pushed_at
    INTO v_prior_draft_id, v_prior_xero_bill_id, v_prior_xero_pushed_at
    FROM public.trade_invoices
    WHERE id = p_requested_prior_draft_id
      AND org_id = v_org_id AND user_id = v_user_id
      AND week_start IS NULL AND week_end IS NULL
      AND invoice_source = 'hourly' AND status = 'draft'
    FOR UPDATE;
  ELSE
  SELECT count(*)
  INTO v_draft_count
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND user_id = v_user_id
    AND week_start = v_week_start
    AND status = 'draft';

  IF v_draft_count > 1 THEN
    RAISE EXCEPTION 'multiple weekly drafts need office review before replacement'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, xero_bill_id, xero_pushed_at
  INTO v_prior_draft_id, v_prior_xero_bill_id, v_prior_xero_pushed_at
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND user_id = v_user_id
    AND week_start = v_week_start
    AND status = 'draft'
  ORDER BY created_at, id
  LIMIT 1
  FOR UPDATE;

  END IF;
$old$;
  new_text := $new$  SELECT count(*)
  INTO v_draft_count
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND user_id = v_user_id
    AND week_start = v_week_start
    AND status = 'draft';

  IF v_draft_count > 1 THEN
    RAISE EXCEPTION 'multiple weekly drafts need office review before replacement'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, xero_bill_id, xero_pushed_at
  INTO v_prior_draft_id, v_prior_xero_bill_id, v_prior_xero_pushed_at
  FROM public.trade_invoices
  WHERE org_id = v_org_id
    AND user_id = v_user_id
    AND week_start = v_week_start
    AND status = 'draft'
  ORDER BY created_at, id
  LIMIT 1
  FOR UPDATE;
$new$;
  IF (length(d) - length(replace(d, old_text, ''))) / length(old_text) <> 1 THEN
    RAISE EXCEPTION 'FU17 undated draft preimage changed';
  END IF;
  d := replace(d, old_text, new_text);
  old_text := $old$     -- FU17: only switched-on hourly drafts may have no week.
     OR NOT (
       COALESCE(v_week_start IS NOT NULL AND v_week_end = v_week_start + 6
         AND EXTRACT(ISODOW FROM v_week_start) = 1, false)
       OR COALESCE((v_week_start IS NULL AND v_week_end IS NULL
         AND v_invoice_source = 'hourly' AND v_status = 'draft'
         AND EXISTS (SELECT 1 FROM public.feature_flags
           WHERE flag_name = 'trade_reimbursement_line_v1' AND enabled)), false)
     )$old$;
  new_text := $new$     OR v_week_start IS NULL
     OR v_week_end IS NULL
     OR v_week_end <> v_week_start + 6
     OR EXTRACT(ISODOW FROM v_week_start) <> 1$new$;
  IF (length(d) - length(replace(d, old_text, ''))) / length(old_text) <> 1 THEN
    RAISE EXCEPTION 'FU17 undated draft preimage changed';
  END IF;
  d := replace(d, old_text, new_text);
  EXECUTE d;
END $patch$;
