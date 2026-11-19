-- P1-13.4 follow-up (director's pay read, 19 Nov 2026): a group on the
-- inclusive basis (inclusive_12_112_v1) takes hourly pay billed on an
-- old-rule invoice off its pot at what that pay cost the company: the gross
-- plus the company's own super on it.
--
-- 20261118170300 counts every hourly payment at its gross for an inclusive
-- group. That is right for hourly pay priced on the one super rule (super is
-- inside the gross). It is wrong for hourly pay priced on an older rule,
-- where the company paid super on top: the pot came out too big by that
-- super and the shares paid it a second time.
--
-- The company's own super on a billed hourly line is read from the invoice's
-- stamped rule (trade_invoices.super_basis and its stored split), never from
-- a date or the switch, and worked on the line's own gross in whole cents:
--   inclusive_12_112_v1                  0 (super inside the gross)
--   null, 12% fund less 6% withheld      round(G x 12%) - round(G x 6%)
--   null, full 12% withheld (carve-out)  0 (the person paid it all)
--   null, no split stored (before super) 0 (no super was recorded)
--   employer_12_v2                       round(G x 12%)
-- A null-basis invoice whose split matches none of these refuses
-- (group_hours_invoice_split_unknown); an unknown basis refuses
-- (group_pay_basis_unsupported). Neither reads as 0.
--
-- Replaces group_work_order_hours_paid_total(uuid,text) only, and only its
-- inclusive branch: every other basis runs main's expression, character for
-- character, so no existing group's pot moves by a cent. Adds one read-only
-- helper. The split, the release check and the claim confirm already read
-- hours_paid_total, so they all follow. No table, trigger, schedule, switch
-- or row write. The runner supplies the transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Rule 15 pre-image guard: hours_paid_total holds main's body
-- (20261106160000) or this file's own body on a re-apply; the helper is
-- absent or holds this file's body. Anything else refuses.
DO $guard$
DECLARE v_md5 text;
/* block */ BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.group_work_order_hours_paid_total(uuid,text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('88c6927c03ef2485b10d76859c6cf160', '83c3347b2d203e623886089a488481c9') THEN
    RAISE EXCEPTION 'p1_13_4b_preimage_mismatch: group_work_order_hours_paid_total(uuid,text) (%)',
      coalesce(v_md5, 'missing');
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.group_work_order_hours_paid_company_super(uuid)');
  IF v_md5 IS NOT NULL AND v_md5 <> '2b9e41c9a55b676b07931fa5048a4979' THEN
    RAISE EXCEPTION 'p1_13_4b_preimage_mismatch: group_work_order_hours_paid_company_super(uuid) (%)', v_md5;
  END IF;
END $guard$;

-- The company's own super on the hourly pay billed on a job, in whole cents
-- per invoice, from each invoice's stamped rule (table above).
CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_company_super(p_job uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_g bigint;
  v_total bigint := 0;
BEGIN
  FOR r IN
    SELECT i.id, i.super_basis, i.gross_earned, i.net_pay, i.super_amount, i.super_base_ex,
      sum(COALESCE(l.line_total_ex, 0)) AS gross_ex
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE l.job_id = p_job
      AND i.user_id IS NOT NULL
      AND public.group_work_order_invoice_billed(i.status, i.xero_bill_id, i.xero_bill_status)
      AND public.group_work_order_line_is_paid_hours(l.line_type, l.source_work_order_id, l.description)
    GROUP BY i.id, i.super_basis, i.gross_earned, i.net_pay, i.super_amount, i.super_base_ex
  LOOP
    v_g := round(r.gross_ex * 100)::bigint;
    IF v_g <= 0 OR r.super_basis = 'inclusive_12_112_v1' THEN
      CONTINUE;
    ELSIF r.super_basis = 'employer_12_v2' THEN
      v_total := v_total + round(v_g * .12)::bigint;
    ELSIF r.super_basis IS NOT NULL THEN
      RAISE EXCEPTION 'group_pay_basis_unsupported';
    ELSIF r.gross_earned IS NULL THEN
      CONTINUE;
    ELSIF r.net_pay = round(r.gross_earned - round(COALESCE(r.super_base_ex, r.gross_earned) * 0.06, 2), 2) THEN
      v_total := v_total + round(v_g * .12)::bigint - round(v_g * .06)::bigint;
    ELSIF r.super_base_ex IS NULL AND r.net_pay = round(r.gross_earned - r.super_amount, 2) THEN
      CONTINUE;
    ELSE
      RAISE EXCEPTION 'group_hours_invoice_split_unknown: %', r.id;
    END IF;
  END LOOP;
  RETURN v_total / 100.0;
END;
$$;

COMMENT ON FUNCTION public.group_work_order_hours_paid_company_super(uuid) IS
  '20261119090500: the company''s own super on the hourly pay billed on a job (old-rule invoices only; 0 under the one super rule). Added to an inclusive group''s hourly deduction.';

CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_total(p_job uuid, p_basis text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_basis IS DISTINCT FROM 'inclusive_12_112_v1' THEN (
  SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(p_basis, h.gross_ex)), 0)
  FROM public.group_work_order_hours_paid(p_job) h
  ) ELSE (
  SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(p_basis, h.gross_ex)), 0)
  FROM public.group_work_order_hours_paid(p_job) h
  ) + public.group_work_order_hours_paid_company_super(p_job) END; -- (20261119090500)
$$;

REVOKE ALL ON FUNCTION public.group_work_order_hours_paid_company_super(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_hours_paid_company_super(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.group_work_order_hours_paid_total(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_hours_paid_total(uuid, text) TO service_role;
