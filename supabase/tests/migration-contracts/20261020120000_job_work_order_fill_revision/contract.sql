-- Contract for 20261020120000_job_work_order_fill_revision.sql: a job work
-- order names, on its own row, the frozen scope revision it was filled from.
-- Set by the fill while a draft, only to a non-draft revision of its own job;
-- never cleared; changed only when a cleared draft is refilled (V, PR 1100
-- F1); not a hand edit, not part of the seal; null on insert and on every
-- other kind.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_job uuid := 'b7b7b7b7-0000-4000-8000-000000000001';
  v_other uuid := 'b7b7b7b7-0000-4000-8000-000000000002';
  v_rev uuid := 'c7c7c7c7-0000-4000-8000-000000000001';
  v_rev_old uuid := 'c7c7c7c7-0000-4000-8000-000000000002';
  v_rev_draft uuid := 'c7c7c7c7-0000-4000-8000-000000000003';
  v_rev_other uuid := 'c7c7c7c7-0000-4000-8000-000000000004';
  v_wo uuid;
  v_hash text;
  v_updated timestamptz;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WOR-1'),
    (v_other, '00000000-0000-0000-0000-000000000001', 'fencing', 'accepted', 'WOR-2');
  INSERT INTO public.scope_revisions (id, job_id, revision_number, status) VALUES
    (v_rev, v_job, 2, 'frozen'),
    (v_rev_old, v_job, 1, 'superseded'),
    (v_rev_draft, v_job, 3, 'draft'),
    (v_rev_other, v_other, 1, 'frozen');
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_job AND kind = 'job';
  IF v_wo IS NULL THEN RAISE EXCEPTION 'fill revision contract: the accepted job opened no draft'; END IF;

  -- 1. The opened draft names no revision.
  IF (SELECT quote_filled_scope_revision_id FROM public.work_orders WHERE id = v_wo) IS NOT NULL THEN
    RAISE EXCEPTION 'fill revision contract: a new draft must name no revision';
  END IF;

  -- 2. A draft revision, or another job's revision, is refused.
  BEGIN
    UPDATE public.work_orders SET quote_filled_scope_revision_id = v_rev_draft WHERE id = v_wo;
    RAISE EXCEPTION 'fill revision contract: a draft revision was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_orders SET quote_filled_scope_revision_id = v_rev_other WHERE id = v_wo;
    RAISE EXCEPTION 'fill revision contract: another job''s revision was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. The fill: lines, agreed labour, stamp and revision in one write. Not a
  --    hand edit.
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install","qty":20,"unit":"m","source":"quote"}]',
        agreed_labour_ex = 800, quote_filled_at = now(), quote_filled_scope_revision_id = v_rev
    WHERE id = v_wo;
  IF (SELECT quote_filled_scope_revision_id FROM public.work_orders WHERE id = v_wo) IS DISTINCT FROM v_rev THEN
    RAISE EXCEPTION 'fill revision contract: the fill did not store its revision';
  END IF;
  IF (SELECT hand_edited_at FROM public.work_orders WHERE id = v_wo) IS NOT NULL THEN
    RAISE EXCEPTION 'fill revision contract: storing the revision read as a hand edit';
  END IF;

  -- 4. On a filled draft, changing or clearing it is refused, even to another valid revision.
  BEGIN
    UPDATE public.work_orders SET quote_filled_scope_revision_id = v_rev_old WHERE id = v_wo;
    RAISE EXCEPTION 'fill revision contract: the revision was changed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.work_orders SET quote_filled_scope_revision_id = NULL WHERE id = v_wo;
    RAISE EXCEPTION 'fill revision contract: the revision was cleared';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. A later hand edit keeps the revision.
  UPDATE public.work_orders SET special_instructions = 'Gate on the left' WHERE id = v_wo;
  IF (SELECT quote_filled_scope_revision_id FROM public.work_orders WHERE id = v_wo) IS DISTINCT FROM v_rev THEN
    RAISE EXCEPTION 'fill revision contract: a hand edit lost the revision';
  END IF;

  -- 5b. Lines cleared but agreed labour kept is not a cleared draft: no change.
  UPDATE public.work_orders SET scope_items = '[]' WHERE id = v_wo;
  BEGIN
    UPDATE public.work_orders SET quote_filled_scope_revision_id = v_rev_old WHERE id = v_wo;
    RAISE EXCEPTION 'fill revision contract: the revision changed on a draft that still holds agreed labour';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5c. A cleared draft (no lines, no agreed labour) is refilled from another
  --     revision in one write; clearing the revision is still refused.
  UPDATE public.work_orders SET agreed_labour_ex = NULL WHERE id = v_wo;
  BEGIN
    UPDATE public.work_orders SET quote_filled_scope_revision_id = NULL WHERE id = v_wo;
    RAISE EXCEPTION 'fill revision contract: the revision was cleared on a cleared draft';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install","qty":18,"unit":"m","source":"quote"}]',
        agreed_labour_ex = 720, quote_filled_scope_revision_id = v_rev_old
    WHERE id = v_wo;
  IF (SELECT quote_filled_scope_revision_id FROM public.work_orders WHERE id = v_wo) IS DISTINCT FROM v_rev_old THEN
    RAISE EXCEPTION 'fill revision contract: a cleared draft could not be refilled from another revision';
  END IF;

  -- 6. The seal hash ignores it: the hash equals the hash built from the sealed content alone.
  INSERT INTO public.users (id, org_id, name, role) VALUES
    ('9913309f-35ae-4a71-8e1f-f704ecc526ea', '00000000-0000-0000-0000-000000000001', 'Shaun', 'ops_manager')
  ON CONFLICT (id) DO NOTHING;
  SELECT updated_at INTO v_updated FROM public.work_orders WHERE id = v_wo;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session', v_updated);
  SELECT encode(sha256(convert_to(jsonb_build_object(
      'work_order_id', wo.id, 'job_id', wo.job_id, 'wo_number', wo.wo_number,
      'scope_items', COALESCE(wo.scope_items, '[]'::jsonb),
      'special_instructions', wo.special_instructions, 'site_address', wo.site_address,
      'scheduled_date', wo.scheduled_date, 'agreed_labour_ex', wo.agreed_labour_ex
    )::text, 'UTF8')), 'hex') INTO v_hash
  FROM public.work_orders wo WHERE wo.id = v_wo;
  IF (SELECT status FROM public.work_orders WHERE id = v_wo) IS DISTINCT FROM 'approved'
     OR (SELECT sealed_content_hash FROM public.work_orders WHERE id = v_wo) IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'fill revision contract: approval or its seal hash changed';
  END IF;

  -- 7. A draft filled without a revision cannot get one once approved.
  SELECT id INTO v_wo FROM public.work_orders WHERE job_id = v_other AND kind = 'job';
  UPDATE public.work_orders SET scope_items = '[{"description":"Install","qty":5,"unit":"m"}]', agreed_labour_ex = 200
    WHERE id = v_wo;
  SELECT updated_at INTO v_updated FROM public.work_orders WHERE id = v_wo;
  PERFORM public.approve_job_work_order(v_wo, '9913309f-35ae-4a71-8e1f-f704ecc526ea', 'session', v_updated);
  BEGIN
    UPDATE public.work_orders SET quote_filled_scope_revision_id = v_rev_other WHERE id = v_wo;
    RAISE EXCEPTION 'fill revision contract: an approved work order took a revision';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 8. Null on insert, whatever the writer sends; and only job work orders may carry one.
  BEGIN
    INSERT INTO public.work_orders (org_id, job_id, kind, status, quote_filled_scope_revision_id)
    VALUES ('00000000-0000-0000-0000-000000000001', v_other, 'crew', 'draft', v_rev_other);
    RAISE EXCEPTION 'fill revision contract: a crew work order took a revision';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 9. The guard is not callable by browser roles.
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.work_orders_fill_revision_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.work_orders_fill_revision_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'fill revision contract: the guard must not be callable by browser roles';
  END IF;
END $$;

ROLLBACK;
