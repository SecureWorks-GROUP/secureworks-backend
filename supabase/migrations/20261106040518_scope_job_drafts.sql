-- Scope job drafts. Local records only, no backfill, accounting or sends.
-- A release is acceptance of the source, NOT work-order approval or crew pay.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.scope_job_draft_sets (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id),
  org_id uuid NOT NULL,
  scope_revision_id uuid NOT NULL REFERENCES public.scope_revisions(id),
  work_order_id uuid NOT NULL UNIQUE REFERENCES public.work_orders(id),
  labour_lines jsonb NOT NULL,
  labour_total_cents bigint,
  totals jsonb NOT NULL,
  amounts_confirmed boolean NOT NULL,
  released_at timestamptz,
  prepared_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.scope_job_draft_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.scope_job_draft_sets(job_id),
  org_id uuid NOT NULL,
  scope_revision_id uuid NOT NULL REFERENCES public.scope_revisions(id),
  payer_id text NOT NULL CHECK (length(payer_id) BETWEEN 1 AND 200),
  billing_contact jsonb,
  ex_cents bigint CHECK (ex_cents >= 0),
  gst_cents bigint CHECK (gst_cents >= 0),
  inc_cents bigint CHECK (inc_cents >= 0),
  UNIQUE (job_id, payer_id),
  CHECK (ex_cents IS NULL OR gst_cents IS NULL OR inc_cents IS NULL OR ex_cents + gst_cents = inc_cents)
);
ALTER TABLE public.scope_job_draft_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_job_draft_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scope_job_draft_sets, public.scope_job_draft_invoices FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.scope_job_draft_sets, public.scope_job_draft_invoices TO service_role;

