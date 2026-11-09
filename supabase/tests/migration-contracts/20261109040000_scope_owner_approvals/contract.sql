-- Contract for 20261109040000_scope_owner_approvals.sql: a job work order on a
-- saved revision is issued only with two explicit decisions, the owner-approved
-- price on that revision and the owner-approved work order on its exact
-- content, whichever path seals it. A missing decision holds the issue and
-- keeps the customer's acceptance. Synthetic data only.
BEGIN;

-- A job built in the scope engine: a frozen revision and its prepared drafts
-- (shared lane). Returns the job, the revision and its job work order.
CREATE FUNCTION pg_temp.scope_job(p_org uuid, p_status text DEFAULT 'draft',
  OUT job uuid, OUT rev uuid, OUT wo uuid)
LANGUAGE plpgsql AS $$
DECLARE
  pricing jsonb := '{"totalExGST":30.03,"gst":3.00,"totalIncGST":33.03,"labourCostEstimate":12.00,
    "internal":{"labour_lines":[{"line_key":"fixture-labour","description":"Synthetic installation","total":12}]},
    "parties":[{"id":"__client__","ex_gst":30.03,"gst":3.00,"inc_gst":33.03}]}';
BEGIN
  job := gen_random_uuid(); rev := gen_random_uuid();
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
    VALUES (job, p_org, 'fencing', 'draft', 'ZZTEST-SE-OWA-' || left(job::text, 8));
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, job, 1, 'frozen', '{}', pricing::text,
      encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to(pricing::text, 'UTF8')), 'hex'));
  PERFORM public.prepare_scope_job_drafts(job, rev, p_org);
  SELECT w.id INTO wo FROM public.work_orders w WHERE w.job_id = job AND w.kind = 'job';
  IF p_status <> 'draft' THEN UPDATE public.jobs SET status = p_status WHERE id = job; END IF;
END $$;

-- A job filled from its quote outside the scope engine's draft set: the order
-- names its revision through the quote fill only (not the shared lane).
CREATE FUNCTION pg_temp.filled_job(p_org uuid, OUT job uuid, OUT rev uuid, OUT wo uuid)
LANGUAGE plpgsql AS $$
BEGIN
  job := gen_random_uuid(); rev := gen_random_uuid();
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
    VALUES (job, p_org, 'fencing', 'accepted', 'ZZTEST-SE-OWF-' || left(job::text, 8));
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, job, 1, 'frozen', '{}', '{}',
      encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{}', 'UTF8')), 'hex'));
  SELECT w.id INTO wo FROM public.work_orders w WHERE w.job_id = job AND w.kind = 'job';
  UPDATE public.work_orders
    SET scope_items = '[{"description":"Install","qty":20,"unit":"m","source":"quote"}]',
        agreed_labour_ex = 800, quote_filled_at = now(), quote_filled_scope_revision_id = rev
    WHERE id = wo;
END $$;

CREATE FUNCTION pg_temp.wo_stamp(p_wo uuid) RETURNS timestamptz
LANGUAGE sql AS $$ SELECT updated_at FROM public.work_orders WHERE id = p_wo $$;

