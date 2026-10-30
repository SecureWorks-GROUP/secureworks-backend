-- Group jobs: full 12% employer super inside each share, and one payment
-- release for the whole crew.
--
-- Owner, 30 Oct 2026: "Yes — pay plus full 12% super inside the pool" for
-- GROUP jobs (no 6% taken from the worker). Ordinary invoices keep the
-- 6% worker / 6% company split. Owner, 30 Oct 2026, for Zoo SWP-261247:
-- "Correct to 12% first".
--
-- 1. all_in_12_v2: share = gross + round(12% of gross); nothing withheld.
-- 2. trade_invoices.super_basis marks an invoice priced that way.
-- 3. A group is released for payment once, under the job lock, only when
--    every positive share has exactly one live, approved, correctly priced
--    invoice, the sign-off counts and the shares add up to the pool. After
--    release, nothing that would undo that may change.
-- 4. amend_group_work_order_pay_basis: one owner-attributed move of a frozen
--    12/6 group to all_in_12_v2. It returns that group's open share invoices
--    to their trades with the reason, logs before and after, and changes
--    nothing that is in Xero or approved for payment.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── 1. basis ────────────────────────────────────────────────────────────────

ALTER TABLE public.group_work_orders DROP CONSTRAINT group_work_orders_pay_basis_check;
ALTER TABLE public.group_work_orders ADD CONSTRAINT group_work_orders_pay_basis_check
  CHECK (pay_basis IN ('gross_v1', 'all_in_12_6_v1', 'all_in_12_v2'));

ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS super_basis text;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_basis_check
  CHECK (super_basis IS NULL OR super_basis = 'employer_12_v2');
COMMENT ON COLUMN public.trade_invoices.super_basis IS
  'Null: the ordinary split (6% withheld from the worker, 6% company). employer_12_v2: a group share where the company pays all 12% super inside the share; net_pay equals gross_earned.';

-- Same split rule as before, plus the employer basis. Existing rows all have
-- super_basis null, so they are checked exactly as before.
ALTER TABLE public.trade_invoices DROP CONSTRAINT trade_invoices_super_gst_split_check;
ALTER TABLE public.trade_invoices ADD CONSTRAINT trade_invoices_super_gst_split_check CHECK (
  ((gst_on IS NULL) AND (super_rate IS NULL) AND (super_amount IS NULL) AND (gross_earned IS NULL) AND (net_pay IS NULL) AND (super_basis IS NULL))
  OR ((gst_on IS NOT NULL) AND (super_rate = 0.12) AND (super_amount >= 0) AND (gross_earned >= 0) AND (net_pay >= 0)
    AND (gross_earned = round(subtotal_ex, 2))
    AND (super_amount = round(gross_earned * super_rate, 2))
    AND (
      (super_basis IS NULL AND ((net_pay = round(gross_earned - round(gross_earned * 0.06, 2), 2)) OR (net_pay = round(gross_earned - super_amount, 2))))
      OR (super_basis = 'employer_12_v2' AND net_pay = gross_earned)
    )
    AND (gst = CASE WHEN gst_on THEN round(gross_earned * 0.10, 2) ELSE 0 END)
    AND (total_inc = round(gross_earned + gst, 2)))
);

