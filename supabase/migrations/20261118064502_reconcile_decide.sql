-- P2-03.3: reconcile_decide records one signed-in staff member's decision on a
-- Reconcile item and applies it. Creates two functions only: no trigger,
-- schedule, switch, table change or historical write. Nothing calls it until
-- an ops-api action is built.
--
-- Director ruling (Follow-up 34 item 8): until match_requeue exists,
-- not_duplicate records the decision and closes the item. It requeues nothing
-- and claims no requeue; the decision's shown_hash keeps reconcile_item_raise
-- from reopening the same hold on the same evidence.
--
-- Staff: users.role admin, owner or ops_manager in the item's own organisation.
-- The actor is always 'person:<p_user_id>'; no caller-supplied name is accepted.
-- No Xero, legacy table or xero_invoices.job_id write.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.reconcile_decide(
  p_item_id uuid, p_shown_hash text, p_action text, p_parts jsonb, p_note text,
  p_accepted_suggestion boolean, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_item public.reconcile_items%ROWTYPE;
  v_card text;
  v_is_cost boolean;
  v_doc_kind text;
  v_doc_id text;
  v_cut int;
  v_before jsonb;
  v_lines jsonb := '[]';
  v_line record;
  v_part jsonb;
  v_job uuid;
  v_division text;
  v_line_parts jsonb;
  v_sum numeric;
  v_count int;
  v_state text;
  v_decision bigint;
  v_supersedes bigint;
  v_clues bigint[];
  v_jobs uuid[] := '{}';
  v_status text;
/* block */ BEGIN
  -- 1. Staff only, in the item's organisation (read after the item, below).
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id
       AND u.role IN ('admin', 'owner', 'ops_manager')) THEN
    RAISE EXCEPTION 'reconcile_not_staff' USING ERRCODE = '42501';
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('place', 'split', 'overhead', 'division_stock',
       'duplicate', 'not_duplicate', 'leave', 'resolve') THEN
    -- 'message' is P2-03.5's and 'undo' is reconcile_undo's (P2-03.4).
    RAISE EXCEPTION 'reconcile_action_unknown' USING DETAIL = coalesce(p_action, '(null)');
  END IF;

  -- 2. The item, locked; open; the evidence the person was shown.
  SELECT * INTO v_item FROM public.reconcile_items i WHERE i.id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconcile_item_unknown';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.org_id = v_item.org_id) THEN
    RAISE EXCEPTION 'reconcile_not_staff' USING ERRCODE = '42501',
      DETAIL = 'not staff of this item''s organisation';
  END IF;
  IF v_item.status <> 'open' THEN
    RAISE EXCEPTION 'reconcile_item_closed';
  END IF;
  IF v_item.evidence_hash IS DISTINCT FROM p_shown_hash THEN
    RAISE EXCEPTION 'reconcile_evidence_changed';
  END IF;

  SELECT k.card INTO v_card FROM public.reconcile_item_kinds k WHERE k.kind = v_item.kind;
  v_is_cost := v_item.subject_table = 'cost_document';
  IF p_action IN ('place', 'split', 'overhead', 'division_stock', 'duplicate') AND NOT v_is_cost
     OR p_action = 'resolve' AND (v_is_cost OR v_card = 'message')
     OR p_action = 'not_duplicate' AND v_card = 'message' THEN
    RAISE EXCEPTION 'reconcile_action_not_for_item'
      USING DETAIL = format('%s on %s %s', p_action, v_item.kind, v_item.subject_table);
  END IF;
  -- not_duplicate answers a duplicate hold only; on any other item it would close
  -- the item with its lines still held and stop the same hold being raised.
  IF p_action = 'not_duplicate' AND v_item.reason IS DISTINCT FROM 'possible_duplicate' THEN
    RAISE EXCEPTION 'reconcile_not_a_duplicate_hold' USING DETAIL = v_item.reason;
  END IF;
  IF p_action = 'resolve' AND nullif(btrim(coalesce(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reconcile_note_required';
  END IF;

  -- 3. Before: the document's lines and parts, and the item, as they are now.
  IF v_is_cost THEN
    v_cut := position(':' IN v_item.subject_id);
    IF v_cut < 2 THEN
      RAISE EXCEPTION 'reconcile_subject_unknown' USING DETAIL = v_item.subject_id;
    END IF;
    v_doc_kind := left(v_item.subject_id, v_cut - 1);
    v_doc_id := substr(v_item.subject_id, v_cut + 1);
    -- The same key the cost-line sync serialises a document on.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      v_item.org_id::text || ':' || v_doc_kind || ':' || v_doc_id, 0));
    -- job_cost_lines_document_idx (document_kind, document_id); org narrows it.
    PERFORM 1 FROM public.job_cost_lines l
    WHERE l.document_kind = v_doc_kind AND l.document_id = v_doc_id AND l.org_id = v_item.org_id
    FOR UPDATE;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'state', l.state, 'needs_reason', l.needs_reason,
      'not_counted_reason', l.not_counted_reason, 'decided_by_kind', l.decided_by_kind,
      'decision_id', l.decision_id, 'covered_by_line_id', l.covered_by_line_id,
      'source_hash', l.source_hash, 'amount_ex', l.amount_ex,
      'parts', (SELECT coalesce(jsonb_agg(jsonb_build_object('part_no', p.part_no,
         'target', p.target, 'job_id', p.job_id, 'division', p.division, 'lane', p.lane,
         'amount_ex', p.amount_ex) ORDER BY p.part_no), '[]')
        FROM public.job_cost_line_parts p WHERE p.line_id = l.id))
      ORDER BY l.line_no, l.line_key COLLATE "C"), '[]')
    INTO v_lines
    FROM public.job_cost_lines l
    WHERE l.document_kind = v_doc_kind AND l.document_id = v_doc_id AND l.org_id = v_item.org_id;
    -- Jobs the old parts named, for the page and profit marks.
    SELECT coalesce(array_agg(DISTINCT (p ->> 'job_id')::uuid), '{}') INTO v_jobs
    FROM jsonb_array_elements(v_lines) l, jsonb_array_elements(l -> 'parts') p
    WHERE p ->> 'job_id' IS NOT NULL;
  END IF;
  v_before := jsonb_build_object('lines', v_lines,
    'item', jsonb_build_object('status', v_item.status, 'suggestion', v_item.suggestion,
      'snooze_until', v_item.snooze_until));

  IF v_is_cost AND p_action IN ('place', 'split', 'overhead', 'division_stock')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l ->> 'state' IS NOT NULL) THEN
    RAISE EXCEPTION 'reconcile_no_counted_lines';
  END IF;

  -- 4a. Validate the parts before anything is written.
  IF p_action = 'place' THEN
    IF jsonb_typeof(p_parts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_parts) <> 1
       OR coalesce(p_parts -> 0 ->> 'job_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'reconcile_parts_invalid' USING DETAIL = 'place takes [{job_id}]';
    END IF;
    v_job := (p_parts -> 0 ->> 'job_id')::uuid;
    PERFORM public.reconcile_decide_live_job(v_job, v_item.org_id);
  ELSIF p_action = 'split' THEN
    IF jsonb_typeof(p_parts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_parts) = 0 THEN
      RAISE EXCEPTION 'reconcile_parts_invalid' USING DETAIL = 'split takes [{line_id,target,...}]';
    END IF;
    FOR v_part IN SELECT value FROM jsonb_array_elements(p_parts) LOOP
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l
           WHERE l ->> 'id' = v_part ->> 'line_id' AND l ->> 'state' IS NOT NULL) THEN
        RAISE EXCEPTION 'reconcile_parts_invalid' USING DETAIL = 'a part names a line that is not counted on this document';
      END IF;
      -- Cents only, never zero, and the same sign as its line: amounts are
      -- numeric(12,2), and a part of the other sign could make any total add up.
      IF jsonb_typeof(v_part -> 'amount_ex') IS DISTINCT FROM 'number'
         OR (v_part ->> 'amount_ex')::numeric <> round((v_part ->> 'amount_ex')::numeric, 2)
         OR (v_part ->> 'amount_ex')::numeric = 0
         OR sign((v_part ->> 'amount_ex')::numeric) <> (SELECT sign((l ->> 'amount_ex')::numeric)
              FROM jsonb_array_elements(v_lines) l WHERE l ->> 'id' = v_part ->> 'line_id') THEN
        RAISE EXCEPTION 'reconcile_parts_do_not_add_up'
          USING DETAIL = 'every part is a non-zero amount in cents, the same sign as its line';
      END IF;
      IF v_part ->> 'target' = 'job' THEN
        IF coalesce(v_part ->> 'job_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'reconcile_parts_invalid' USING DETAIL = 'a job part needs a job_id';
        END IF;
        PERFORM public.reconcile_decide_live_job((v_part ->> 'job_id')::uuid, v_item.org_id);
      ELSIF v_part ->> 'target' = 'division_stock' THEN
        IF v_part ->> 'division' IS NULL OR v_part ->> 'division' NOT IN ('patios', 'fencing', 'insurance') THEN
          RAISE EXCEPTION 'reconcile_division_unknown' USING DETAIL = coalesce(v_part ->> 'division', '(none)');
        END IF;
      ELSIF v_part ->> 'target' IS DISTINCT FROM 'overhead' THEN
        RAISE EXCEPTION 'reconcile_parts_invalid' USING DETAIL = 'target is job, overhead or division_stock';
      END IF;
    END LOOP;
    FOR v_line IN SELECT l FROM jsonb_array_elements(v_lines) l WHERE l ->> 'state' IS NOT NULL LOOP
      SELECT sum((p ->> 'amount_ex')::numeric), count(*) INTO v_sum, v_count
      FROM jsonb_array_elements(p_parts) p WHERE p ->> 'line_id' = v_line.l ->> 'id';
      IF v_count = 0 OR (v_line.l ->> 'amount_ex') IS NULL
         OR v_sum IS DISTINCT FROM (v_line.l ->> 'amount_ex')::numeric THEN
        RAISE EXCEPTION 'reconcile_parts_do_not_add_up'
          USING DETAIL = format('line %s: parts %s, line %s', v_line.l ->> 'id', v_sum, v_line.l ->> 'amount_ex');
      END IF;
    END LOOP;
  ELSIF p_action = 'division_stock' THEN
    v_division := CASE WHEN jsonb_typeof(p_parts) = 'array' AND jsonb_array_length(p_parts) = 1
      THEN p_parts -> 0 ->> 'division' END;
    IF v_division IS NULL OR v_division NOT IN ('patios', 'fencing', 'insurance') THEN
      RAISE EXCEPTION 'reconcile_division_unknown' USING DETAIL = coalesce(v_division, '(none)');
    END IF;
  ELSIF p_action = 'duplicate' THEN
    IF jsonb_typeof(p_parts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_parts) <> 1
       OR nullif(btrim(coalesce(p_parts -> 0 ->> 'other_document_id', '')), '') IS NULL THEN
      RAISE EXCEPTION 'reconcile_duplicate_needs_other';
    END IF;
  END IF;
  IF p_action IN ('place', 'overhead', 'division_stock') AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_lines) l
       WHERE l ->> 'state' IS NOT NULL AND l ->> 'amount_ex' IS NULL) THEN
    RAISE EXCEPTION 'reconcile_parts_do_not_add_up' USING DETAIL = 'a counted line has no amount';
  END IF;

  -- 6. The decision row first, for its id.
  SELECT d.id INTO v_supersedes FROM public.reconcile_decisions d
  WHERE d.subject_kind = v_item.subject_table AND d.subject_id = v_item.subject_id
    AND d.org_id = v_item.org_id
  ORDER BY d.decided_at DESC, d.id DESC LIMIT 1;
  IF jsonb_typeof(v_item.suggestion -> 'clue_ids') = 'array' AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_item.suggestion -> 'clue_ids') c
       WHERE jsonb_typeof(c) <> 'number' OR c::text !~ '^[0-9]{1,18}$') THEN
    SELECT array_agg(c::text::bigint) INTO v_clues
    FROM jsonb_array_elements(v_item.suggestion -> 'clue_ids') c;
  END IF;
  INSERT INTO public.reconcile_decisions(org_id, item_id, subject_kind, subject_id, action,
    accepted_suggestion, parts, clue_ids, before, shown_hash, note, "by", supersedes)
  VALUES (v_item.org_id, v_item.id, v_item.subject_table, v_item.subject_id, p_action,
    coalesce(p_accepted_suggestion, false), p_parts, v_clues, v_before, p_shown_hash,
    nullif(btrim(coalesce(p_note, '')), ''), 'person:' || p_user_id::text, v_supersedes)
  RETURNING id INTO v_decision;

  -- 4b/5. Apply to the lines, through the one cost-line writer (which refollows).
  IF v_is_cost AND p_action IN ('place', 'split', 'overhead', 'division_stock', 'duplicate') THEN
    FOR v_line IN SELECT l FROM jsonb_array_elements(v_lines) l
      WHERE l ->> 'state' IS NOT NULL ORDER BY l ->> 'id' LOOP
      IF p_action = 'place' THEN
        v_state := 'on_job';
        v_line_parts := jsonb_build_array(jsonb_build_object('target', 'job', 'job_id', v_job,
          'amount_ex', (v_line.l ->> 'amount_ex')::numeric));
      ELSIF p_action = 'overhead' THEN
        v_state := 'overhead';
        v_line_parts := jsonb_build_array(jsonb_build_object('target', 'overhead',
          'amount_ex', (v_line.l ->> 'amount_ex')::numeric));
      ELSIF p_action = 'division_stock' THEN
        v_state := 'division_stock';
        v_line_parts := jsonb_build_array(jsonb_build_object('target', 'division_stock',
          'division', v_division, 'amount_ex', (v_line.l ->> 'amount_ex')::numeric));
      ELSIF p_action = 'split' THEN
        SELECT jsonb_agg(jsonb_build_object('target', p ->> 'target',
            'job_id', CASE WHEN p ->> 'target' = 'job' THEN p ->> 'job_id' END,
            'division', CASE WHEN p ->> 'target' = 'division_stock' THEN p ->> 'division' END,
            'lane', p ->> 'lane', 'amount_ex', (p ->> 'amount_ex')::numeric) ORDER BY n),
          count(*), min(p ->> 'target')
        INTO v_line_parts, v_count, v_state
        FROM jsonb_array_elements(p_parts) WITH ORDINALITY a(p, n)
        WHERE p ->> 'line_id' = v_line.l ->> 'id';
        v_state := CASE WHEN v_count > 1 THEN 'split' WHEN v_state = 'job' THEN 'on_job' ELSE v_state END;
      ELSE -- duplicate: not counted; parts removed by the writer.
        UPDATE public.job_cost_lines SET state = NULL, not_counted_reason = 'duplicate_document'
        WHERE id = (v_line.l ->> 'id')::uuid;
        v_state := NULL;
        v_line_parts := '[]';
      END IF;
      PERFORM public.job_cost_lines_set_state((v_line.l ->> 'id')::uuid, v_state, v_line_parts,
        'person', v_decision, NULL);
      v_jobs := v_jobs || coalesce((SELECT array_agg((p ->> 'job_id')::uuid)
        FROM jsonb_array_elements(v_line_parts) p WHERE p ->> 'job_id' IS NOT NULL), '{}');
    END LOOP;
  END IF;

  -- 7. Close the item, except leave (snoozed, stays open).
  IF p_action = 'leave' THEN
    UPDATE public.reconcile_items SET snooze_until = now() + interval '24 hours' WHERE id = v_item.id;
    v_status := 'open';
  ELSE
    UPDATE public.reconcile_items SET status = 'decided', closed_at = now(), decision_id = v_decision
    WHERE id = v_item.id;
    v_status := 'decided';
  END IF;

  -- 8. Mark the old and new jobs for Job Profit and the job page, when present.
  SELECT coalesce(array_agg(DISTINCT j), '{}') INTO v_jobs FROM unnest(v_jobs) j WHERE j IS NOT NULL;
  IF cardinality(v_jobs) > 0 THEN
    IF to_regprocedure('public.job_profit_mark(uuid,text)') IS NOT NULL THEN
      PERFORM public.job_profit_mark(j, 'person') FROM unnest(v_jobs) j;
    END IF;
    IF to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL THEN
      PERFORM public.job_mark_changed(j, 'person') FROM unnest(v_jobs) j;
    END IF;
  END IF;

  -- 9. The answer.
  IF v_is_cost THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('line_id', l.id, 'state', l.state)
      ORDER BY l.line_no, l.line_key COLLATE "C"), '[]') INTO v_lines
    FROM public.job_cost_lines l
    WHERE l.document_kind = v_doc_kind AND l.document_id = v_doc_id AND l.org_id = v_item.org_id;
  ELSE
    v_lines := '[]';
  END IF;
  RETURN jsonb_build_object('decision_id', v_decision, 'item_status', v_status, 'lines', v_lines);
END $fn$;

-- A job a person may place cost on: exists, in the item's organisation, and not
-- cancelled, lost, draft or quoted. jobs_pkey.
CREATE OR REPLACE FUNCTION public.reconcile_decide_live_job(p_job_id uuid, p_org_id uuid)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
/* block */ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id AND j.org_id = p_org_id
       AND lower(coalesce(j.status, '')) NOT IN ('cancelled', 'canceled', 'lost', 'draft', 'quoted', '')) THEN
    RAISE EXCEPTION 'reconcile_job_not_live' USING DETAIL = coalesce(p_job_id::text, '(none)');
  END IF;
END $fn$;

COMMENT ON FUNCTION public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid) IS
  'P2-03.3: a signed-in staff member''s decision on one Reconcile item, recorded in reconcile_decisions and applied to the cost lines. not_duplicate records and closes; no requeue until match_requeue exists.';

REVOKE ALL ON FUNCTION public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid),
  public.reconcile_decide_live_job(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_decide(uuid,text,text,jsonb,text,boolean,uuid),
  public.reconcile_decide_live_job(uuid,uuid) TO service_role;
