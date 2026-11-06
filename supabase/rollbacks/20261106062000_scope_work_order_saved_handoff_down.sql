-- Restore the prior preparation policy. Retain all saved drafts and links.
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