CREATE TEMP TABLE owa_people (role text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO owa_people VALUES
  ('org', '0a0a0a0a-0000-4000-8000-0000000000aa'),
  ('owner', gen_random_uuid()), ('approver', gen_random_uuid()), ('staff', gen_random_uuid());
INSERT INTO public.users(id, org_id, role, name)
  SELECT p.id, (SELECT id FROM owa_people WHERE role = 'org'), 'admin', 'ZZTEST Scope Checker'
  FROM owa_people p WHERE p.role <> 'org';
UPDATE public.work_order_settings
  SET approver_user_ids = approver_user_ids || (SELECT id FROM owa_people WHERE role = 'approver')
  WHERE id = 1;

-- 1. Shipped shape: the owner list empty, the saved-revision switch off, the
-- decisions private and append only, every door the service role's only.
DO $$
BEGIN
  ASSERT (SELECT owner_user_ids = '{}'::uuid[] FROM public.work_order_settings WHERE id = 1),
    'the migration must leave the owner list empty';
  ASSERT EXISTS (SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'owner_approval_saved_revision_required_v1' AND enabled = false),
    'the saved-revision switch must ship off';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.scope_owner_approvals'::regclass),
    'decisions must have row security';
  ASSERT NOT has_table_privilege('authenticated', 'public.scope_owner_approvals', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.scope_owner_approvals', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.scope_owner_approvals', 'INSERT')
    AND NOT has_table_privilege('service_role', 'public.scope_owner_approvals', 'UPDATE')
    AND NOT has_table_privilege('service_role', 'public.scope_owner_approvals', 'DELETE'),
    'decisions are written only through the recording functions';
  ASSERT NOT has_function_privilege('authenticated', 'public.record_scope_price_approval(uuid,uuid,uuid,text,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.record_job_work_order_approval(uuid,uuid,text,timestamptz,uuid,uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.issue_owner_approved_job_work_order(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.read_job_owner_approval_state(uuid,uuid)', 'EXECUTE'),
    'no browser role may decide, issue or read decisions';
  ASSERT has_function_privilege('service_role', 'public.record_scope_price_approval(uuid,uuid,uuid,text,uuid)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.record_job_work_order_approval(uuid,uuid,text,timestamptz,uuid,uuid,boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.owner_approved_job_work_order_drafts(integer)', 'EXECUTE'),
    'ops-api (service role) records and reads decisions';
END $$;

-- 2. Authority comes from the named lists. Until the owner list is filled the
-- owner is never labelled owner; once filled, owner wins over a named list.
-- Ordinary staff with no listing decide nothing.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_owner uuid := (SELECT id FROM owa_people WHERE role = 'owner');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  v_staff uuid := (SELECT id FROM owa_people WHERE role = 'staff');
  f record; refused boolean;
BEGIN
  ASSERT public.owner_approval_authority(v_approver) = 'approver_list', 'a named approver decides as approver_list';
  ASSERT public.owner_approval_authority(v_staff) IS NULL, 'staff with no listing has no authority';
  ASSERT public.owner_approval_authority(v_owner) IS NULL, 'the owner is not an approver until listed';
  UPDATE public.work_order_settings SET approver_user_ids = approver_user_ids || v_owner WHERE id = 1;
  ASSERT public.owner_approval_authority(v_owner) = 'approver_list',
    'listed only as an approver, the owner is recorded as approver_list, never as a delegate';
  UPDATE public.work_order_settings SET owner_user_ids = ARRAY[v_owner] WHERE id = 1;
  ASSERT public.owner_approval_authority(v_owner) = 'owner', 'once in the owner list, the owner decides as owner';

  f := pg_temp.scope_job(org);
  refused := false;
  BEGIN PERFORM public.record_scope_price_approval(f.job, f.rev, v_staff, 'session', org);
  EXCEPTION WHEN insufficient_privilege THEN refused := SQLERRM = 'scope_owner_approval_approver_required'; END;
  ASSERT refused, 'ordinary staff cannot approve a price';
  refused := false;
  BEGIN PERFORM public.record_job_work_order_approval(f.wo, v_staff, 'session', pg_temp.wo_stamp(f.wo));
  EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  ASSERT refused, 'ordinary staff cannot approve a work order';
  refused := false;
  BEGIN PERFORM public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN refused := SQLERRM = 'scope_owner_approval_job_forbidden'; END;
  ASSERT refused, 'another organisation cannot approve this job';
  ASSERT NOT EXISTS (SELECT 1 FROM public.scope_owner_approvals WHERE job_id = f.job), 'a refused decision records nothing';

  ASSERT (public.record_scope_price_approval(f.job, f.rev, v_owner, 'session', org))#>>'{approval,authority}' = 'owner',
    'the owner''s price decision is labelled owner';
  UPDATE public.work_order_settings SET owner_user_ids = '{}' WHERE id = 1;
END $$;

-- 3. No approvals, price only, order only: acceptance is retained, nothing is
-- released or issued, and no path seals around the policy.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  none record; price_only record; order_only record; r jsonb; refused boolean;
BEGIN
  none := pg_temp.scope_job(org, 'accepted');
  r := public.release_scope_job_drafts(none.job, none.rev);
  ASSERT r->>'released' = 'false' AND r->>'held' = 'true' AND r->>'acceptance_recorded' = 'true'
    AND r->'missing' ? 'price_approval' AND r->'missing' ? 'work_order_approval', 'no approvals: held, both named';
  ASSERT (SELECT released_at IS NULL AND acceptance_recorded_at IS NOT NULL AND acceptance_scope_revision_id = none.rev
    FROM public.scope_job_draft_sets WHERE job_id = none.job), 'the acceptance is retained, the release waits';
  ASSERT r#>>'{issue,state}' = 'awaiting_owner_approval', 'the read names what the issue waits for';
  refused := false;
  BEGIN UPDATE public.work_orders SET status = 'approved', approved_by = v_approver, approved_via = 'session'
    WHERE id = none.wo;
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true;
            WHEN check_violation THEN refused := true; END;
  ASSERT refused AND (SELECT status = 'draft' FROM public.work_orders WHERE id = none.wo),
    'a direct write cannot seal a bound order with no decisions';

  price_only := pg_temp.scope_job(org, 'accepted');
  PERFORM public.release_scope_job_drafts(price_only.job, price_only.rev);
  r := public.record_scope_price_approval(price_only.job, price_only.rev, v_approver, 'session', org);
  ASSERT r->>'replayed' = 'false' AND r#>>'{issues,0,held}' = 'true'
    AND r#>'{issues,0,missing}' = '["work_order_approval"]'::jsonb, 'price only: held for the work order decision';
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = price_only.wo), 'price only never issues';

  order_only := pg_temp.scope_job(org, 'accepted');
  PERFORM public.release_scope_job_drafts(order_only.job, order_only.rev);
  r := public.record_job_work_order_approval(order_only.wo, v_approver, 'session', pg_temp.wo_stamp(order_only.wo));
  ASSERT r#>>'{issue,held}' = 'true' AND r#>'{issue,missing}' = '["price_approval"]'::jsonb,
    'order only: held for the price decision';
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = order_only.wo), 'order only never issues';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = order_only.job
    AND event_type = 'scope_job_draft_issue_held') = 1, 'one held audit for the retained acceptance';
