-- P1-05.8 (Follow-up 34 item 4): the held-line send saves the backed part of
-- a line on the week's invoice and the held part on a holding invoice. The
-- weekly persist checks every line against its source, so it must see the
-- line as the trade sent it. This migration adds the one split rule and lets
-- persist_weekly_trade_invoice_v1 read it when, and only when, the send names
-- its held lines. A send without held lines behaves exactly as main.
-- No table write, no schedule, no switch change.
-- Rollback: supabase/rollbacks/20261118104903_trade_line_hold_weekly_split_down.sql.

-- ── 1. One rule for a held-line split (both persistence doors) ───────────────
-- p_backed: the lines a send saves on its payable invoice.
-- p_held:   the lines it saves on its holding invoice.
-- Returns the lines as the trade sent them: each split put back into its one
-- line (quantity, hours and line_total_ex added; the backed part's other
-- fields), then every whole held line. Director ruling 1 (18 Nov 2026): a
-- split is kept only when it is a same-rate split exact to the cent. Refused
-- (23514) when:
--   * a held line has no hold reason, is a deduction or is below zero;
--   * a split id is not exactly one backed part and one held part;
--   * the parts differ in anything but quantity, hours, line_total_ex, the
--     held part's description suffix, position and hold fields;
--   * a part is not above zero, or its own quantity or hours times its rate
--     do not make its total at storage precision;
--   * the line put back together does not make its total the same way, so a
--     split that loses or adds a cent is refused.
-- Lines with no split id pass through unchanged. Reads and writes no table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A function of this name on live must be this migration's own body (a re-run);
-- anything else is someone else's and is never replaced.
DO $guard$ DECLARE body_md5 text; BEGIN
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.trade_line_hold_merge_v1(jsonb,jsonb)');
  IF body_md5 IS NOT NULL AND body_md5 <> '1cf279136f44bccd245bd7845d086d11' THEN
    RAISE EXCEPTION 'P1-05.8 trade_line_hold_merge_v1 exists with another body: %', body_md5;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.trade_line_hold_merge_v1(p_backed jsonb, p_held jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_merged jsonb;
  -- Keys the two parts of one split may differ in.
  v_part_keys text[] := ARRAY[
    'quantity', 'total_hours', 'line_total_ex', 'description', 'line_position',
    'sent_amount_ex', 'hold_reason', 'hold_detail', 'held_at',
    'office_review_status', 'words', 'split_group_id'
  ];
BEGIN
  IF jsonb_typeof(p_backed) IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_held) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'held-line send requires a backed line array and a held line array'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_held) AS h(line)
    WHERE jsonb_typeof(h.line) IS DISTINCT FROM 'object'
       OR NULLIF(h.line->>'hold_reason', '') IS NULL
       OR COALESCE(h.line->>'line_type', '') IN (
         'crew_work_order_deduction', 'labour_deduction', 'travel_logistics_deduction',
         'materials_deduction', 'final_payout_deduction')
       OR NULLIF(h.line->>'line_total_ex', '') IS NULL
       OR (h.line->>'line_total_ex')::numeric < 0
  ) THEN
    RAISE EXCEPTION 'a held line needs a hold reason and may not be a deduction'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT 'b' AS side, NULLIF(b.line->>'split_group_id', '') AS id
      FROM jsonb_array_elements(p_backed) AS b(line)
      UNION ALL
      SELECT 'h', NULLIF(h.line->>'split_group_id', '')
      FROM jsonb_array_elements(p_held) AS h(line)
    ) s
    WHERE s.id IS NOT NULL
    GROUP BY s.id
    HAVING count(*) FILTER (WHERE s.side = 'b') <> 1
        OR count(*) FILTER (WHERE s.side = 'h') <> 1
  ) THEN
    RAISE EXCEPTION 'a held-line split must be one backed part and one held part'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_backed) AS b(line)
    JOIN jsonb_array_elements(p_held) AS h(line)
      ON NULLIF(h.line->>'split_group_id', '') = NULLIF(b.line->>'split_group_id', '')
    WHERE NULLIF(b.line->>'split_group_id', '') IS NOT NULL
      AND (
        (b.line - v_part_keys) IS DISTINCT FROM (h.line - v_part_keys)
        OR COALESCE(h.line->>'description', '')
          IS DISTINCT FROM COALESCE(b.line->>'description', '') || ' (part over the job''s amount)'
        OR (NULLIF(b.line->>'quantity', '') IS NULL) <> (NULLIF(h.line->>'quantity', '') IS NULL)
        OR (NULLIF(b.line->>'total_hours', '') IS NULL) <> (NULLIF(h.line->>'total_hours', '') IS NULL)
        OR round((b.line->>'line_total_ex')::numeric, 2) <= 0
        OR round((h.line->>'line_total_ex')::numeric, 2) <= 0
        OR round(NULLIF(b.line->>'quantity', '')::numeric, 2) <= 0
        OR round(NULLIF(h.line->>'quantity', '')::numeric, 2) <= 0
        OR round(NULLIF(b.line->>'total_hours', '')::numeric, 2) <= 0
        OR round(NULLIF(h.line->>'total_hours', '')::numeric, 2) <= 0
        -- One kind of rate only: a split never mixes a unit rate and an hourly rate.
        OR (NULLIF(b.line->>'unit_rate', '') IS NULL) = (NULLIF(b.line->>'hourly_rate', '') IS NULL)
      )
  ) THEN
    RAISE EXCEPTION 'the two parts of a held-line split differ in more than quantity and amount'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(jsonb_agg(merged.line ORDER BY merged.pos), '[]'::jsonb)
  INTO v_merged
  FROM (
    SELECT b.ordinality AS pos,
      CASE WHEN h.line IS NULL
        THEN b.line
        ELSE (b.line - 'split_group_id' - 'sent_amount_ex') || jsonb_build_object(
          'line_total_ex',
            round((b.line->>'line_total_ex')::numeric, 2) + round((h.line->>'line_total_ex')::numeric, 2),
          'quantity', CASE WHEN NULLIF(b.line->>'quantity', '') IS NULL THEN 'null'::jsonb
            ELSE to_jsonb(round((b.line->>'quantity')::numeric, 2) + round((h.line->>'quantity')::numeric, 2)) END,
          'total_hours', CASE WHEN NULLIF(b.line->>'total_hours', '') IS NULL THEN 'null'::jsonb
            ELSE to_jsonb(round((b.line->>'total_hours')::numeric, 2) + round((h.line->>'total_hours')::numeric, 2)) END,
          'hold_split_checked', true
        )
      END AS line
    FROM jsonb_array_elements(p_backed) WITH ORDINALITY AS b(line, ordinality)
    LEFT JOIN jsonb_array_elements(p_held) AS h(line)
      ON NULLIF(b.line->>'split_group_id', '') IS NOT NULL
     AND NULLIF(h.line->>'split_group_id', '') = NULLIF(b.line->>'split_group_id', '')
    UNION ALL
    SELECT 1000000 + h.ordinality,
      h.line - 'hold_reason' - 'hold_detail' - 'held_at' - 'sent_amount_ex'
        - 'office_review_status' - 'words'
    FROM jsonb_array_elements(p_held) WITH ORDINALITY AS h(line, ordinality)
    WHERE NULLIF(h.line->>'split_group_id', '') IS NULL
  ) merged;

  -- Each part, and each split put back together, at storage precision: its
  -- quantity or hours times its rate makes its total to the cent.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.line FROM jsonb_array_elements(p_backed || p_held) AS p(line)
      WHERE NULLIF(p.line->>'split_group_id', '') IS NOT NULL
      UNION ALL
      SELECT m.line FROM jsonb_array_elements(v_merged) AS m(line)
      WHERE m.line ? 'hold_split_checked'
    ) checked
    WHERE round((checked.line->>'line_total_ex')::numeric, 2) IS DISTINCT FROM round(
        CASE WHEN NULLIF(checked.line->>'unit_rate', '') IS NOT NULL
          THEN round((checked.line->>'quantity')::numeric, 2) * round((checked.line->>'unit_rate')::numeric, 2)
          ELSE round((checked.line->>'total_hours')::numeric, 2) * round((checked.line->>'hourly_rate')::numeric, 2)
        END, 2)
  ) THEN
    RAISE EXCEPTION 'a held-line split does not equal its quantity and rate to the cent'
      USING ERRCODE = '23514';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(m.line - 'hold_split_checked' ORDER BY m.ordinality), '[]'::jsonb)
    FROM jsonb_array_elements(v_merged) WITH ORDINALITY AS m(line, ordinality)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.trade_line_hold_merge_v1(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_line_hold_merge_v1(jsonb, jsonb) TO service_role;
COMMENT ON FUNCTION public.trade_line_hold_merge_v1(jsonb, jsonb) IS
  'P1-05.8: the one held-line split rule for both persistence doors. Returns the lines as the trade sent them (each same-rate split put back together, then each whole held line) for the source checks; refuses a split that is not exact to the cent. Pure.';

-- ── 2. The weekly persist checks the line as the trade sent it ──────────────
-- With a hold on a send, p_invoice carries hold_lines: the lines the send will
-- save on its holding invoice. Every check that compares lines with their
-- source (storage precision, work-order source, source scope, a work order
-- already held) then reads trade_line_hold_merge_v1(p_lines, hold_lines): each
-- split put back together and every whole held line added. p_lines alone is
-- still inserted and still makes the header. Without hold_lines the body
-- reads p_lines exactly as before.
-- Rule 15: patched only from main's body (md5(prosrc)
-- 58182c36e4f35a04ef652da81cea4ec7); a re-run at this migration's body
-- returns; any other body refuses.
DO $patch$ DECLARE
  d text;
  body_md5 text;
  pair text[];
  pairs text[][] := ARRAY[
    ARRAY[$o$  v_user_managed_verticals text[];
BEGIN$o$, $n$  v_user_managed_verticals text[];
  v_source_lines jsonb;
BEGIN$n$],
    ARRAY[$o$  IF v_invoice_source = 'weekly_work_order' AND jsonb_array_length(p_lines) = 0 THEN$o$,
      $n$  -- P1-05.8: the lines as the trade sent them, for the source checks.
  v_source_lines := p_lines;
  IF p_invoice ? 'hold_lines' THEN
    v_source_lines := public.trade_line_hold_merge_v1(p_lines, p_invoice->'hold_lines');
  END IF;
  IF v_invoice_source = 'weekly_work_order' AND jsonb_array_length(p_lines) = 0 THEN$n$],
    ARRAY[$o$    FROM jsonb_array_elements(p_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$o$,
      $n$    FROM jsonb_array_elements(v_source_lines) AS input(line)
    WHERE NULLIF(line->>'quantity', '') IS NOT NULL$n$],
    ARRAY[$o$    FROM jsonb_array_elements(p_lines) AS input(line)
    LEFT JOIN public.work_orders wo
      ON wo.id = NULLIF(input.line->>'source_work_order_id', '')::uuid
    WHERE COALESCE(input.line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')$o$,
      $n$    FROM jsonb_array_elements(v_source_lines) AS input(line)
    LEFT JOIN public.work_orders wo
      ON wo.id = NULLIF(input.line->>'source_work_order_id', '')::uuid
    WHERE COALESCE(input.line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')$n$],
    ARRAY[$o$        FROM jsonb_array_elements(p_lines) AS input(line)
        WHERE COALESCE(line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')
      ) sources$o$,
      $n$        FROM jsonb_array_elements(v_source_lines) AS input(line)
        WHERE COALESCE(line->>'line_type', '') NOT IN ('final_payout_deduction', 'reimbursement')
      ) sources$n$],
    ARRAY[$o$      FROM jsonb_array_elements(p_lines) AS input(line)
      WHERE COALESCE(line->>'line_type', '') NOT IN (
        'crew_work_order_deduction',$o$,
      $n$      FROM jsonb_array_elements(v_source_lines) AS input(line)
      WHERE COALESCE(line->>'line_type', '') NOT IN (
        'crew_work_order_deduction',$n$],
    ARRAY[$o$        FROM jsonb_array_elements(p_lines) AS input(line)
      ) sources
      JOIN public.trade_invoice_lines existing$o$,
      $n$        FROM jsonb_array_elements(v_source_lines) AS input(line)
      ) sources
      JOIN public.trade_invoice_lines existing$n$],
    ARRAY[$o$        FROM jsonb_array_elements(p_lines) AS input(line)
      ) sources
      JOIN public.trade_invoices parent$o$,
      $n$        FROM jsonb_array_elements(v_source_lines) AS input(line)
      ) sources
      JOIN public.trade_invoices parent$n$]
  ];
BEGIN
  d := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  SELECT md5(prosrc) INTO body_md5 FROM pg_proc
    WHERE oid = 'public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure;
  IF body_md5 = 'fe44f464f3c5c62b35149122f7655cb9' THEN RETURN; END IF;
  IF body_md5 IS DISTINCT FROM '58182c36e4f35a04ef652da81cea4ec7' THEN
    RAISE EXCEPTION 'P1-05.8 weekly persist md5 preimage changed: %', body_md5;
  END IF;
  FOREACH pair SLICE 1 IN ARRAY pairs LOOP
    IF (length(d) - length(replace(d, pair[1], ''))) / length(pair[1]) <> 1 THEN
      RAISE EXCEPTION 'P1-05.8 weekly persist preimage anchor changed: %', left(pair[1], 60);
    END IF;
    d := replace(d, pair[1], pair[2]);
  END LOOP;
  EXECUTE d;
END $patch$;