-- Missing, null and non-numeric figures are unknown, never zero. Reject
-- negative, out-of-range or genuinely sub-cent figures rather than rounding
-- an unreconciled quote. Tolerate floating-point serialization noise only.
CREATE OR REPLACE FUNCTION public.scope_draft_cents(p_value jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE v numeric;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN RETURN NULL; END IF;
  v := p_value::text::numeric * 100;
  IF v < 0 OR v > 999999999999 OR abs(v - round(v)) > 0.000001 THEN
    RAISE EXCEPTION 'scope_drafts_money_invalid' USING ERRCODE = '23514';
  END IF;
  RETURN round(v)::bigint;
END $$;

-- This reader returns persisted ids/amounts. It never recalculates a quote.
CREATE OR REPLACE FUNCTION public.read_scope_job_drafts(
  p_job_id uuid, p_scope_revision_id uuid, p_org_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.scope_job_draft_sets%ROWTYPE; v_invoices jsonb;
BEGIN
  PERFORM 1 FROM public.jobs j WHERE j.id = p_job_id AND j.org_id = p_org_id FOR SHARE;
  IF NOT FOUND OR p_org_id IS NULL THEN
    RAISE EXCEPTION 'scope_drafts_job_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets d WHERE d.job_id = p_job_id AND d.org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_drafts_not_found' USING ERRCODE = 'P0002'; END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id OR NOT EXISTS (
    SELECT 1 FROM public.scope_revisions r WHERE r.id = p_scope_revision_id AND r.job_id = p_job_id
      AND (s.released_at IS NOT NULL AND r.status IN ('frozen', 'superseded') OR r.status = 'frozen' AND NOT EXISTS (
        SELECT 1 FROM public.scope_revisions n WHERE n.job_id = p_job_id AND n.revision_number > r.revision_number
      ))
  ) THEN RAISE EXCEPTION 'scope_drafts_revision_stale' USING ERRCODE = '23514'; END IF;
  SELECT jsonb_agg(jsonb_build_object('id', i.id, 'payer_id', i.payer_id, 'status', 'draft',
      'ex_gst', i.ex_cents / 100.0, 'gst', i.gst_cents / 100.0, 'inc_gst', i.inc_cents / 100.0)
      ORDER BY i.payer_id COLLATE "C") INTO v_invoices
    FROM public.scope_job_draft_invoices i WHERE i.job_id = p_job_id AND i.scope_revision_id = s.scope_revision_id;
  RETURN jsonb_build_object('job_id', s.job_id, 'scope_revision_id', s.scope_revision_id,
    'work_order', jsonb_build_object('id', s.work_order_id,
      'status', CASE WHEN s.released_at IS NULL THEN 'draft' ELSE 'released' END,
      'labour_total_ex_gst', s.labour_total_cents / 100.0),
    'invoices', coalesce(v_invoices, '[]'::jsonb), 'amounts_confirmed', s.amounts_confirmed,
    'xero_writes', false, 'sent', false, 'payment_links', false);
END $$;

CREATE OR REPLACE FUNCTION public.prepare_scope_job_drafts(
  p_job_id uuid, p_scope_revision_id uuid, p_org_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.jobs%ROWTYPE; r public.scope_revisions%ROWTYPE;
  s public.scope_job_draft_sets%ROWTYPE; w public.work_orders%ROWTYPE;
  pricing jsonb; parties jsonb; party jsonb; lines jsonb;
  ex bigint; gst bigint; inc bigint; labour bigint;
  tex bigint; tgst bigint; tinc bigint;
  sx bigint := 0; sg bigint := 0; si bigint := 0;
  all_known boolean := true; seen text[] := ARRAY[]::text[]; payer text; wo_id uuid;
BEGIN
  -- One lock for every preparation and the existing acceptance status writer.
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR p_org_id IS NULL OR j.org_id IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'scope_drafts_job_forbidden' USING ERRCODE = '42501';
  END IF;
  IF j.type NOT IN ('fencing', 'patio') THEN
    RAISE EXCEPTION 'scope_drafts_job_type_unsupported' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO r FROM public.scope_revisions WHERE id = p_scope_revision_id AND job_id = p_job_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_drafts_revision_not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'frozen' OR EXISTS (SELECT 1 FROM public.scope_revisions n WHERE n.job_id = j.id AND n.revision_number > r.revision_number) THEN
    RAISE EXCEPTION 'scope_drafts_revision_stale' USING ERRCODE = '23514';
  END IF;
  IF encode(sha256(convert_to(r.scope_canonical_text, 'UTF8')), 'hex') <> r.scope_hash
    OR encode(sha256(convert_to(r.pricing_canonical_text, 'UTF8')), 'hex') <> r.pricing_hash THEN
    RAISE EXCEPTION 'scope_drafts_source_corrupt' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = j.id;
  IF FOUND AND s.scope_revision_id = r.id THEN
    RETURN public.read_scope_job_drafts(j.id, r.id, p_org_id);
  END IF;
  IF s.released_at IS NOT NULL OR j.status NOT IN ('draft', 'quoted', 'partially_accepted') THEN
    RAISE EXCEPTION 'scope_drafts_prepare_before_acceptance' USING ERRCODE = '23514';
  END IF;
  IF s.job_id IS NOT NULL AND j.status = 'partially_accepted' THEN
    RAISE EXCEPTION 'scope_drafts_partially_accepted_revision_locked' USING ERRCODE = '23514';
  END IF;
  pricing := r.pricing_canonical_text::jsonb;
  tex := public.scope_draft_cents(pricing->'totalExGST');
  tgst := public.scope_draft_cents(pricing->'gst');
  tinc := public.scope_draft_cents(pricing->'totalIncGST');
  IF tex IS NOT NULL AND tgst IS NOT NULL AND tinc IS NOT NULL AND tex + tgst <> tinc THEN
    RAISE EXCEPTION 'scope_drafts_totals_mismatch' USING ERRCODE = '23514';
  END IF;
  labour := public.scope_draft_cents(pricing->'labourCostEstimate');
  lines := pricing#>'{internal,labour_lines}';
  IF lines IS NULL OR lines = 'null'::jsonb THEN lines := '[]'::jsonb; END IF;
  IF jsonb_typeof(lines) <> 'array' THEN RAISE EXCEPTION 'scope_drafts_labour_lines_invalid' USING ERRCODE = '23514'; END IF;
  parties := pricing->'parties';
  IF parties IS NULL OR parties = 'null'::jsonb OR parties = '[]'::jsonb THEN
    parties := jsonb_build_array(jsonb_build_object('id', '__client__', 'ex_gst', pricing->'totalExGST',
      'gst', pricing->'gst', 'inc_gst', pricing->'totalIncGST'));
  END IF;
  IF jsonb_typeof(parties) <> 'array' OR jsonb_array_length(parties) = 0 THEN
    RAISE EXCEPTION 'scope_drafts_payers_invalid' USING ERRCODE = '23514';
  END IF;
  -- Validate everything before writing. Unknown totals are retained, but are
  -- explicitly unconfirmed and can never be reported as reconciled money.
  FOR party IN SELECT value FROM jsonb_array_elements(parties) LOOP
    payer := party->>'id';
    IF jsonb_typeof(party->'id') IS DISTINCT FROM 'string' OR payer = '' OR length(payer) > 200 OR payer = ANY(seen) THEN
      RAISE EXCEPTION 'scope_drafts_payers_invalid' USING ERRCODE = '23514';
    END IF;
    seen := array_append(seen, payer);
    ex := public.scope_draft_cents(party->'ex_gst'); gst := public.scope_draft_cents(party->'gst'); inc := public.scope_draft_cents(party->'inc_gst');
    IF ex IS NOT NULL AND gst IS NOT NULL AND inc IS NOT NULL AND ex + gst <> inc THEN
      RAISE EXCEPTION 'scope_drafts_payer_totals_mismatch' USING ERRCODE = '23514';
    END IF;
    all_known := all_known AND ex IS NOT NULL AND gst IS NOT NULL AND inc IS NOT NULL;
    sx := sx + ex; sg := sg + gst; si := si + inc;
  END LOOP;
  IF (sx IS NOT NULL AND tex IS NOT NULL AND sx <> tex)
    OR (sg IS NOT NULL AND tgst IS NOT NULL AND sg <> tgst)
    OR (si IS NOT NULL AND tinc IS NOT NULL AND si <> tinc) THEN
    RAISE EXCEPTION 'scope_drafts_payer_sum_mismatch' USING ERRCODE = '23514';
  END IF;
  all_known := all_known AND tex IS NOT NULL AND tgst IS NOT NULL AND tinc IS NOT NULL;
  wo_id := public.ensure_job_work_order_draft(j.id, 'manual');
  SELECT * INTO w FROM public.work_orders WHERE id = wo_id FOR UPDATE;
  IF w.status IS DISTINCT FROM 'draft' OR w.org_id IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'scope_drafts_work_order_sealed' USING ERRCODE = '23514';
  END IF;
  -- Preserve any office-authored content. Only this producer can refill its
  -- own unaccepted work order as a new frozen scope replaces the old one.
  IF s.job_id IS NULL AND (w.agreed_labour_ex IS NOT NULL OR coalesce(w.scope_items, '[]'::jsonb) <> '[]'::jsonb
    OR w.quote_filled_scope_revision_id IS NOT NULL OR w.hand_edited_at IS NOT NULL) THEN
    RAISE EXCEPTION 'scope_drafts_work_order_has_content' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('secureworks.scope_draft_prepare', j.id::text, true);
  -- The existing fill-revision guard permits a new source only on a cleared
  -- draft. Both writes are inside this transaction; nobody observes a clear.
  IF w.quote_filled_scope_revision_id IS NOT NULL AND w.quote_filled_scope_revision_id <> r.id THEN
    UPDATE public.work_orders SET scope_items = '[]'::jsonb, agreed_labour_ex = NULL WHERE id = wo_id;
  END IF;
  UPDATE public.work_orders SET scope_items = lines, agreed_labour_ex = labour / 100.0,
    scope_revision_id = r.id, quote_filled_scope_revision_id = r.id, updated_at = now() WHERE id = wo_id;
  INSERT INTO public.scope_job_draft_sets(job_id, org_id, scope_revision_id, work_order_id,
    labour_lines, labour_total_cents, totals, amounts_confirmed)
  VALUES (j.id, p_org_id, r.id, wo_id, lines, labour,
    jsonb_build_object('ex_cents', tex, 'gst_cents', tgst, 'inc_cents', tinc), all_known)
  ON CONFLICT (job_id) DO UPDATE SET scope_revision_id = excluded.scope_revision_id,
    labour_lines = excluded.labour_lines, labour_total_cents = excluded.labour_total_cents,
    totals = excluded.totals, amounts_confirmed = excluded.amounts_confirmed, prepared_at = now();
  FOR party IN SELECT value FROM jsonb_array_elements(parties) LOOP
    INSERT INTO public.scope_job_draft_invoices(job_id, org_id, scope_revision_id, payer_id, billing_contact, ex_cents, gst_cents, inc_cents)
    VALUES (j.id, p_org_id, r.id, party->>'id', party->'billing_contact', public.scope_draft_cents(party->'ex_gst'),
      public.scope_draft_cents(party->'gst'), public.scope_draft_cents(party->'inc_gst'))
    ON CONFLICT (job_id, payer_id) DO UPDATE SET scope_revision_id = excluded.scope_revision_id,
      billing_contact = excluded.billing_contact, ex_cents = excluded.ex_cents, gst_cents = excluded.gst_cents, inc_cents = excluded.inc_cents;
  END LOOP;
  PERFORM set_config('secureworks.scope_draft_prepare', '', true);
  RETURN public.read_scope_job_drafts(j.id, r.id, p_org_id);
END $$;

-- Source-bound content cannot drift through a generic WO editor, fill or
-- approval. After release, the existing named approver remains authoritative.
CREATE OR REPLACE FUNCTION public.guard_scope_draft_work_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.scope_job_draft_sets%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE work_order_id = OLD.id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'scope_drafts_work_order_retained' USING ERRCODE = '23514'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND s.released_at IS NULL THEN
    RAISE EXCEPTION 'scope_drafts_acceptance_required' USING ERRCODE = '23514';
  END IF;
  IF (NEW.scope_items IS DISTINCT FROM OLD.scope_items OR NEW.agreed_labour_ex IS DISTINCT FROM OLD.agreed_labour_ex
    OR NEW.scope_revision_id IS DISTINCT FROM OLD.scope_revision_id
    OR NEW.quote_filled_scope_revision_id IS DISTINCT FROM OLD.quote_filled_scope_revision_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.org_id IS DISTINCT FROM OLD.org_id)
    AND (s.released_at IS NOT NULL OR current_setting('secureworks.scope_draft_prepare', true) IS DISTINCT FROM OLD.job_id::text) THEN
    RAISE EXCEPTION 'scope_drafts_source_bound' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_scope_draft_work_order ON public.work_orders;
CREATE TRIGGER trg_scope_draft_work_order BEFORE UPDATE OR DELETE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_scope_draft_work_order();

-- Called only by the existing server acceptance paths after their full-job
-- decision. They resolve the accepted quote through acceptedRevisionForOrders;
-- a bound release may never substitute a newer frozen quote.
CREATE OR REPLACE FUNCTION public.release_scope_job_drafts(p_job_id uuid, p_scope_revision_id uuid, p_legacy boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.scope_job_draft_sets%ROWTYPE; j public.jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'scope_drafts_acceptance_required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = j.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('released', false, 'reason', 'no_drafts'); END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id THEN
    RAISE EXCEPTION 'scope_drafts_accepted_revision_mismatch' USING ERRCODE = '23514';
  END IF;
  IF s.released_at IS NOT NULL THEN RETURN jsonb_build_object('released', true, 'replayed', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.scope_revisions r JOIN public.work_orders w ON w.id = s.work_order_id
    WHERE r.id = s.scope_revision_id AND r.job_id = j.id AND r.status IN ('frozen', 'superseded')
      AND w.scope_revision_id = r.id AND w.scope_items = s.labour_lines
      AND w.agreed_labour_ex IS NOT DISTINCT FROM s.labour_total_cents / 100.0
      AND (NOT p_legacy OR r.status = 'frozen' AND NOT EXISTS (
        SELECT 1 FROM public.scope_revisions n WHERE n.job_id = j.id AND n.revision_number > r.revision_number))) THEN
    RAISE EXCEPTION 'scope_drafts_source_changed' USING ERRCODE = '23514';
  END IF;
  UPDATE public.scope_job_draft_sets SET released_at = now() WHERE job_id = j.id AND released_at IS NULL;
  INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
    (j.id, 'scope_job_draft_work_order_released', jsonb_build_object('work_order_id', s.work_order_id, 'scope_revision_id', s.scope_revision_id));
  RETURN jsonb_build_object('released', true, 'replayed', false);
END $$;

REVOKE ALL ON FUNCTION public.scope_draft_cents(jsonb), public.read_scope_job_drafts(uuid, uuid, uuid),
  public.prepare_scope_job_drafts(uuid, uuid, uuid), public.guard_scope_draft_work_order(), public.release_scope_job_drafts(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scope_draft_cents(jsonb), public.read_scope_job_drafts(uuid, uuid, uuid),
  public.prepare_scope_job_drafts(uuid, uuid, uuid), public.release_scope_job_drafts(uuid, uuid, boolean) TO service_role;