END $$;

-- 4. Both decisions: the one that completes the pair releases and seals in one
-- transaction, naming the person who approved the work order; repeats replay.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  f record; g record; r jsonb; p jsonb; refused boolean;
BEGIN
  -- Acceptance first, then the decisions.
  f := pg_temp.scope_job(org, 'accepted');
  PERFORM public.release_scope_job_drafts(f.job, f.rev);
  p := public.record_scope_price_approval(f.job, f.rev, v_approver, 'terminal', org);
  r := public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo),
    f.rev, org, true);
  ASSERT r#>>'{issue,issued}' = 'true', 'the completing decision issues';
  ASSERT (SELECT status = 'approved' AND approved_by = v_approver AND approved_via = 'session'
      AND price_approval_id = (p#>>'{approval,id}')::uuid AND work_order_approval_id = (r#>>'{approval,id}')::uuid
      AND sealed_content_hash = (r#>>'{approval,work_order_content_hash}')
    FROM public.work_orders WHERE id = f.wo), 'sealed on both decisions, by the work order''s approver';
  ASSERT (SELECT released_at IS NOT NULL FROM public.scope_job_draft_sets WHERE job_id = f.job),
    'released in the same transaction as the seal';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = f.job
    AND event_type = 'scope_job_draft_work_order_released') = 1, 'one release audit';
  ASSERT (SELECT work_order_id FROM public.jobs WHERE id = f.job) = f.wo, 'the job points at its issued order';
  -- Repeat approval and release.
  ASSERT (public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org))->>'replayed' = 'true',
    'a repeated price decision replays';
  refused := false;
  BEGIN PERFORM public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo));
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused, 'an issued order cannot be approved again';
  r := public.release_scope_job_drafts(f.job, f.rev);
  ASSERT r->>'released' = 'true' AND r->>'replayed' = 'true' AND r#>>'{issue,state}' = 'released', 'a repeat release replays';
  ASSERT (SELECT count(*) FROM public.scope_owner_approvals WHERE job_id = f.job) = 2, 'one decision each';

  -- Decisions first, then the customer's acceptance releases (public accept
  -- and the office status move both reach this release).
  g := pg_temp.scope_job(org);
  PERFORM public.record_scope_price_approval(g.job, g.rev, v_approver, 'session', org);
  r := public.record_job_work_order_approval(g.wo, v_approver, 'session', pg_temp.wo_stamp(g.wo));
  ASSERT r#>'{issue,missing}' = '["customer_acceptance"]'::jsonb, 'approved but unaccepted waits for the customer';
  ASSERT (public.read_scope_job_drafts(g.job, g.rev, org))#>>'{issue,state}' = 'awaiting_customer_acceptance',
    'the read says the customer has not accepted';
  UPDATE public.jobs SET status = 'accepted' WHERE id = g.job;
  r := public.release_scope_job_drafts(g.job, g.rev);
  ASSERT r->>'released' = 'true' AND (SELECT status = 'approved' FROM public.work_orders WHERE id = g.wo),
    'acceptance releases an order both decisions already allow';
