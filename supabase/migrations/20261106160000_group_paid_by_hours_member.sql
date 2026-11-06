-- A crew member already paid by the hour on a job no longer stops the rest of
-- the crew being paid through a group (owner, 6 Nov 2026: "just reduce the
-- work order by [that person's] amount and divide the other two up").
--
-- Before: any ordinary pay on a job refused a group on it, so a patio job
-- that must pay through a group, where one crew member had already been paid
-- ordinary hours, left the rest of the crew with no way to be paid.
--
-- Now, for ordinary hours pay (not a whole work-order claim):
-- 1. The group opens. A work-order claim (a "work order" line, or a crew
--    work order line) still refuses a group, as before.
-- 2. The member paid by the hour is not group crew: they are not added, owe
--    no hours, and take no share. Their paid days stay paid.
-- 3. The pot the rest split is the work order amount less what that member
--    was paid, counted the way the group pays: on the full employer super
--    basis a share of B pays gross plus 12% super, so paid gross G uses
--    G plus 12% of G of the pot. The rest split the remainder by hours.
-- 4. The freeze records that amount on the group (hours_paid_ex); the
--    release checks the shares against the pot less it, and stops if the
--    paid-by-hours amount moved after the freeze.
-- 5. Nobody can be paid twice: the paid member's own group share line is
--    refused, and new ordinary hours on a grouped job stay refused.
--
-- "Paid" counts every invoice that is not ops-reject, drafts included, the
-- same reading as the double-pay fence. No row is written by this file, no
-- invoice or Xero bill is touched, nothing sends. The runner supplies the
-- transaction. TypeScript twin: isPaidHoursLine and loadShareView in
-- group_work_order.ts. Change both together.

CREATE OR REPLACE FUNCTION public.group_work_order_line_is_paid_hours(
  p_line_type text,
  p_source_work_order_id uuid,
  p_description text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.group_work_order_line_is_normal_pay(p_line_type, p_source_work_order_id)
    AND NOT public.group_work_order_line_is_office_fee(p_line_type, p_description)
    AND p_source_work_order_id IS NULL
    AND replace(replace(lower(btrim(COALESCE(p_line_type, ''))), '_', ' '), ' ', '') <> 'workorder';
$$;

COMMENT ON FUNCTION public.group_work_order_line_is_paid_hours(text, uuid, text) IS
  '20261106160000: ordinary hours pay on a job (normal pay that is not an office fee and not a work-order claim). It no longer blocks a group; its payee is left out of the split and the pot is reduced by it.';

-- What each payee was paid by the hour on a job, gross ex GST.
CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid(p_job uuid)
RETURNS TABLE(user_id uuid, gross_ex numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.user_id, sum(COALESCE(l.line_total_ex, 0))
  FROM public.trade_invoice_lines l
  JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
  WHERE l.job_id = p_job
    AND i.user_id IS NOT NULL
    AND i.status IS DISTINCT FROM 'ops-reject'
    AND public.group_work_order_line_is_paid_hours(l.line_type, l.source_work_order_id, l.description)
  GROUP BY i.user_id;
$$;

CREATE OR REPLACE FUNCTION public.group_work_order_paid_by_hours(p_job uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE l.job_id = p_job
      AND i.user_id = p_user
      AND i.status IS DISTINCT FROM 'ops-reject'
      AND public.group_work_order_line_is_paid_hours(l.line_type, l.source_work_order_id, l.description)
  );
$$;

-- The pot a paid gross uses up, by the group's pay basis, in whole cents.
CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_budget(p_basis text, p_gross_ex numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE v_gross bigint;
BEGIN
  IF p_gross_ex IS NULL OR p_gross_ex <= 0 THEN RETURN 0; END IF;
  v_gross := round(p_gross_ex * 100)::bigint;
  IF p_basis = 'gross_v1' THEN
    RETURN v_gross / 100.0;
  ELSIF p_basis = 'all_in_12_6_v1' THEN
    RETURN (v_gross + round(v_gross * .12)::bigint - round(v_gross * .06)::bigint) / 100.0;
  ELSIF p_basis = 'all_in_12_v2' THEN
    RETURN (v_gross + round(v_gross * .12)::bigint) / 100.0;
  END IF;
  RAISE EXCEPTION 'group_pay_basis_unsupported';
END;
$$;

CREATE OR REPLACE FUNCTION public.group_work_order_hours_paid_total(p_job uuid, p_basis text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(sum(public.group_work_order_hours_paid_budget(p_basis, h.gross_ex)), 0)
  FROM public.group_work_order_hours_paid(p_job) h;
$$;

REVOKE ALL ON FUNCTION public.group_work_order_line_is_paid_hours(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_hours_paid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_paid_by_hours(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_hours_paid_budget(text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_hours_paid_total(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_line_is_paid_hours(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_hours_paid(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_paid_by_hours(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_hours_paid_budget(text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_hours_paid_total(uuid, text) TO service_role;

ALTER TABLE public.group_work_orders
  ADD COLUMN IF NOT EXISTS hours_paid_ex numeric;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_work_orders_hours_paid_ex_check'
  ) THEN
    ALTER TABLE public.group_work_orders
      ADD CONSTRAINT group_work_orders_hours_paid_ex_check CHECK (hours_paid_ex IS NULL OR hours_paid_ex >= 0);
  END IF;
END $$;
COMMENT ON COLUMN public.group_work_orders.hours_paid_ex IS
  '20261106160000: at the freeze, the pot used by crew already paid by the hour on this job (left out of the split). Null before the freeze.';

-- 1. Ordinary hours no longer refuse a group; a work-order claim still does.
CREATE OR REPLACE FUNCTION public.group_work_orders_refuse_existing_pay()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.group_work_order_lock_job(NEW.job_id);
  IF EXISTS (
    SELECT 1
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE l.job_id = NEW.job_id
      AND i.status IS DISTINCT FROM 'ops-reject'
      AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
      AND NOT public.group_work_order_line_is_office_fee(l.line_type, l.description)
      -- Hours already paid are taken off the pot instead (20261106160000).
      AND NOT public.group_work_order_line_is_paid_hours(l.line_type, l.source_work_order_id, l.description)
  ) THEN
    RAISE EXCEPTION 'group_open_blocked_by_work_order_claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- 5. A share line: a work-order claim on the job still refuses it; ordinary
--    hours refuse it only when they are the share owner's own.
DO $$
DECLARE
  body text;
  before_text text := $old$      WHERE l.job_id = NEW.job_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
        AND NOT public.group_work_order_line_is_office_fee(l.line_type, l.description)
    ) THEN
      RAISE EXCEPTION 'group_share_blocked_by_work_order_claim' USING ERRCODE = '23514';$old$;
  after_text text := $new$      WHERE l.job_id = NEW.job_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
        AND NOT public.group_work_order_line_is_office_fee(l.line_type, l.description)
        -- Someone else's paid hours were taken off the pot (20261106160000).
        AND (
          NOT public.group_work_order_line_is_paid_hours(l.line_type, l.source_work_order_id, l.description)
          OR i.user_id IS NOT DISTINCT FROM (
            SELECT i2.user_id FROM public.trade_invoices i2 WHERE i2.id = NEW.trade_invoice_id
          )
        )
    ) THEN
      RAISE EXCEPTION 'group_share_blocked_by_work_order_claim' USING ERRCODE = '23514';$new$;
BEGIN
  body := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  IF strpos(body, '(20261106160000)') = 0 THEN
    IF strpos(body, before_text) = 0
       OR length(body) - length(replace(body, before_text, '')) <> length(before_text) THEN
      RAISE EXCEPTION 'trade_invoice_lines_group_share_snapshot changed; review before applying 20261106160000';
    END IF;
    EXECUTE replace(body, before_text, after_text);
  END IF;
END $$;

-- 2. The one crew population leaves out anyone paid by the hour on the job.
DO $$
DECLARE
  body text := pg_get_functiondef('public.group_work_order_crew(uuid[])'::regprocedure);
BEGIN
  IF strpos(body, '(20261106160000)') > 0 THEN RETURN; END IF;
  IF strpos(body, $old$    AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') <> 'true'
  UNION
  SELECT g.job_id, p.user_id$old$) = 0
     OR strpos(body, $old$  WHERE g.job_id = ANY(COALESCE(p_job_ids, ARRAY[]::uuid[]))
    AND g.status IS DISTINCT FROM 'void';$old$) = 0 THEN
    RAISE EXCEPTION 'group_work_order_crew changed; review before applying 20261106160000';
  END IF;
  EXECUTE $crew$
CREATE OR REPLACE FUNCTION public.group_work_order_crew(p_job_ids uuid[])
RETURNS TABLE(job_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $body$
  SELECT DISTINCT j.id, a.user_id
  FROM public.jobs j
  JOIN public.job_assignments a ON a.job_id = j.id
  JOIN public.users u ON u.id = a.user_id AND u.org_id = j.org_id
  WHERE j.id = ANY(COALESCE(p_job_ids, ARRAY[]::uuid[]))
    AND lower(COALESCE(u.role::text, '')) <> 'admin'
    AND lower(COALESCE(to_jsonb(a)->>'status', '')) <> 'cancelled'
    AND lower(COALESCE(to_jsonb(a)->>'role', '')) <> 'observer'
    AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') <> 'true'
    -- Paid by the hour on this job: not group crew (20261106160000).
    AND NOT public.group_work_order_paid_by_hours(j.id, a.user_id)
  UNION
  SELECT g.job_id, p.user_id
  FROM public.group_work_orders g
  JOIN public.group_work_order_participants p ON p.group_id = g.id
  WHERE g.job_id = ANY(COALESCE(p_job_ids, ARRAY[]::uuid[]))
    AND g.status IS DISTINCT FROM 'void'
    AND NOT public.group_work_order_paid_by_hours(g.job_id, p.user_id);
$body$;
$crew$;
END $$;

-- 2 and 3. The split leaves out paid-by-hours hours and splits the pot less
--    what they were paid; the freeze records that amount.
DO $$
DECLARE
  body text;
  n int;
  pairs text[][] := ARRAY[
    ARRAY[$o$  v_needs_rate text;
BEGIN$o$, $n$  v_needs_rate text;
  v_basis text;
  v_hours_paid numeric := 0; -- pot used by crew paid by the hour (20261106160000)
BEGIN$n$],
    ARRAY[$o$  v_pot_cents := round(v_pot * 100)::bigint;$o$, $n$  SELECT g.pay_basis INTO v_basis FROM public.group_work_orders g WHERE g.id = p_group_id;
  v_hours_paid := public.group_work_order_hours_paid_total(v_job, v_basis);
  v_pot := v_pot - v_hours_paid;
  IF v_pot <= 0 THEN
    RAISE EXCEPTION 'group_pot_used_by_hours_pay' USING ERRCODE = '23514';
  END IF;
  v_pot_cents := round(v_pot * 100)::bigint;$n$],
    ARRAY[$o$  WHERE e.group_id = p_group_id
    AND e.hours > 0$o$, $n$  WHERE e.group_id = p_group_id
    AND NOT public.group_work_order_paid_by_hours(v_job, e.user_id)
    AND e.hours > 0$n$],
    ARRAY[$o$  SET split_frozen_at = now(), updated_at = now()
  WHERE id = p_group_id;$o$, $n$  SET split_frozen_at = now(), updated_at = now(), hours_paid_ex = round(v_hours_paid, 2)
  WHERE id = p_group_id;$n$],
    ARRAY[$o$    jsonb_build_object('pot_ex', round(v_pot, 2))$o$, $n$    jsonb_build_object('pot_ex', round(v_pot, 2), 'hours_paid_ex', round(v_hours_paid, 2))$n$],
    ARRAY[$o$    RETURN jsonb_build_object('frozen', false, 'shares', v_shares);$o$, $n$    RETURN jsonb_build_object('frozen', false, 'shares', v_shares, 'hours_paid_ex', round(v_hours_paid, 2));$n$]
  ];
BEGIN
  body := pg_get_functiondef('public.group_work_order_write_split(uuid,boolean)'::regprocedure);
  IF strpos(body, '(20261106160000)') > 0 THEN RETURN; END IF;
  FOR n IN 1 .. array_length(pairs, 1) LOOP
    IF strpos(body, pairs[n][1]) = 0
       OR length(body) - length(replace(body, pairs[n][1], '')) <> length(pairs[n][1]) THEN
      RAISE EXCEPTION 'group_work_order_write_split changed at part %; review before applying 20261106160000', n;
    END IF;
    body := replace(body, pairs[n][1], pairs[n][2]);
  END LOOP;
  EXECUTE body;
END $$;

-- 4. The release reconciles the shares against the pot less the recorded
--    hours pay, stops when that pay moved after the freeze, and does not wait
--    on a share for someone paid by the hour.
DO $$
DECLARE
  body text;
  n int;
  pairs text[][] := ARRAY[
    ARRAY[$o$      AND NOT EXISTS (SELECT 1 FROM public.group_work_order_shares x WHERE x.group_id = g.id AND x.user_id = p.user_id)$o$,
          $n$      AND NOT EXISTS (SELECT 1 FROM public.group_work_order_shares x WHERE x.group_id = g.id AND x.user_id = p.user_id)
      AND NOT public.group_work_order_paid_by_hours(g.job_id, p.user_id) -- (20261106160000)$n$],
    ARRAY[$o$  IF g.split_frozen_at IS NOT NULL AND (v_pool IS NULL OR v_allocated IS DISTINCT FROM v_pool) THEN$o$,
          $n$  IF v_pool IS NOT NULL THEN v_pool := v_pool - COALESCE(g.hours_paid_ex, 0); END IF;
  IF g.split_frozen_at IS NOT NULL
     AND COALESCE(g.hours_paid_ex, 0) IS DISTINCT FROM public.group_work_order_hours_paid_total(g.job_id, g.pay_basis) THEN
    v_reasons := array_append(v_reasons, 'hours_paid_changed'::text);
  END IF;
  IF g.split_frozen_at IS NOT NULL AND (v_pool IS NULL OR v_allocated IS DISTINCT FROM v_pool) THEN$n$]
  ];
BEGIN
  body := pg_get_functiondef('public.group_work_order_release_state(uuid)'::regprocedure);
  IF strpos(body, '(20261106160000)') > 0 THEN RETURN; END IF;
  FOR n IN 1 .. array_length(pairs, 1) LOOP
    IF strpos(body, pairs[n][1]) = 0
       OR length(body) - length(replace(body, pairs[n][1], '')) <> length(pairs[n][1]) THEN
      RAISE EXCEPTION 'group_work_order_release_state changed at part %; review before applying 20261106160000', n;
    END IF;
    body := replace(body, pairs[n][1], pairs[n][2]);
  END LOOP;
  EXECUTE body;
END $$;

-- The recorded hours pay is frozen with the split, like the budget.
DO $$
DECLARE
  body text;
  before_text text := $old$    OR NEW.budget_approval_reason IS DISTINCT FROM OLD.budget_approval_reason
  ) THEN RAISE EXCEPTION 'group_split_frozen'$old$;
  after_text text := $new$    OR NEW.budget_approval_reason IS DISTINCT FROM OLD.budget_approval_reason
    OR NEW.hours_paid_ex IS DISTINCT FROM OLD.hours_paid_ex -- (20261106160000)
  ) THEN RAISE EXCEPTION 'group_split_frozen'$new$;
BEGIN
  body := pg_get_functiondef('public.group_work_order_budget_lock()'::regprocedure);
  IF strpos(body, '(20261106160000)') = 0 THEN
    IF strpos(body, before_text) = 0 THEN
      RAISE EXCEPTION 'group_work_order_budget_lock changed; review before applying 20261106160000';
    END IF;
    EXECUTE replace(body, before_text, after_text);
  END IF;
END $$;
-- The lock fires only on the columns it names, so it must name the new one.
DROP TRIGGER IF EXISTS group_work_order_budget_lock ON public.group_work_orders;
CREATE TRIGGER group_work_order_budget_lock
  BEFORE UPDATE OF pay_basis, approved_budget_ex, budget_approved_by, budget_approved_at, budget_approval_reason, hours_paid_ex
  ON public.group_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.group_work_order_budget_lock();
