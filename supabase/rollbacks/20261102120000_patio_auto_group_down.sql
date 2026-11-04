-- Undo 20261102120000_patio_auto_group: the fence counts office milestone
-- fees as normal pay again (definitions as in 20261022050000 and
-- 20261030133000), and the view, the helper and the flag go.
DROP VIEW IF EXISTS public.v_patio_group_coverage;

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
  ) THEN
    RAISE EXCEPTION 'group_open_blocked_by_work_order_claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trade_invoice_lines_group_share_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_type text;
  v_group uuid;
  v_job uuid;
  v_basis text;
  v_invoice_user uuid;
  v_invoice_status text;
  v_invoice_basis text;
  v_share_id uuid;
  v_share_user uuid;
  v_share_ex numeric;
  v_frozen timestamptz;
  v_groups int;
BEGIN
  v_type := lower(btrim(COALESCE(NEW.line_type, '')));

  IF v_type = 'group share' OR NEW.group_share_id IS NOT NULL THEN
    IF NEW.job_id IS NULL OR NEW.trade_invoice_id IS NULL THEN
      RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM public.group_work_order_lock_job(NEW.job_id);
    SELECT count(*) INTO v_groups
    FROM public.group_work_orders g
    WHERE g.job_id = NEW.job_id AND g.status <> 'void';
    IF v_groups = 0 THEN
      RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_groups > 1 THEN
      RAISE EXCEPTION 'group_work_order_ambiguous' USING ERRCODE = '23514';
    END IF;
    SELECT g.id, g.job_id, g.split_frozen_at, g.pay_basis
      INTO v_group, v_job, v_frozen, v_basis
    FROM public.group_work_orders g
    WHERE g.job_id = NEW.job_id AND g.status <> 'void'
    FOR UPDATE;
    IF EXISTS (
      SELECT 1
      FROM public.trade_invoice_lines l
      JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.job_id = NEW.job_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
    ) THEN
      RAISE EXCEPTION 'group_share_blocked_by_work_order_claim' USING ERRCODE = '23514';
    END IF;
    SELECT i.user_id, i.status, i.super_basis INTO v_invoice_user, v_invoice_status, v_invoice_basis
    FROM public.trade_invoices i
    WHERE i.id = NEW.trade_invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NOT public.group_client_signoff_counts(v_job) THEN
      RAISE EXCEPTION 'group_client_signoff_required' USING ERRCODE = '23514';
    END IF;
    -- A draft does not freeze and does not hold the share. A non-draft
    -- line freezes in this statement when the marker is still null.
    IF v_invoice_status = 'draft' AND v_frozen IS NULL THEN
      NEW.group_share_id := NULL;
      NEW.line_type := 'group share';
      NEW.source_work_order_id := NULL;
      RETURN NEW;
    END IF;
    -- Full employer super is priced on its own invoice; every other basis
    -- stays on the ordinary split.
    IF (v_basis = 'all_in_12_v2') IS DISTINCT FROM (v_invoice_basis IS NOT DISTINCT FROM 'employer_12_v2') THEN
      RAISE EXCEPTION 'group_super_basis_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_invoice_status IS DISTINCT FROM 'draft' AND v_frozen IS NULL THEN
      PERFORM public.group_work_order_write_split(v_group, true);
    END IF;
    SELECT s.id, s.user_id, s.share_ex
      INTO v_share_id, v_share_user, v_share_ex
    FROM public.group_work_order_shares s
    WHERE s.group_id = v_group AND s.user_id = v_invoice_user;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group_share_not_in_split' USING ERRCODE = '23514';
    END IF;
    IF NEW.group_share_id IS NOT NULL AND NEW.group_share_id IS DISTINCT FROM v_share_id THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_invoice_user IS DISTINCT FROM v_share_user THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.trade_invoice_lines l
      JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.group_share_id = v_share_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND i.status IS DISTINCT FROM 'draft'
    ) THEN
      RAISE EXCEPTION 'group_share_already_invoiced' USING ERRCODE = '23514';
    END IF;
    IF NEW.line_total_ex IS DISTINCT FROM (public.group_work_order_share_pay(v_group,v_share_ex)->>'invoice_ex')::numeric THEN
      RAISE EXCEPTION 'group_share_amount_mismatch' USING ERRCODE = '23514';
    END IF;
    NEW.group_share_id := v_share_id;
    NEW.line_type := 'group share';
    NEW.source_work_order_id := NULL;
    RETURN NEW;
  END IF;

  -- An employer-super invoice carries its group share and nothing else.
  IF NEW.trade_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trade_invoices i WHERE i.id = NEW.trade_invoice_id AND i.super_basis IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'group_super_basis_mismatch' USING ERRCODE = '23514';
  END IF;

  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF public.group_work_order_line_is_normal_pay(NEW.line_type, NEW.source_work_order_id) THEN
    PERFORM public.group_work_order_lock_job(NEW.job_id);
    IF EXISTS (
      SELECT 1 FROM public.group_work_orders g
      WHERE g.job_id = NEW.job_id AND g.status <> 'void'
    ) THEN
      RAISE EXCEPTION 'work_order_claim_blocked_by_group_share' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.group_work_order_line_is_office_fee(text, text);
DELETE FROM public.feature_flags WHERE flag_name = 'group_work_order_auto_patio_v1';