END $$;

-- 5. Mismatched revisions, stale reviews and edits after approval: a decision
-- never carries to another revision or to changed content.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  f record; other_rev uuid := gen_random_uuid(); r jsonb; refused boolean; v_old timestamptz;
BEGIN
  f := pg_temp.filled_job(org);
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (other_rev, f.job, 2, 'frozen', '{}', '{"v":2}',
      encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to('{"v":2}', 'UTF8')), 'hex'));
  -- A newer revision starts unapproved; the price on it does not approve the
  -- order's own revision.
  PERFORM public.record_scope_price_approval(f.job, other_rev, v_approver, 'session', org);
  ASSERT public.scope_price_owner_approval(f.job, f.rev) IS NULL
    AND public.scope_price_owner_approval(f.job, other_rev) IS NOT NULL, 'each revision has its own price decision';
  refused := false;
  BEGIN PERFORM public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo),
    other_rev, org, true);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_owner_approval_revision_mismatch'; END;
  ASSERT refused, 'a work order decision names its own revision';
  refused := false;
  BEGIN PERFORM public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo),
    NULL, org, true);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_owner_approval_revision_mismatch'; END;
  ASSERT refused, 'the ops-api door must name the revision';

  -- Stale review.
  v_old := pg_temp.wo_stamp(f.wo);
  UPDATE public.work_orders SET special_instructions = 'Side gate' WHERE id = f.wo;
  refused := false;
  BEGIN PERFORM public.record_job_work_order_approval(f.wo, v_approver, 'session', v_old);
  EXCEPTION WHEN SQLSTATE 'WO409' THEN refused := true; END;
  ASSERT refused, 'a decision on an earlier read is refused';

  -- Edit after approval: the decision binds the content it was made on.
  r := public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo));
  ASSERT r#>'{issue,missing}' = '["price_approval"]'::jsonb, 'the order''s own revision still needs its price';
  UPDATE public.work_orders SET special_instructions = 'Rear gate' WHERE id = f.wo;
  PERFORM public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org);
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = f.wo),
    'an order edited after its decision is not issued on that decision';
  ASSERT (public.read_job_owner_approval_state(f.job, org))#>'{work_order,missing}' = '["work_order_approval"]'::jsonb,
    'the read never confirms edited content from an older decision';
  ASSERT (public.read_job_owner_approval_state(f.job, org))#>>'{current_scope_revision,id}' = other_rev::text
    AND (public.read_job_owner_approval_state(f.job, org))#>>'{work_order,source_is_current}' = 'false',
    'the read says the order is not on the current revision';
  r := public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo));
  ASSERT r#>>'{issue,issued}' = 'true' AND (SELECT status = 'approved' FROM public.work_orders WHERE id = f.wo),
    'a fresh decision on the edited content issues';