-- One trusted cents calculation per basis. Pure, so a basis amendment can
-- show before and after without touching the group.
CREATE OR REPLACE FUNCTION public.group_work_order_pay_for_basis(p_basis text, p_budget_ex numeric)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_budget bigint; v_gross bigint; v_super bigint; v_withhold bigint; v_cost bigint;
BEGIN
  IF p_budget_ex IS NULL OR p_budget_ex < 0 THEN RAISE EXCEPTION 'group_share_amount_invalid'; END IF;
  v_budget := round(p_budget_ex * 100)::bigint;
  IF p_basis = 'gross_v1' THEN
    v_gross := v_budget;
  ELSIF p_basis = 'all_in_12_6_v1' THEN
    v_gross := floor(v_budget::numeric / 1.06)::bigint;
    WHILE v_gross + round(v_gross * .12)::bigint - round(v_gross * .06)::bigint > v_budget LOOP v_gross := v_gross - 1; END LOOP;
    WHILE v_gross + 1 + round((v_gross + 1) * .12)::bigint - round((v_gross + 1) * .06)::bigint <= v_budget LOOP v_gross := v_gross + 1; END LOOP;
  ELSIF p_basis = 'all_in_12_v2' THEN
    -- Largest whole-cent gross whose gross plus 12% super fits the share.
    v_gross := floor(v_budget::numeric / 1.12)::bigint;
    WHILE v_gross + round(v_gross * .12)::bigint > v_budget LOOP v_gross := v_gross - 1; END LOOP;
    WHILE v_gross + 1 + round((v_gross + 1) * .12)::bigint <= v_budget LOOP v_gross := v_gross + 1; END LOOP;
  ELSE
    RAISE EXCEPTION 'group_pay_basis_unsupported';
  END IF;
  v_super := round(v_gross * .12)::bigint;
  v_withhold := CASE WHEN p_basis = 'all_in_12_6_v1' THEN round(v_gross * .06)::bigint ELSE 0 END;
  IF p_basis = 'gross_v1' THEN v_withhold := round(v_gross * .06)::bigint; END IF;
  v_cost := v_gross + v_super - v_withhold;
  RETURN jsonb_build_object('pay_basis', p_basis, 'budget_ex', v_budget / 100.0, 'invoice_ex', v_gross / 100.0,
    'cash_pay', (v_gross - v_withhold) / 100.0, 'super_amount', v_super / 100.0,
    'company_contribution', (v_super - v_withhold) / 100.0, 'company_total_out', v_cost / 100.0,
    'budget_remainder', CASE WHEN p_basis = 'gross_v1' THEN NULL ELSE (v_budget - v_cost) / 100.0 END);
