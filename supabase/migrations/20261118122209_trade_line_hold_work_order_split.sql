-- P1-05.8 (director ruling 3, 18 Nov 2026): the same split rule on the
-- work-order door, persist_trade_work_order_invoice_v1, which needs
-- trade_line_hold_merge_v1 from 20261118122208.
-- No table write, no schedule, no switch change.
-- Rollback: supabase/rollbacks/20261118122209_trade_line_hold_work_order_split_down.sql.

-- ── 3. The work-order door checks the line as the trade sent it ──────────────
-- Director ruling 3 (18 Nov 2026): both doors. With a hold on a send,
-- p_invoice carries hold_lines. The storage-precision, source-scope and
-- same-job checks then read trade_line_hold_merge_v1(p_lines, hold_lines).
-- The saved total must still be above zero, as main: a send whose work is all
-- with the office saves no invoice here (its deductions stay on their source).
-- Without hold_lines the body reads p_lines exactly as before.
-- Rule 15: patched only from main's body (md5(prosrc)
-- 3c07c3113679ee7cdd99c574f755d99a); a re-run at this migration's body
-- returns; any other body refuses.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $patch$ DECLARE
  d text;
  body_md5 text;
  pair text[];
  pairs text[][] := ARRAY[
    ARRAY[$o$  v_user_managed_verticals text[];
BEGIN$o$, $n$  v_user_managed_verticals text[];
  v_source_lines jsonb;
BEGIN$n$],
    ARRAY[$o$  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$o$,
      $n$  -- P1-05.8: the lines as the trade sent them, for the source checks.
  v_source_lines := p_lines;
  IF p_invoice ? 'hold_lines' THEN
    v_source_lines := public.trade_line_hold_merge_v1(p_lines, p_invoice->'hold_lines');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_source_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$n$],
    ARRAY[$o$      FROM jsonb_array_elements(p_lines) AS input(line)
      WHERE NULLIF(line->>'source_trade_invoice_line_id', '') IS NULL$o$,
      $n$      FROM jsonb_array_elements(v_source_lines) AS input(line)
      WHERE NULLIF(line->>'source_trade_invoice_line_id', '') IS NULL$n$],
    ARRAY[$o$    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(input.line->>'job_id', '')::uuid IS DISTINCT FROM v_job_id$o$,
      $n$    FROM jsonb_array_elements(v_source_lines) AS input(line)
    WHERE NULLIF(input.line->>'job_id', '')::uuid IS DISTINCT FROM v_job_id$n$]
  ];
BEGIN
  d := pg_get_functiondef('public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
    WHERE oid = 'public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure;
  IF body_md5 = '7405ac7533156a6e08de5ae94c37c16f' THEN RETURN; END IF;
  IF body_md5 IS DISTINCT FROM '3c07c3113679ee7cdd99c574f755d99a' THEN
    RAISE EXCEPTION 'P1-05.8 work-order persist md5 preimage changed: %', body_md5;
  END IF;
  FOREACH pair SLICE 1 IN ARRAY pairs LOOP
    IF (length(d) - length(replace(d, pair[1], ''))) / length(pair[1]) <> 1 THEN
      RAISE EXCEPTION 'P1-05.8 work-order persist preimage anchor changed: %', left(pair[1], 60);
    END IF;
    d := replace(d, pair[1], pair[2]);
  END LOOP;
  EXECUTE d;
END $patch$;