END $$;

-- 6. The automatic issue carries out an issue both decisions allow; it never
-- creates a decision. The sweep reads only drafts already approved.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  f record; refused boolean; v_row jsonb; v_hash text;
BEGIN
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_auto_issue_v1';
  f := pg_temp.filled_job(org);
  refused := false;
  BEGIN PERFORM public.auto_issue_job_work_order(f.wo, pg_temp.wo_stamp(f.wo));
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused AND (SELECT status = 'draft' FROM public.work_orders WHERE id = f.wo),
    'no decisions: the automatic issue refuses before any write';
  ASSERT NOT EXISTS (SELECT 1 FROM public.owner_approved_job_work_order_drafts(100) d WHERE d.work_order_id = f.wo),
    'the sweep does not read a draft waiting for the owner';
  ASSERT NOT EXISTS (SELECT 1 FROM public.scope_owner_approvals WHERE job_id = f.job), 'the automatic issue decides nothing';
  -- Both decisions on record, the issue not yet carried out (as after a
  -- refused issue): the sweep finds it and the automatic issue seals it once.
  SELECT public.job_work_order_content_hash(w) INTO v_hash FROM public.work_orders w WHERE w.id = f.wo;
  INSERT INTO public.scope_owner_approvals(kind, job_id, org_id, scope_revision_id, scope_hash, pricing_hash,
      approver_user_id, authority, via)
    VALUES ('price', f.job, org, f.rev, 'fixture', 'fixture', v_approver, 'approver_list', 'session');
  INSERT INTO public.scope_owner_approvals(kind, job_id, org_id, scope_revision_id, work_order_id,
      work_order_content_hash, approver_user_id, authority, via)
    VALUES ('work_order', f.job, org, f.rev, f.wo, v_hash, v_approver, 'approver_list', 'session');
  ASSERT EXISTS (SELECT 1 FROM public.owner_approved_job_work_order_drafts(100) d WHERE d.work_order_id = f.wo),
    'the sweep reads a draft both decisions allow';
  v_row := public.auto_issue_job_work_order(f.wo, pg_temp.wo_stamp(f.wo));
  ASSERT v_row->>'status' = 'approved' AND v_row->>'approved_via' = 'auto' AND v_row->>'approved_by' IS NULL
    AND v_row->>'price_approval_id' IS NOT NULL AND v_row->>'work_order_approval_id' IS NOT NULL,
    'the automatic issue seals on the recorded decisions';
  refused := false;
  BEGIN PERFORM public.auto_issue_job_work_order(f.wo, pg_temp.wo_stamp(f.wo));
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused, 'an issued order is never issued again';
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_auto_issue_v1';
END $$;