END; $$;
REVOKE ALL ON FUNCTION public.group_work_order_pay_for_basis(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_pay_for_basis(text, numeric) TO service_role;

-- share_pay keeps every output key: it now returns group_work_order_pay_for_basis(), which builds them.
-- output-key-guard: drop public.group_work_order_share_pay pay_basis
-- output-key-guard: drop public.group_work_order_share_pay budget_ex
-- output-key-guard: drop public.group_work_order_share_pay invoice_ex
-- output-key-guard: drop public.group_work_order_share_pay cash_pay
-- output-key-guard: drop public.group_work_order_share_pay super_amount
-- output-key-guard: drop public.group_work_order_share_pay company_contribution
-- output-key-guard: drop public.group_work_order_share_pay company_total_out
-- output-key-guard: drop public.group_work_order_share_pay budget_remainder
CREATE OR REPLACE FUNCTION public.group_work_order_share_pay(p_group_id uuid, p_budget_ex numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_basis text;
BEGIN
  SELECT pay_basis INTO STRICT v_basis FROM public.group_work_orders WHERE id = p_group_id;
  RETURN public.group_work_order_pay_for_basis(v_basis, p_budget_ex);
END; $$;
REVOKE ALL ON FUNCTION public.group_work_order_share_pay(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_share_pay(uuid, numeric) TO service_role;

-- ── 2. audit and release records ────────────────────────────────────────────

ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
  CHECK (action IN ('freeze', 'unfreeze', 'revoke_signoff', 'void_group', 'rekey', 'remove_participant',
    'approve_budget', 'amend_pay_basis', 'release'));

CREATE TABLE IF NOT EXISTS public.group_work_order_releases (
  group_id uuid PRIMARY KEY REFERENCES public.group_work_orders(id) ON DELETE RESTRICT,
  released_at timestamptz NOT NULL DEFAULT now(),
  released_by text NOT NULL,
  snapshot jsonb NOT NULL
);
COMMENT ON TABLE public.group_work_order_releases IS
  'One row when a group''s crew pay is released together. Written only by claim_group_work_order_release under the job lock, before any Xero call. Append-only.';
ALTER TABLE public.group_work_order_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.group_work_order_releases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.group_work_order_releases TO service_role;
CREATE TRIGGER trg_group_work_order_releases_append_only
  BEFORE UPDATE OR DELETE ON public.group_work_order_releases
  FOR EACH ROW EXECUTE FUNCTION public.group_work_order_events_append_only();

-- ── 3. budget lock: a frozen group's basis moves only by a logged amendment ──

CREATE OR REPLACE FUNCTION public.group_work_order_budget_lock()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.split_frozen_at IS NOT NULL AND (
    NEW.approved_budget_ex IS DISTINCT FROM OLD.approved_budget_ex
    OR NEW.budget_approved_by IS DISTINCT FROM OLD.budget_approved_by
    OR NEW.budget_approved_at IS DISTINCT FROM OLD.budget_approved_at
    OR NEW.budget_approval_reason IS DISTINCT FROM OLD.budget_approval_reason
  ) THEN RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514'; END IF;
  IF OLD.split_frozen_at IS NOT NULL AND NEW.pay_basis IS DISTINCT FROM OLD.pay_basis AND NOT EXISTS (
    -- amend_group_work_order_pay_basis logs the amendment first, in this
    -- same transaction. Events are insert-only, service role only.
    SELECT 1 FROM public.group_work_order_events e
    WHERE e.group_id = OLD.id AND e.action = 'amend_pay_basis' AND e.created_at = now()
      AND e.detail->>'from' = OLD.pay_basis AND e.detail->>'to' = NEW.pay_basis
  ) THEN RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$;

-- ── 4. share line: invoice super basis must match the group's basis ─────────

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

-- ── 5. release readiness: one server calculation ────────────────────────────

CREATE OR REPLACE FUNCTION public.group_work_order_release_state(p_group_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g record; s record; l record;
  v_reasons text[] := ARRAY[]::text[];
  v_people jsonb := '[]'::jsonb;
  v_live int; v_state text; v_expected numeric; v_pool numeric; v_allocated numeric := 0;
  v_signoff text; v_released timestamptz; v_positive int := 0; v_invoiced int := 0; v_approved int := 0;
BEGIN
  SELECT * INTO g FROM public.group_work_orders WHERE id = p_group_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ready', false, 'released', false, 'reasons', jsonb_build_array('group_not_found'));
  END IF;
  SELECT r.released_at INTO v_released FROM public.group_work_order_releases r WHERE r.group_id = g.id;
  IF g.status = 'void' THEN v_reasons := array_append(v_reasons, 'group_void'::text); END IF;
  IF g.split_frozen_at IS NULL THEN v_reasons := array_append(v_reasons, 'shares_not_final'::text); END IF;
  SELECT CASE WHEN s2.method = 'office_waiver' THEN 'office' WHEN s2.method IN ('on_site', 'share_link') THEN 'client' END
    INTO v_signoff
  FROM public.job_client_signoffs s2 WHERE s2.job_id = g.job_id
  ORDER BY s2.created_at DESC, s2.id::text COLLATE "C" DESC LIMIT 1;
  IF NOT public.group_client_signoff_counts(g.job_id) THEN
    v_reasons := array_append(v_reasons, 'signoff_not_current'::text);
    v_signoff := NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.group_work_order_participants p
    WHERE p.group_id = g.id
      AND NOT EXISTS (SELECT 1 FROM public.group_work_order_shares x WHERE x.group_id = g.id AND x.user_id = p.user_id)
  ) AND g.split_frozen_at IS NOT NULL THEN
    v_reasons := array_append(v_reasons, 'participant_without_share'::text);
  END IF;

  FOR s IN SELECT * FROM public.group_work_order_shares WHERE group_id = g.id ORDER BY user_id LOOP
    v_allocated := v_allocated + s.share_ex;
    IF s.share_ex <= 0 THEN
      v_people := v_people || jsonb_build_object('user_id', s.user_id, 'state', 'no_share');
      CONTINUE;
    END IF;
    v_positive := v_positive + 1;
    SELECT count(*) INTO v_live
    FROM public.trade_invoice_lines li JOIN public.trade_invoices i ON i.id = li.trade_invoice_id
    WHERE li.group_share_id = s.id AND i.status NOT IN ('ops-reject', 'draft');
    IF v_live = 0 THEN
      v_state := 'not_invoiced'; v_reasons := array_append(v_reasons, 'share_not_invoiced'::text);
    ELSIF v_live > 1 THEN
      v_state := 'duplicate'; v_reasons := array_append(v_reasons, 'share_duplicate'::text);
    ELSE
      v_invoiced := v_invoiced + 1;
      SELECT li.line_total_ex, li.office_review_status, i.status, i.super_basis, i.id AS invoice_id
        INTO l
      FROM public.trade_invoice_lines li JOIN public.trade_invoices i ON i.id = li.trade_invoice_id
      WHERE li.group_share_id = s.id AND i.status NOT IN ('ops-reject', 'draft');
      v_expected := (public.group_work_order_pay_for_basis(g.pay_basis, s.share_ex)->>'invoice_ex')::numeric;
      IF l.line_total_ex IS DISTINCT FROM v_expected
         OR (g.pay_basis = 'all_in_12_v2') IS DISTINCT FROM (l.super_basis IS NOT DISTINCT FROM 'employer_12_v2') THEN
        v_state := 'mismatch'; v_reasons := array_append(v_reasons, 'share_amount_mismatch'::text);
      ELSIF l.office_review_status IN ('queried', 'rejected') THEN
        -- The office can still stop a share by querying it.
        v_state := 'queried'; v_reasons := array_append(v_reasons, 'share_queried'::text);
      ELSIF l.office_review_status = 'approved' AND l.status IN ('approved', 'acknowledged', 'pushed_to_xero', 'paid') THEN
        v_state := 'approved'; v_approved := v_approved + 1;
      ELSIF g.pay_basis = 'all_in_12_v2' AND l.status IN ('pending_acknowledgment', 'approved', 'acknowledged') THEN
        -- Owner, 30 Oct 2026: on these groups the crew approve each other's
        -- hours and the client (or office) signs off; the office does not
        -- approve each share. The release approves them together.
        v_state := 'submitted';
      ELSE
        v_state := 'submitted'; v_reasons := array_append(v_reasons, 'share_not_approved'::text);
      END IF;
    END IF;
    v_people := v_people || jsonb_build_object('user_id', s.user_id, 'state', v_state);
  END LOOP;
  IF v_positive = 0 AND g.split_frozen_at IS NOT NULL THEN v_reasons := array_append(v_reasons, 'no_positive_share'::text); END IF;

  SELECT COALESCE(g.approved_budget_ex, wo.agreed_labour_ex) INTO v_pool
  FROM public.work_orders wo WHERE wo.id = g.work_order_id;
  IF v_pool IS NULL AND g.approved_budget_ex IS NOT NULL THEN v_pool := g.approved_budget_ex; END IF;
  IF g.split_frozen_at IS NOT NULL AND (v_pool IS NULL OR v_allocated IS DISTINCT FROM v_pool) THEN
    v_reasons := array_append(v_reasons, 'pool_not_reconciled'::text);
  END IF;

  RETURN jsonb_build_object(
    'group_id', g.id, 'job_id', g.job_id, 'pay_basis', g.pay_basis,
    'ready', cardinality(v_reasons) = 0, 'released', v_released IS NOT NULL, 'released_at', v_released,
    'reasons', to_jsonb(ARRAY(SELECT DISTINCT unnest(v_reasons) ORDER BY 1)),
    'people', v_people, 'signoff', v_signoff,
    'pool_ex', v_pool, 'allocated_ex', v_allocated,
    'total', v_positive, 'invoiced', v_invoiced, 'approved', v_approved);
END; $$;
REVOKE ALL ON FUNCTION public.group_work_order_release_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_release_state(uuid) TO service_role;

-- Takes the job lock, rechecks readiness and records the release before any
-- Xero call. Calling it again after release returns the same release.
CREATE OR REPLACE FUNCTION public.claim_group_work_order_release(p_group_id uuid, p_actor text, p_actor_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_job uuid; v_state jsonb;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' THEN RAISE EXCEPTION 'group_release_actor_required' USING ERRCODE = '22023'; END IF;
  SELECT job_id INTO v_job FROM public.group_work_orders WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.group_work_order_lock_job(v_job);
  IF EXISTS (SELECT 1 FROM public.group_work_order_releases WHERE group_id = p_group_id) THEN
    RETURN jsonb_build_object('claimed', true, 'existing', true, 'state', public.group_work_order_release_state(p_group_id));
  END IF;
  v_state := public.group_work_order_release_state(p_group_id);
  IF NOT (v_state->>'ready')::boolean THEN
    RETURN jsonb_build_object('claimed', false, 'existing', false, 'state', v_state);
  END IF;
  IF v_state->>'pay_basis' = 'all_in_12_v2' THEN
    -- Approve every live share together, before the release row exists.
    UPDATE public.trade_invoice_lines l
       SET office_review_status = 'approved', office_reviewed_at = now(),
           office_review_note = 'Released with the whole crew: hours approved by the crew and the job signed off.'
      FROM public.group_work_order_shares s, public.trade_invoices i
     WHERE l.group_share_id = s.id AND s.group_id = p_group_id AND i.id = l.trade_invoice_id
       AND i.status NOT IN ('ops-reject', 'draft') AND l.office_review_status IS DISTINCT FROM 'approved';
    UPDATE public.trade_invoices i SET status = 'approved'
     WHERE i.status = 'pending_acknowledgment' AND i.id IN (
       SELECT l.trade_invoice_id FROM public.trade_invoice_lines l
       JOIN public.group_work_order_shares s ON s.id = l.group_share_id
       WHERE s.group_id = p_group_id);
    v_state := public.group_work_order_release_state(p_group_id);
    IF NOT (v_state->>'ready')::boolean OR (v_state->>'approved')::int <> (v_state->>'total')::int THEN
      RAISE EXCEPTION 'group_release_approval_failed' USING ERRCODE = '23514';
    END IF;
  END IF;
  INSERT INTO public.group_work_order_releases (group_id, released_by, snapshot) VALUES (p_group_id, p_actor, v_state);
  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (p_group_id, v_job, 'release', p_actor_user_id, jsonb_build_object('actor', p_actor, 'state', v_state));
  RETURN jsonb_build_object('claimed', true, 'existing', false, 'state', public.group_work_order_release_state(p_group_id));
END; $$;
REVOKE ALL ON FUNCTION public.claim_group_work_order_release(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_group_work_order_release(uuid, text, uuid) TO service_role;

-- ── 6. after release nothing may undo it ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.group_work_order_job_released(p_job uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_work_order_releases r JOIN public.group_work_orders g ON g.id = r.group_id
    WHERE g.job_id = p_job
  );
$$;

CREATE OR REPLACE FUNCTION public.trade_invoice_lines_group_release_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.group_share_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- A draft or returned invoice holds no share; its lines may be replaced.
  -- A line whose invoice is already gone is part of that invoice's delete,
  -- which trade_invoices_group_release_guard has already allowed.
  IF NOT EXISTS (
    SELECT 1 FROM public.trade_invoices i
    WHERE i.id = OLD.trade_invoice_id AND i.status NOT IN ('draft', 'ops-reject')
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.office_review_status IS NOT DISTINCT FROM OLD.office_review_status
     AND NEW.line_total_ex IS NOT DISTINCT FROM OLD.line_total_ex
     AND NEW.group_share_id IS NOT DISTINCT FROM OLD.group_share_id
     AND NEW.trade_invoice_id IS NOT DISTINCT FROM OLD.trade_invoice_id THEN
    RETURN NEW;
  END IF;
  PERFORM public.group_work_order_lock_job(OLD.job_id);
  IF public.group_work_order_job_released(OLD.job_id) THEN
    RAISE EXCEPTION 'group_released' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;
CREATE TRIGGER trg_trade_invoice_lines_group_release_guard
  BEFORE UPDATE OR DELETE ON public.trade_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_group_release_guard();

CREATE OR REPLACE FUNCTION public.trade_invoices_group_release_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_job uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('draft', 'ops-reject') THEN RETURN OLD; END IF;
    FOR v_job IN
      SELECT DISTINCT l.job_id FROM public.trade_invoice_lines l
      WHERE l.trade_invoice_id = OLD.id AND l.group_share_id IS NOT NULL AND l.job_id IS NOT NULL
    LOOP
      PERFORM public.group_work_order_lock_job(v_job);
      IF public.group_work_order_job_released(v_job) THEN
        RAISE EXCEPTION 'group_released' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    RETURN OLD;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.status NOT IN ('draft', 'pending_acknowledgment', 'queried', 'pending_ops_review', 'ops-reject') THEN
    RETURN NEW;
  END IF;
  FOR v_job IN
    SELECT DISTINCT l.job_id FROM public.trade_invoice_lines l
    WHERE l.trade_invoice_id = OLD.id AND l.group_share_id IS NOT NULL AND l.job_id IS NOT NULL
  LOOP
    PERFORM public.group_work_order_lock_job(v_job);
    IF public.group_work_order_job_released(v_job) THEN
      RAISE EXCEPTION 'group_released' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_trade_invoices_group_release_guard
  BEFORE UPDATE OF status OR DELETE ON public.trade_invoices
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoices_group_release_guard();

CREATE OR REPLACE FUNCTION public.job_client_signoffs_group_release_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.group_work_order_lock_job(NEW.job_id);
  IF public.group_work_order_job_released(NEW.job_id) THEN
    RAISE EXCEPTION 'group_released' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_job_client_signoffs_group_release_guard
  BEFORE INSERT ON public.job_client_signoffs
  FOR EACH ROW WHEN (NEW.method = 'revoked')
  EXECUTE FUNCTION public.job_client_signoffs_group_release_guard();

CREATE OR REPLACE FUNCTION public.group_work_orders_release_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.split_frozen_at IS DISTINCT FROM OLD.split_frozen_at
      OR NEW.pay_basis IS DISTINCT FROM OLD.pay_basis
      OR NEW.approved_budget_ex IS DISTINCT FROM OLD.approved_budget_ex
      OR (NEW.status = 'void' AND OLD.status <> 'void'))
     AND EXISTS (SELECT 1 FROM public.group_work_order_releases r WHERE r.group_id = OLD.id) THEN
    RAISE EXCEPTION 'group_released' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_group_work_orders_release_guard
  BEFORE UPDATE ON public.group_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.group_work_orders_release_guard();

REVOKE ALL ON FUNCTION public.group_work_order_job_released(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trade_invoice_lines_group_release_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trade_invoices_group_release_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_client_signoffs_group_release_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_orders_release_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_job_released(uuid) TO service_role;

-- ── 7. owner-attributed move of a frozen 12/6 group to full employer super ──

CREATE OR REPLACE FUNCTION public.amend_group_work_order_pay_basis(
  p_group_id uuid, p_to_basis text, p_owner_user_id uuid, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g record; inv record; s record;
  v_returned jsonb := '[]'::jsonb; v_shares jsonb := '[]'::jsonb;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF p_to_basis IS DISTINCT FROM 'all_in_12_v2' THEN RAISE EXCEPTION 'group_basis_amend_unsupported' USING ERRCODE = '22023'; END IF;
  IF p_owner_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_owner_user_id) THEN
    RAISE EXCEPTION 'group_basis_amend_owner_required' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) < 10 THEN RAISE EXCEPTION 'group_basis_amend_reason_required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO g FROM public.group_work_orders WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.group_work_order_lock_job(g.job_id);
  SELECT * INTO g FROM public.group_work_orders WHERE id = p_group_id FOR UPDATE;
  IF g.status = 'void' THEN RAISE EXCEPTION 'group_work_order_void' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_order_releases WHERE group_id = g.id) THEN
    RAISE EXCEPTION 'group_released' USING ERRCODE = '23514';
  END IF;
  IF g.pay_basis = p_to_basis THEN RAISE EXCEPTION 'group_basis_unchanged' USING ERRCODE = '23514'; END IF;
  IF g.pay_basis IS DISTINCT FROM 'all_in_12_6_v1' THEN RAISE EXCEPTION 'group_basis_amend_unsupported' USING ERRCODE = '22023'; END IF;

  FOR s IN SELECT * FROM public.group_work_order_shares WHERE group_id = g.id ORDER BY user_id LOOP
    v_shares := v_shares || jsonb_build_object('user_id', s.user_id, 'share_ex', s.share_ex,
      'before', public.group_work_order_pay_for_basis(g.pay_basis, s.share_ex),
      'after', public.group_work_order_pay_for_basis(p_to_basis, s.share_ex));
  END LOOP;

  FOR inv IN
    SELECT DISTINCT i.id, i.status, i.xero_bill_id, i.invoice_number, i.user_id, i.query_note
    FROM public.trade_invoices i
    JOIN public.trade_invoice_lines l ON l.trade_invoice_id = i.id
    JOIN public.group_work_order_shares sh ON sh.id = l.group_share_id
    WHERE sh.group_id = g.id AND i.status NOT IN ('ops-reject', 'draft')
  LOOP
    IF inv.xero_bill_id IS NOT NULL OR inv.status NOT IN ('pending_acknowledgment', 'approved', 'acknowledged') THEN
      RAISE EXCEPTION 'group_invoice_past_review' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.trade_invoice_lines x WHERE x.trade_invoice_id = inv.id AND x.group_share_id IS NULL) THEN
      RAISE EXCEPTION 'group_invoice_has_other_lines' USING ERRCODE = '23514';
    END IF;
    UPDATE public.trade_invoice_lines
       SET office_review_status = 'rejected', office_reviewed_by = p_owner_user_id,
           office_reviewed_at = now(), office_review_note = v_reason
     WHERE trade_invoice_id = inv.id;
    UPDATE public.trade_invoices
       SET status = 'ops-reject', query_note = left(concat_ws(' | ', nullif(inv.query_note, ''), v_reason), 2000)
     WHERE id = inv.id;
    v_returned := v_returned || jsonb_build_object('invoice_id', inv.id, 'invoice_number', inv.invoice_number,
      'user_id', inv.user_id, 'status_before', inv.status);
  END LOOP;

  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (g.id, g.job_id, 'amend_pay_basis', p_owner_user_id, jsonb_build_object(
    'from', g.pay_basis, 'to', p_to_basis, 'reason', v_reason,
    'returned_invoices', v_returned, 'shares', v_shares));
  UPDATE public.group_work_orders SET pay_basis = p_to_basis, updated_at = now() WHERE id = g.id;

  RETURN jsonb_build_object('group_id', g.id, 'from', g.pay_basis, 'to', p_to_basis,
    'returned_invoices', v_returned, 'shares', v_shares);
END; $$;
REVOKE ALL ON FUNCTION public.amend_group_work_order_pay_basis(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.amend_group_work_order_pay_basis(uuid, text, uuid, text) TO service_role;
