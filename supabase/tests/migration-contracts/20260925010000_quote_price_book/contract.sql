BEGIN;
DO $$
DECLARE
  t text;
  r record;
  c record;
  n integer;
  prop uuid;
  prop2 uuid;
  ranked_prop uuid;
  inv_row uuid;
  blessed_row uuid;
  ranked_invoice_old uuid;
  err text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'price_book_items', 'price_book_costs', 'price_book_stock_lengths',
    'price_book_cut_rules', 'price_book_markup_rules', 'price_book_allowances',
    'price_book_approvers', 'price_book_proposals', 'price_book_proposal_decisions',
    'quote_line_markup_overrides']
  LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION '% must have RLS', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION '% must not be readable or writable by browser roles', t;
    END IF;
    IF NOT has_table_privilege('service_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION '% must be readable by the service role', t;
    END IF;
    IF t IN ('price_book_costs', 'price_book_proposals')
       AND NOT has_table_privilege('service_role', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION '% must be appendable by the service role', t;
    END IF;
    IF t NOT IN ('price_book_costs', 'price_book_proposals')
       AND has_table_privilege('service_role', 'public.' || t, 'INSERT') THEN
      RAISE EXCEPTION '% must not be directly insertable by the service role', t;
    END IF;
    IF has_table_privilege('service_role', 'public.' || t, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION '% must not grant UPDATE or DELETE', t;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.price_book_current_costs(text[], text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.price_book_decide_proposal(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'price book functions must not be callable by browser roles';
  END IF;

  -- Family default markups: patio 1.35 provisional, stratco 1.4 provisional,
  -- fencing and misc not set. No sell price is stored.
  SELECT * INTO r FROM public.price_book_current_markup('patio');
  IF r.value <> 1.35 OR r.status <> 'provisional' THEN
    RAISE EXCEPTION 'patio default markup must be 1.35 provisional, got % %', r.value, r.status;
  END IF;
  SELECT * INTO r FROM public.price_book_current_markup('stratco');
  IF r.value <> 1.40 OR r.status <> 'provisional' THEN
    RAISE EXCEPTION 'stratco default markup must be 1.4 provisional';
  END IF;
  SELECT * INTO r FROM public.price_book_current_markup('fencing');
  IF r.value IS NOT NULL OR r.status <> 'unset' THEN
    RAISE EXCEPTION 'fencing default markup must be unset';
  END IF;
  BEGIN
    INSERT INTO public.price_book_markup_rules (family, value, as_at,
      evidence_kind, evidence_ref, provisional, blessed_by, blessed_at, recorded_by)
    VALUES ('fencing', NULL, '2026-09-24', 'owner_stated', 'x',
      false, 'owner', now(), 'contract');
    RAISE EXCEPTION 'a blessed markup with no value was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO public.price_book_items (item_key, family, category, description, unit, created_by)
  VALUES ('steel-rhs-100x50x2', 'patio', 'steel', '100x50x2 RHS', 'lm', 'contract'),
         ('flashing-custom', 'patio', 'flashing', 'Custom flashing', 'lm', 'contract');

  -- A cost is never zero, never unevidenced, never blessed anonymously.
  BEGIN
    INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
      evidence_kind, evidence_ref, recorded_by)
    VALUES ('steel-rhs-100x50x2', 'BD Metals', 0, '2026-03-09', 'invoice', 'INV', 'contract');
    RAISE EXCEPTION 'a zero cost was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
      evidence_kind, evidence_ref, recorded_by)
    VALUES ('steel-rhs-100x50x2', 'BD Metals', 25, '2026-03-09', 'invoice', ' ', 'contract');
    RAISE EXCEPTION 'a cost with no evidence was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
      evidence_kind, evidence_ref, provisional, recorded_by)
    VALUES ('steel-rhs-100x50x2', 'BD Metals', 25, '2026-03-09', 'invoice', 'INV', false, 'contract');
    RAISE EXCEPTION 'a blessed cost with nobody blessing it was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Current cost among provisional rows: strongest evidence first, so an
  -- older invoice beats a newer tool constant.
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('steel-rhs-100x50x2', 'unspecified', 30, '2026-06-13', 'tool_constant', 'patio STEEL_RATES', 'contract');
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('steel-rhs-100x50x2', 'BD Metals', 25.8741, '2026-03-09', 'invoice', 'Tax Invoice 00023259', 'contract')
  RETURNING id INTO inv_row;
  SELECT * INTO c FROM public.price_book_current_costs(ARRAY['steel-rhs-100x50x2']);
  IF c.cost_row_id <> inv_row OR c.status <> 'provisional' OR c.cost_ex_gst <> 25.8741 THEN
    RAISE EXCEPTION 'provisional current cost must be the invoice row, got % %', c.cost_ex_gst, c.evidence_kind;
  END IF;

  -- An item with no cost reads unpriced: a $0 can never quote silently.
  SELECT * INTO c FROM public.price_book_current_costs(ARRAY['flashing-custom']);
  IF c.status <> 'unpriced' OR c.cost_ex_gst IS NOT NULL THEN
    RAISE EXCEPTION 'an item with no cost must read unpriced';
  END IF;
  SELECT count(*) INTO n FROM public.price_book_current_costs(NULL, 'patio');
  IF n <> 2 THEN RAISE EXCEPTION 'family filter returned % rows', n; END IF;

  -- Append-only: nothing is overwritten or removed.
  BEGIN
    UPDATE public.price_book_costs SET cost_ex_gst = 1 WHERE id = inv_row;
    RAISE EXCEPTION 'append-only UPDATE was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_append_only%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.price_book_markup_rules;
    RAISE EXCEPTION 'append-only DELETE was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_append_only%' THEN RAISE; END IF;
  END;

  -- Stock lengths must be ascending, distinct and positive; cut rules closed.
  BEGIN
    INSERT INTO public.price_book_stock_lengths (item_key, supplier, lengths_mm, as_at,
      evidence_kind, evidence_ref, recorded_by)
    VALUES ('steel-rhs-100x50x2', 'BD Metals', ARRAY[8000, 5500], '2026-06-13', 'tool_constant', 'x', 'contract');
    RAISE EXCEPTION 'unsorted stock lengths were accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.price_book_stock_lengths (item_key, supplier, lengths_mm, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('steel-rhs-100x50x2', 'unspecified', ARRAY[6500, 8000], '2026-06-13', 'tool_constant', 'x', 'contract'),
         ('steel-rhs-100x50x2', 'BD Metals', ARRAY[5500, 6500, 8000], '2026-06-13', 'tool_constant', 'y', 'contract');
  INSERT INTO public.price_book_cut_rules (item_key, rule, as_at, evidence_kind, evidence_ref, recorded_by)
  VALUES ('steel-rhs-100x50x2', 'one_per_stick', '2026-06-13', 'tool_constant', 'nestCuts beam', 'contract');
  BEGIN
    INSERT INTO public.price_book_cut_rules (item_key, rule, as_at, evidence_kind, evidence_ref, recorded_by)
    VALUES ('steel-rhs-100x50x2', 'guess', '2026-06-13', 'tool_constant', 'x', 'contract');
    RAISE EXCEPTION 'an unknown cut rule was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT * INTO c FROM public.price_book_current_costs(ARRAY['steel-rhs-100x50x2']);
  IF c.stock_lengths_mm <> ARRAY[5500, 6500, 8000] OR c.stock_supplier <> 'BD Metals'
     OR c.cut_rule <> 'one_per_stick' OR c.kerf_mm <> 3 THEN
    RAISE EXCEPTION 'stock lengths must follow the cost supplier: % %', c.stock_lengths_mm, c.stock_supplier;
  END IF;

  -- Proposals: nobody is configured to approve, so nothing can be approved.
  prop := public.price_book_propose('cost',
    jsonb_build_object('item_key', 'steel-rhs-100x50x2', 'supplier', 'BD Metals'),
    jsonb_build_object('cost_ex_gst', 26.5734, 'as_at', '2026-09-20',
      'evidence_kind', 'invoice', 'evidence_ref', 'Tax Invoice 00099999'),
    'new BD invoice', 'Tax Invoice 00099999', 'scoper-a');
  SELECT * INTO r FROM public.price_book_proposals WHERE id = prop;
  IF r.old_row_id <> inv_row OR (r.old_value->>'cost_ex_gst')::numeric <> 25.8741 THEN
    RAISE EXCEPTION 'a proposal must capture the row it replaces';
  END IF;
  BEGIN
    PERFORM public.price_book_decide_proposal(prop, 'approved', 'owner');
    RAISE EXCEPTION 'approval with no configured approver was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_approver_not_authorised%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.price_book_decide_proposal(prop, 'withdrawn', 'someone-else');
    RAISE EXCEPTION 'withdrawal by a non-proposer was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_withdraw_not_proposer%' THEN RAISE; END IF;
  END;

  -- Configure an approver for patio only: a fencing approver cannot bless it.
  INSERT INTO public.price_book_approvers (scope_kind, scope_value, approver, active, recorded_by)
  VALUES ('family', 'fencing', 'fence-lead', true, 'contract'),
         ('family', 'patio', 'patio-lead', true, 'contract');

  INSERT INTO public.price_book_items (item_key, family, category, description, unit, created_by)
  VALUES ('evidence-ranked-cost', 'patio', 'steel', 'Evidence-ranked cost', 'lm', 'contract');
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('evidence-ranked-cost', 'Ranked supplier', 30, '2026-09-20', 'tool_constant', 'tool', 'contract');
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('evidence-ranked-cost', 'Ranked supplier', 25, '2026-03-09', 'invoice', 'INV A', 'contract')
  RETURNING id INTO ranked_invoice_old;
  ranked_prop := public.price_book_propose('cost',
    jsonb_build_object('item_key', 'evidence-ranked-cost', 'supplier', 'Ranked supplier'),
    jsonb_build_object('cost_ex_gst', 26, 'as_at', '2026-09-24',
      'evidence_kind', 'invoice', 'evidence_ref', 'INV C'),
    'new ranked invoice', 'INV C', 'scoper-a');
  SELECT * INTO r FROM public.price_book_proposals WHERE id = ranked_prop;
  IF r.old_row_id <> ranked_invoice_old THEN
    RAISE EXCEPTION 'proposal must use the evidence-ranked invoice instead of the newer tool constant';
  END IF;
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('evidence-ranked-cost', 'Ranked supplier', 27, '2026-08-01', 'invoice', 'INV B', 'contract');
  BEGIN
    PERFORM public.price_book_decide_proposal(ranked_prop, 'approved', 'patio-lead');
    RAISE EXCEPTION 'a proposal whose evidence-ranked row changed was applied';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_proposal_stale%' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.price_book_decide_proposal(prop, 'approved', 'fence-lead');
    RAISE EXCEPTION 'an approver outside the scope was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_approver_not_authorised%' THEN RAISE; END IF;
  END;
  SELECT * INTO r FROM public.price_book_decide_proposal(prop, 'approved', 'patio-lead');
  blessed_row := r.applied_row_id;
  SELECT * INTO c FROM public.price_book_current_costs(ARRAY['steel-rhs-100x50x2']);
  IF c.cost_row_id <> blessed_row OR c.status <> 'blessed' OR c.blessed_by <> 'patio-lead'
     OR c.cost_ex_gst <> 26.5734 THEN
    RAISE EXCEPTION 'an approved proposal must become the blessed current cost';
  END IF;
  SELECT count(*) INTO n FROM public.price_book_costs WHERE item_key = 'steel-rhs-100x50x2';
  IF n <> 3 THEN RAISE EXCEPTION 'approval must add a row, never replace one (% rows)', n; END IF;
  BEGIN
    PERFORM public.price_book_decide_proposal(prop, 'rejected', 'patio-lead');
    RAISE EXCEPTION 'a second decision was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_proposal_already_decided%' THEN RAISE; END IF;
  END;

  -- A newer provisional observation is flagged, never silently promoted.
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('steel-rhs-100x50x2', 'BD Metals', 28, '2026-09-23', 'invoice', 'Tax Invoice 00100000', 'contract');
  SELECT * INTO c FROM public.price_book_current_costs(ARRAY['steel-rhs-100x50x2']);
  IF c.cost_row_id <> blessed_row OR c.newer_provisional_row_id IS NULL THEN
    RAISE EXCEPTION 'blessed must stay current and flag the newer provisional row';
  END IF;

  -- Stale: a proposal made before another change cannot be applied.
  prop2 := public.price_book_propose('cost',
    jsonb_build_object('item_key', 'steel-rhs-100x50x2', 'supplier', 'BD Metals'),
    jsonb_build_object('cost_ex_gst', 27, 'as_at', '2026-09-24',
      'evidence_kind', 'invoice', 'evidence_ref', 'X'),
    'another', 'X', 'scoper-a');
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, provisional, blessed_by, blessed_at, recorded_by)
  VALUES ('steel-rhs-100x50x2', 'BD Metals', 27.5, '2026-09-24', 'invoice', 'Y', false,
    'patio-lead', now(), 'contract');
  BEGIN
    PERFORM public.price_book_decide_proposal(prop2, 'approved', 'patio-lead');
    RAISE EXCEPTION 'a stale proposal was applied';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'price_book_proposal_stale%' THEN RAISE; END IF;
  END;

  -- Same date, same evidence, two stock lengths: the longest length's price
  -- is the headline and says which length it was for.
  INSERT INTO public.price_book_items (item_key, family, category, description, unit, created_by)
  VALUES ('steel-shs-90x90x2', 'patio', 'steel', '90x90x2 SHS', 'lm', 'contract');
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, per_length_mm, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('steel-shs-90x90x2', 'BD Metals', 33.7243, 3100, '2026-03-09', 'invoice', 'INV A', 'contract'),
         ('steel-shs-90x90x2', 'BD Metals', 31.8182, 4000, '2026-03-09', 'invoice', 'INV A', 'contract');
  SELECT * INTO c FROM public.price_book_current_costs(ARRAY['steel-shs-90x90x2']);
  IF c.cost_ex_gst <> 31.8182 OR c.per_length_mm <> 4000 THEN
    RAISE EXCEPTION 'the longest stock length must be the headline price, got % %', c.cost_ex_gst, c.per_length_mm;
  END IF;

  -- Allowances: girth bands only on the girth basis.
  BEGIN
    INSERT INTO public.price_book_allowances (family, allowance_key, description, basis,
      cost_ex_gst, as_at, evidence_kind, evidence_ref, recorded_by)
    VALUES ('patio', 'flashing', 'Flashing band', 'per_lm_by_girth_band', 4.76,
      '2026-06-05', 'invoice', 'PSI-198625', 'contract');
    RAISE EXCEPTION 'a girth band with no girth was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.price_book_allowances (family, allowance_key, description, basis,
    girth_min_mm, girth_max_mm, cost_ex_gst, as_at, evidence_kind, evidence_ref, recorded_by)
  VALUES ('patio', 'flashing', 'Flashing up to 100 girth', 'per_lm_by_girth_band', 0, 100, 4.76,
    '2026-06-05', 'invoice', 'PSI-198625', 'contract');

  -- Current allowance: strongest evidence wins among provisional rows.
  INSERT INTO public.price_book_allowances (family, allowance_key, description, basis,
    cost_ex_gst, as_at, evidence_kind, evidence_ref, recorded_by)
  VALUES ('patio', 'flashing-unknown-girth', 'Flashing, girth unknown', 'per_lm', 10.50,
    '2026-06-13', 'tool_constant', 'patio tool', 'contract'),
         ('patio', 'flashing-unknown-girth', 'Flashing, girth unknown', 'per_lm', 9.90,
    '2026-05-01', 'invoice', 'INV B', 'contract');
  SELECT * INTO r FROM public.price_book_current_allowances('patio')
    WHERE allowance_key = 'flashing-unknown-girth';
  IF r.cost_ex_gst <> 9.90 OR r.status <> 'provisional' THEN
    RAISE EXCEPTION 'current allowance must prefer invoice evidence, got %', r.cost_ex_gst;
  END IF;
  SELECT count(*) INTO n FROM public.price_book_current_allowances('patio');
  IF n <> 2 THEN RAISE EXCEPTION 'one current row per allowance and band, got %', n; END IF;

  -- Line markup: default until a scoper overrides, never below cost.
  SELECT * INTO r FROM public.price_book_line_markup(
    '11111111-1111-4111-8111-111111111111', 'L1', 'patio');
  IF r.source <> 'default' OR r.markup_multiplier <> 1.35 OR r.default_status <> 'provisional' THEN
    RAISE EXCEPTION 'a line with no override must use the family default';
  END IF;
  INSERT INTO public.quote_line_markup_overrides (quote_revision_id, line_key, family,
    markup_multiplier, default_multiplier_at_set, reason, set_by)
  VALUES ('11111111-1111-4111-8111-111111111111', 'L1', 'patio', 1.5, 1.35,
    'hard access', 'scoper-a');
  SELECT * INTO r FROM public.price_book_line_markup(
    '11111111-1111-4111-8111-111111111111', 'L1', 'patio');
  IF r.source <> 'line_override' OR r.markup_multiplier <> 1.5 OR r.set_by <> 'scoper-a' THEN
    RAISE EXCEPTION 'a line override must win and say who set it';
  END IF;
  BEGIN
    INSERT INTO public.quote_line_markup_overrides (quote_revision_id, line_key, family,
      markup_multiplier, set_by)
    VALUES ('11111111-1111-4111-8111-111111111111', 'L1', 'patio', 0.9, 'scoper-a');
    RAISE EXCEPTION 'a below-cost line markup was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT * INTO r FROM public.price_book_line_markup(
    '22222222-2222-4222-8222-222222222222', 'L1', 'fencing');
  IF r.source <> 'unset' OR r.markup_multiplier IS NOT NULL THEN
    RAISE EXCEPTION 'fencing with no default and no override must read unset';
  END IF;

  BEGIN
    INSERT INTO public.price_book_markup_rules (family, value, as_at,
      evidence_kind, evidence_ref, recorded_by)
    VALUES ('misc', 0.25, '2026-09-24', 'owner_stated', 'contract', 'contract');
    RAISE EXCEPTION 'a fractional margin was accepted as a multiplier';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.price_book_markup_rules (family, value, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('misc', 1.25, '2026-09-25', 'owner_stated', 'contract', 'contract');
  SELECT * INTO r FROM public.price_book_line_markup(
    '33333333-3333-4333-8333-333333333333', 'L1', 'misc');
  IF r.markup_multiplier <> 1.25 OR r.source <> 'default' THEN
    RAISE EXCEPTION 'family multiplier must be used directly, got %', r.markup_multiplier;
  END IF;
END $$;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  proposal_id uuid;
  applied_id uuid;
BEGIN
  INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
    evidence_kind, evidence_ref, recorded_by)
  VALUES ('steel-rhs-100x50x2', 'Service-role provisional', 21, '2026-09-24',
    'invoice', 'INV SERVICE', 'service_role');
  BEGIN
    INSERT INTO public.price_book_costs (item_key, supplier, cost_ex_gst, as_at,
      evidence_kind, evidence_ref, provisional, blessed_by, blessed_at, recorded_by)
    VALUES ('steel-rhs-100x50x2', 'Service-role direct blessing', 22, '2026-09-24',
      'invoice', 'INV SERVICE BLESSED', false, 'patio-lead', now(), 'service_role');
    RAISE EXCEPTION 'direct service-role blessing was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  proposal_id := public.price_book_propose('cost',
    jsonb_build_object('item_key', 'steel-rhs-100x50x2', 'supplier', 'Guarded supplier'),
    jsonb_build_object('cost_ex_gst', 19, 'as_at', '2026-09-24',
      'evidence_kind', 'invoice', 'evidence_ref', 'INV GUARDED'),
    'guarded proposal', 'INV GUARDED', 'scoper-a');
  SELECT applied_row_id INTO applied_id
  FROM public.price_book_decide_proposal(proposal_id, 'approved', 'patio-lead');
  IF applied_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.price_book_costs WHERE id = applied_id AND NOT provisional
  ) THEN
    RAISE EXCEPTION 'guarded decision did not create its blessed row';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;
