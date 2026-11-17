-- Rollback of P1-05.8 weekly persist split check. Puts back main's body
-- (md5(prosrc) 58182c36e4f35a04ef652da81cea4ec7) only from this migration's
-- body; returns when already at main's body; refuses any other body. Then
-- drops the split helper, which nothing else reads.
DO $drop$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname NOT IN ('persist_weekly_trade_invoice_v1', 'trade_line_hold_merge_v1')
      AND prosrc LIKE '%trade_line_hold_merge_v1%'
  ) THEN
    RAISE EXCEPTION 'P1-05.8 rollback: a persist body still reads trade_line_hold_merge_v1; roll that back first';
  END IF;
END $drop$;
DO $patch$ DECLARE
  d text;
  body_md5 text;
  pair text[];
  pairs text[][] := ARRAY[
    ARRAY[$o$  v_user_managed_verticals text[];
  v_source_lines jsonb;
BEGIN$o$,
      $n$  v_user_managed_verticals text[];
BEGIN$n$],
    ARRAY[$o$  -- P1-05.8: the lines as the trade sent them, for the source checks.
  v_source_lines := p_lines;
  IF p_invoice ? 'hold_lines' THEN
    v_source_lines := public.trade_line_hold_merge_v1(p_lines, p_invoice->'hold_lines');
  END IF;
  IF v_invoice_source = 'weekly_work_order' AND jsonb_array_length(p_lines) = 0 THEN$o$,
      $n$  IF v_invoice_source = 'weekly_work_order' AND jsonb_array_length(p_lines) = 0 THEN$n$],
    ARRAY[$o$    FROM jsonb_array_elements(v_source_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$o$,
      $n$    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$n$],
    ARRAY[$o$    FROM jsonb_array_elements(v_source_lines) AS input(line)
    LEFT JOIN public.work_orders wo
      ON wo.id = NULLIF(input.line->>'source_work_order_id', '')::uuid
    WHERE COALESCE(input.line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')$o$,
      $n$    FROM jsonb_array_elements(p_lines) AS input(line)
    LEFT JOIN public.work_orders wo
      ON wo.id = NULLIF(input.line->>'source_work_order_id', '')::uuid
    WHERE COALESCE(input.line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')$n$],
    ARRAY[$o$        FROM jsonb_array_elements(v_source_lines) AS input(line)
        WHERE COALESCE(line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')
      ) sources$o$,
      $n$        FROM jsonb_array_elements(p_lines) AS input(line)
        WHERE COALESCE(line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')
      ) sources$n$],
    ARRAY[$o$      FROM jsonb_array_elements(v_source_lines) AS input(line)
      WHERE COALESCE(line->>'line_type', '') NOT IN (
        'crew_work_order_deduction',$o$,
      $n$      FROM jsonb_array_elements(p_lines) AS input(line)
      WHERE COALESCE(line->>'line_type', '') NOT IN (
        'crew_work_order_deduction',$n$],
    ARRAY[$o$        FROM jsonb_array_elements(v_source_lines) AS input(line)
      ) sources
      JOIN public.trade_invoice_lines existing$o$,
      $n$        FROM jsonb_array_elements(p_lines) AS input(line)
      ) sources
      JOIN public.trade_invoice_lines existing$n$],
    ARRAY[$o$        FROM jsonb_array_elements(v_source_lines) AS input(line)
      ) sources
      JOIN public.trade_invoices parent$o$,
      $n$        FROM jsonb_array_elements(p_lines) AS input(line)
      ) sources
      JOIN public.trade_invoices parent$n$]
  ];
BEGIN
  d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
    WHERE oid = 'public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure;
  IF body_md5 = '58182c36e4f35a04ef652da81cea4ec7' THEN RETURN; END IF;
  IF body_md5 IS DISTINCT FROM 'fe44f464f3c5c62b35149122f7655cb9' THEN
    RAISE EXCEPTION 'P1-05.8 weekly persist rollback md5 postimage changed: %', body_md5;
  END IF;
  FOREACH pair SLICE 1 IN ARRAY pairs LOOP
    IF (length(d) - length(replace(d, pair[1], ''))) / length(pair[1]) <> 1 THEN
      RAISE EXCEPTION 'P1-05.8 weekly persist rollback anchor changed: %', left(pair[1], 60);
    END IF;
    d := replace(d, pair[1], pair[2]);
  END LOOP;
  EXECUTE d;
END $patch$;
DROP FUNCTION IF EXISTS public.trade_line_hold_merge_v1(jsonb, jsonb);
