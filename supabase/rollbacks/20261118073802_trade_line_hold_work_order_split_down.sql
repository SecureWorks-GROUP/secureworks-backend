-- Rollback of P1-05.8 work-order persist split check. Puts back main's body
-- (md5(prosrc) 3c07c3113679ee7cdd99c574f755d99a) only from this migration's
-- body; returns when already at main's body; refuses any other body.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$o$,
      $n$  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$n$],
    ARRAY[$o$      FROM jsonb_array_elements(v_source_lines) AS input(line)
      WHERE NULLIF(line->>'source_trade_invoice_line_id', '') IS NULL$o$,
      $n$      FROM jsonb_array_elements(p_lines) AS input(line)
      WHERE NULLIF(line->>'source_trade_invoice_line_id', '') IS NULL$n$],
    ARRAY[$o$    FROM jsonb_array_elements(v_source_lines) AS input(line)
    WHERE NULLIF(input.line->>'job_id', '')::uuid IS DISTINCT FROM v_job_id$o$,
      $n$    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(input.line->>'job_id', '')::uuid IS DISTINCT FROM v_job_id$n$]
  ];
BEGIN
  d := pg_get_functiondef('public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
    WHERE oid = 'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure;
  IF body_md5 = '3c07c3113679ee7cdd99c574f755d99a' THEN RETURN; END IF;
  IF body_md5 IS DISTINCT FROM '7405ac7533156a6e08de5ae94c37c16f' THEN
    RAISE EXCEPTION 'P1-05.8 work-order persist rollback md5 postimage changed: %', body_md5;
  END IF;
  FOREACH pair SLICE 1 IN ARRAY pairs LOOP
    IF (length(d) - length(replace(d, pair[1], ''))) / length(pair[1]) <> 1 THEN
      RAISE EXCEPTION 'P1-05.8 work-order persist rollback anchor changed: %', left(pair[1], 60);
    END IF;
    d := replace(d, pair[1], pair[2]);
  END LOOP;
  EXECUTE d;
END $patch$;