-- 7. Legacy crew status writers: a crew work order on a scope-built job leaves
-- draft only after the job work order is issued on both decisions.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  f record; crew uuid; plain uuid := gen_random_uuid(); refused boolean;
BEGIN
  f := pg_temp.scope_job(org, 'accepted');
  refused := false;
  BEGIN INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, f.job, 'crew', 'sent');
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused, 'a crew order cannot be created sent before the owner approvals';
  INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, f.job, 'crew', 'draft') RETURNING id INTO crew;
  refused := false;
  BEGIN UPDATE public.work_orders SET status = 'sent' WHERE id = crew;
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused, 'a crew order cannot be sent before the owner approvals';
  PERFORM public.release_scope_job_drafts(f.job, f.rev);
  PERFORM public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org);
  PERFORM public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo));
  UPDATE public.work_orders SET status = 'sent' WHERE id = crew;
  ASSERT (SELECT status = 'sent' FROM public.work_orders WHERE id = crew), 'issued on both decisions, the crew order may go';
  -- A job with no saved revision keeps today's crew path.
  INSERT INTO public.jobs(id, org_id, type, status, job_number) VALUES (plain, org, 'miscellaneous', 'accepted', 'ZZTEST-SE-OWC-1');
  INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, plain, 'crew', 'sent');
END $$;

-- 8. An order with no saved revision keeps the named-approver rule while the
-- switch is off (its decision recorded), and is refused once it is on.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  j1 uuid := gen_random_uuid(); j2 uuid := gen_random_uuid(); w1 uuid; w2 uuid; v jsonb; refused boolean;
BEGIN
  INSERT INTO public.jobs(id, org_id, type, status, job_number) VALUES
    (j1, org, 'fencing', 'accepted', 'ZZTEST-SE-OWU-1'), (j2, org, 'fencing', 'accepted', 'ZZTEST-SE-OWU-2');
  SELECT id INTO w1 FROM public.work_orders WHERE job_id = j1 AND kind = 'job';
  SELECT id INTO w2 FROM public.work_orders WHERE job_id = j2 AND kind = 'job';
  UPDATE public.work_orders SET scope_items = '[{"description":"Install"}]', agreed_labour_ex = 500 WHERE id IN (w1, w2);
  v := public.approve_job_work_order(w1, v_approver, 'session', pg_temp.wo_stamp(w1));
  ASSERT v->>'status' = 'approved' AND v->>'work_order_approval_id' IS NOT NULL AND v->>'price_approval_id' IS NULL
    AND v#>>'{owner_approval,approval,authority}' = 'approver_list', 'unbound: the approver''s decision seals and is recorded';
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'owner_approval_saved_revision_required_v1';
  refused := false;
  BEGIN PERFORM public.approve_job_work_order(w2, v_approver, 'session', pg_temp.wo_stamp(w2));
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused AND (SELECT status = 'draft' FROM public.work_orders WHERE id = w2),
    'with the switch on an order with no saved revision cannot be approved';
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'owner_approval_saved_revision_required_v1';
END $$;

-- 9. Decisions are append only, and a price decision needs a frozen, intact
-- revision.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  f record; draft_rev uuid := gen_random_uuid(); bad_rev uuid := gen_random_uuid(); refused boolean;
BEGIN
  f := pg_temp.scope_job(org);
  PERFORM public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org);
  refused := false;
  BEGIN UPDATE public.scope_owner_approvals SET approver_user_id = gen_random_uuid() WHERE job_id = f.job;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused, 'a decision cannot be rewritten';
  refused := false;
  BEGIN DELETE FROM public.scope_owner_approvals WHERE job_id = f.job;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused, 'a decision cannot be deleted';
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status) VALUES (draft_rev, f.job, 2, 'draft');
  refused := false;
  BEGIN PERFORM public.record_scope_price_approval(f.job, draft_rev, v_approver, 'session', org);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_owner_approval_revision_not_frozen'; END;
  ASSERT refused, 'a price is approved only on a frozen revision';
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (bad_rev, f.job, 3, 'frozen', '{}', '{}', encode(sha256(convert_to('{}', 'UTF8')), 'hex'), repeat('0', 64));
  refused := false;
  BEGIN PERFORM public.record_scope_price_approval(f.job, bad_rev, v_approver, 'session', org);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_owner_approval_source_corrupt'; END;
  ASSERT refused, 'a price whose frozen text does not match its hash is never approved';
END $$;

ROLLBACK;
