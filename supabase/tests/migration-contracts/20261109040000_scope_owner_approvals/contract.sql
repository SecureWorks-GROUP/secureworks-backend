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
  ASSERT NOT has_function_privilege('authenticated', 'public.record_scope_price_approval(uuid,uuid,uuid,text,uuid,text[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.record_job_work_order_approval(uuid,uuid,text,timestamptz,uuid,uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.issue_owner_approved_job_work_order(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.read_job_owner_approval_state(uuid,uuid)', 'EXECUTE'),
    'no browser role may decide, issue or read decisions';
  ASSERT has_function_privilege('service_role', 'public.record_scope_price_approval(uuid,uuid,uuid,text,uuid,text[])', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.record_job_work_order_approval(uuid,uuid,text,timestamptz,uuid,uuid,boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.owner_approved_job_work_order_drafts(integer)', 'EXECUTE'),
    'ops-api (service role) records and reads decisions';
END $$;

-- Sections 2 to 11 and 13 judge the policy as it runs once the owner turns
-- the switch on. Section 14 proves the shipped state (off) changes nothing.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'owner_approval_saved_revision_required_v1';

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
      quote_document_sha256s, approver_user_id, authority, via)
    VALUES ('price', f.job, org, f.rev, 'fixture', 'fixture', '{}', v_approver, 'approver_list', 'session');
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
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'owner_approval_saved_revision_required_v1';
  v := public.approve_job_work_order(w1, v_approver, 'session', pg_temp.wo_stamp(w1));
  ASSERT v->>'status' = 'approved' AND v->>'approved_by' = v_approver::text AND NOT v ? 'owner_approval',
    'unbound, switch off: the approval seals as before, with the reply it gave before';
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'owner_approval_saved_revision_required_v1';
  refused := false;
  BEGIN PERFORM public.approve_job_work_order(w2, v_approver, 'session', pg_temp.wo_stamp(w2));
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused AND (SELECT status = 'draft' FROM public.work_orders WHERE id = w2),
    'with the switch on an order with no saved revision cannot be approved';
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

-- 10. Cancelling a crew order is no way round the gate: draft to cancelled to
-- sent or accepted, a cancelled insert then sent, and a direct draft to sent
-- are all refused until the job work order is issued on both decisions.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  f record; crew uuid; crew2 uuid; target text; refused boolean;
BEGIN
  f := pg_temp.scope_job(org, 'accepted');
  INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, f.job, 'crew', 'draft') RETURNING id INTO crew;
  UPDATE public.work_orders SET status = 'cancelled' WHERE id = crew;
  FOREACH target IN ARRAY ARRAY['sent', 'accepted', 'in_progress', 'complete'] LOOP
    refused := false;
    BEGIN UPDATE public.work_orders SET status = target WHERE id = crew;
    EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
    ASSERT refused, format('a cancelled crew order cannot become %s before the owner approvals', target);
  END LOOP;
  INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, f.job, 'crew', 'cancelled') RETURNING id INTO crew2;
  refused := false;
  BEGIN UPDATE public.work_orders SET status = 'sent' WHERE id = crew2;
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused, 'a crew order inserted cancelled cannot then be sent';
  UPDATE public.work_orders SET status = 'draft' WHERE id = crew2;
  refused := false;
  BEGIN UPDATE public.work_orders SET status = 'sent' WHERE id = crew2;
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused, 'a direct draft to sent is refused';
  ASSERT (SELECT bool_and(status IN ('draft', 'cancelled')) FROM public.work_orders WHERE id IN (crew, crew2)),
    'nothing was issued';
  -- Once issued on both decisions, the cancelled order may come back, and an
  -- issued one stays editable.
  PERFORM public.release_scope_job_drafts(f.job, f.rev);
  PERFORM public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org);
  PERFORM public.record_job_work_order_approval(f.wo, v_approver, 'session', pg_temp.wo_stamp(f.wo));
  UPDATE public.work_orders SET status = 'accepted' WHERE id = crew;
  UPDATE public.work_orders SET status = 'complete' WHERE id = crew;
  ASSERT (SELECT status = 'complete' FROM public.work_orders WHERE id = crew), 'issued on both decisions, the crew order moves';
END $$;

-- 11. Company: a named approver in company A never records a decision on a
-- company B job, through either approval door, with the company passed or not.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  other_org uuid := '0b0b0b0b-0000-4000-8000-0000000000bb';
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  b record; own record; refused boolean; r jsonb;
BEGIN
  b := pg_temp.scope_job(other_org, 'accepted');
  -- The old four-argument door: no company passed, the approver's own decides.
  refused := false;
  BEGIN PERFORM public.approve_job_work_order(b.wo, v_approver, 'session', pg_temp.wo_stamp(b.wo));
  EXCEPTION WHEN insufficient_privilege THEN refused := SQLERRM = 'scope_owner_approval_job_forbidden'; END;
  ASSERT refused, 'the four-argument door refuses another company''s order';
  -- The five-argument door the ops-api doors call: the caller's company and
  -- the approver's own must both be the job's.
  FOREACH r IN ARRAY ARRAY[to_jsonb(org), to_jsonb(other_org), 'null'::jsonb] LOOP
    refused := false;
    BEGIN PERFORM public.approve_job_work_order(b.wo, v_approver, 'session', pg_temp.wo_stamp(b.wo), (r #>> '{}')::uuid);
    EXCEPTION WHEN insufficient_privilege THEN refused := SQLERRM = 'scope_owner_approval_job_forbidden'; END;
    ASSERT refused, format('the five-argument door refuses company %s for another company''s order', r);
  END LOOP;
  refused := false;
  BEGIN PERFORM public.record_job_work_order_approval(b.wo, v_approver, 'session', pg_temp.wo_stamp(b.wo));
  EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  ASSERT refused, 'the writer refuses with no company passed';
  FOREACH r IN ARRAY ARRAY[to_jsonb(org), to_jsonb(other_org)] LOOP
    refused := false;
    BEGIN PERFORM public.record_scope_price_approval(b.job, b.rev, v_approver, 'session', (r #>> '{}')::uuid);
    EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
    ASSERT refused, format('a price decision in company %s is refused for another company''s job', r);
  END LOOP;
  ASSERT NOT EXISTS (SELECT 1 FROM public.scope_owner_approvals WHERE job_id = b.job), 'no decision recorded';
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = b.wo), 'nothing issued';
  -- In its own company the five-argument door records the decision.
  own := pg_temp.scope_job(org, 'accepted');
  r := public.approve_job_work_order(own.wo, v_approver, 'session', pg_temp.wo_stamp(own.wo), org);
  ASSERT r#>>'{owner_approval,approval,kind}' = 'work_order', 'its own company''s order is decided';
END $$;

-- 12. A quote send naming no saved revision is recorded before the email:
-- claimed once (one job event), sent after the provider, replay safe, never
-- invented, never deleted or moved back, and private to the service role.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  f record; doc uuid := gen_random_uuid(); key text; r jsonb; refused boolean;
BEGIN
  f := pg_temp.scope_job(org);
  key := 'quote_document:' || doc;
  r := public.record_quote_send_price_unapproved(key, f.job, 'send', doc, 'claimed');
  ASSERT r->>'recorded' = 'true' AND r->>'state' = 'claimed', 'claimed before the email';
  r := public.record_quote_send_price_unapproved(key, f.job, 'send', doc, 'claimed');
  ASSERT r->>'recorded' = 'true' AND r->>'state' = 'claimed', 'a repeated claim replays';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = f.job
    AND event_type = 'quote_send_price_unapproved') = 1, 'one job event per send';
  r := public.record_quote_send_price_unapproved(key, f.job, 'send', doc, 'sent');
  ASSERT r->>'state' = 'sent' AND (SELECT sent_at IS NOT NULL FROM public.quote_send_price_unapproved_sends
    WHERE send_key = key), 'marked sent after the provider';
  r := public.record_quote_send_price_unapproved(key, f.job, 'send', doc, 'sent');
  ASSERT r->>'state' = 'sent', 'a replayed mark stays sent';
  r := public.record_quote_send_price_unapproved('quote_document:' || gen_random_uuid(), f.job, 'send', NULL, 'sent');
  ASSERT r->>'recorded' = 'false', 'a mark with no claim invents nothing';
  ASSERT (SELECT count(*) FROM public.quote_send_price_unapproved_sends WHERE job_id = f.job) = 1, 'one record';
  -- A document claimed by a bundle attempt that failed is retried through
  -- /send (and the reverse) on the same record, never refused.
  DECLARE doc2 uuid := gen_random_uuid(); key2 text := 'quote_document:' || doc2;
  BEGIN
    r := public.record_quote_send_price_unapproved(key2, f.job, 'send-runs', doc2, 'claimed', f.rev);
    r := public.record_quote_send_price_unapproved(key2, f.job, 'send', doc2, 'claimed');
    ASSERT r->>'recorded' = 'true' AND r->>'state' = 'claimed' AND r->>'path' = 'send-runs',
      'a /send retry of a document a bundle claimed keeps the one record';
    r := public.record_quote_send_price_unapproved(key2, f.job, 'send', doc2, 'sent');
    ASSERT r->>'state' = 'sent', 'the /send retry marks the record sent';
    r := public.record_quote_send_price_unapproved(key2, f.job, 'send-runs', doc2, 'claimed', f.rev);
    ASSERT r->>'recorded' = 'true', 'a later bundle claim of the same document replays';
    ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = f.job
      AND event_type = 'quote_send_price_unapproved') = 2, 'one job event per document';
  END;
  refused := false;
  BEGIN PERFORM public.record_quote_send_price_unapproved(key, gen_random_uuid(), 'send', doc, 'claimed');
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  ASSERT refused, 'a key held for another job refuses';
  refused := false;
  BEGIN DELETE FROM public.quote_send_price_unapproved_sends WHERE send_key = key;
  EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  ASSERT refused, 'a record is never deleted';
  refused := false;
  BEGIN UPDATE public.quote_send_price_unapproved_sends SET state = 'claimed', sent_at = NULL WHERE send_key = key;
  EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  ASSERT refused, 'a sent record never moves back';
  ASSERT NOT has_table_privilege('authenticated', 'public.quote_send_price_unapproved_sends', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.quote_send_price_unapproved_sends', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.quote_send_price_unapproved_sends', 'INSERT')
    AND NOT has_function_privilege('authenticated',
      'public.record_quote_send_price_unapproved(text, uuid, text, uuid, text, uuid)', 'EXECUTE')
    AND has_function_privilege('service_role',
      'public.record_quote_send_price_unapproved(text, uuid, text, uuid, text, uuid)', 'EXECUTE'),
    'records and their writer are the service role''s only';
  -- A send naming a saved revision with no price decision, while the switch
  -- is off: recorded with its revision and its own reason.
  doc := gen_random_uuid();
  r := public.record_quote_send_price_unapproved('quote_document:' || doc, f.job, 'send', doc, 'claimed', f.rev);
  ASSERT r->>'recorded' = 'true' AND (SELECT scope_revision_id = f.rev FROM public.quote_send_price_unapproved_sends
    WHERE send_key = 'quote_document:' || doc), 'the saved revision is recorded';
  ASSERT EXISTS (SELECT 1 FROM public.job_events WHERE job_id = f.job AND event_type = 'quote_send_price_unapproved'
    AND detail_json->>'reason' = 'no_price_decision' AND detail_json->>'scope_revision_id' = f.rev::text),
    'its event says no price decision on that revision';
  ASSERT EXISTS (SELECT 1 FROM public.job_events WHERE job_id = f.job AND event_type = 'quote_send_price_unapproved'
    AND detail_json->>'reason' = 'no_saved_revision'), 'a send naming no revision keeps its reason';
  r := public.record_quote_send_price_unapproved('quote_document:' || doc, f.job, 'send', doc, 'claimed', NULL);
  ASSERT r->>'recorded' = 'true' AND (SELECT scope_revision_id = f.rev FROM public.quote_send_price_unapproved_sends
    WHERE send_key = 'quote_document:' || doc), 'a retry replays and the record keeps the revision it was claimed with';
END $$;

-- 13. A late owner approval never moves the deposit: the quote_accepted event
-- and the first stage's due date keep the customer's retained acceptance time.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  job uuid := gen_random_uuid(); rev uuid := gen_random_uuid(); wo uuid;
  pricing jsonb; accepted_at timestamptz;
BEGIN
  pricing := jsonb_build_object('totalExGST', 10, 'gst', 1, 'totalIncGST', 11, 'labourCostEstimate', 4,
    'parties', '[{"id":"__client__","ex_gst":10,"gst":1,"inc_gst":11}]'::jsonb,
    'internal', jsonb_build_object('labour_lines', jsonb_build_array(jsonb_build_object('description', 'Synthetic labour', 'total', 4))),
    'local_invoice_stages', jsonb_build_object('version', 1, 'currency', 'AUD', 'terms_version', '2026-11-06',
      'total_inc_gst', 11, 'stages', jsonb_build_array(jsonb_build_object('id', 'first', 'label', 'First payment',
        'printed_terms', 'Synthetic deposit terms', 'amount_inc_gst', 11, 'basis', 'deposit',
        'trigger', jsonb_build_object('kind', 'quote_accepted'),
        'due_rule', jsonb_build_object('kind', 'days_after_trigger', 'days', 2),
        'payers', jsonb_build_array(jsonb_build_object('payer_id', '__client__', 'amount_inc_gst', 11))))));
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
    VALUES (job, org, 'fencing', 'draft', 'ZZTEST-SE-OWD-' || left(job::text, 8));
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, job, 1, 'frozen', '{}', pricing::text,
      encode(sha256(convert_to('{}', 'UTF8')), 'hex'), encode(sha256(convert_to(pricing::text, 'UTF8')), 'hex'));
  PERFORM public.prepare_scope_job_drafts(job, rev, org);
  SELECT w.id INTO wo FROM public.work_orders w WHERE w.job_id = job AND w.kind = 'job';
  UPDATE public.jobs SET status = 'accepted' WHERE id = job;
  PERFORM public.release_scope_job_drafts(job, rev);
  -- The customer accepted days before the owner approves.
  UPDATE public.scope_job_draft_sets SET acceptance_recorded_at = acceptance_recorded_at - interval '5 days'
    WHERE job_id = job RETURNING acceptance_recorded_at INTO accepted_at;
  ASSERT NOT EXISTS (SELECT 1 FROM public.scope_payment_signals WHERE job_id = job AND kind = 'quote_accepted'),
    'no deposit while the issue waits';
  PERFORM public.record_scope_price_approval(job, rev, v_approver, 'session', org);
  PERFORM public.record_job_work_order_approval(wo, v_approver, 'session', pg_temp.wo_stamp(wo));
  ASSERT (SELECT released_at > accepted_at FROM public.scope_job_draft_sets WHERE job_id = job),
    'released at the approval, later than the acceptance';
  ASSERT (SELECT happened_at = accepted_at FROM public.scope_payment_signals
    WHERE job_id = job AND kind = 'quote_accepted'), 'the quote_accepted event keeps the acceptance time';
  ASSERT (SELECT due_at = accepted_at + interval '2 days' FROM public.scope_payment_stage_drafts
    WHERE job_id = job AND stage_id = 'first'), 'the deposit is due from the acceptance, not the approval';
END $$;

-- The price decision covers the revision's quote PDFs as the server recorded
-- them when the owner decided: a PDF stored later is not covered, an approver
-- shown a different list is refused, and a replay keeps the original list.
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  f record; g record; p jsonb; refused boolean;
  pdf_a text := encode(sha256(convert_to('ZZTEST quote document A', 'UTF8')), 'hex');
  pdf_b text := encode(sha256(convert_to('ZZTEST quote document B', 'UTF8')), 'hex');
  render_c text := encode(sha256(convert_to('ZZTEST render C', 'UTF8')), 'hex');
BEGIN
  f := pg_temp.scope_job(org);
  INSERT INTO public.scope_artifacts(scope_revision_id, artifact_type, storage_path, bucket_id, sha256,
      size_bytes, content_type)
    VALUES (f.rev, 'quote_pdf', 'zztest/a.pdf', 'scope-artifacts', pdf_a, 23, 'application/pdf'),
           (f.rev, 'render_hero', 'zztest/c.png', 'scope-artifacts', render_c, 15, 'image/png');
  ASSERT public.scope_revision_quote_documents(f.rev) = ARRAY[pdf_a],
    'only quote PDFs count as customer documents';
  ASSERT (public.read_job_owner_approval_state(f.job, org))#>'{current_scope_revision,quote_document_sha256s}'
    = to_jsonb(ARRAY[pdf_a]), 'the read shows the approver the documents a decision covers';
  refused := false;
  BEGIN PERFORM public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org, ARRAY[pdf_a, pdf_b]);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_owner_approval_documents_changed'; END;
  ASSERT refused AND public.scope_price_owner_approval(f.job, f.rev) IS NULL,
    'a decision on a list the server does not hold is refused and records nothing';
  p := public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org, ARRAY[pdf_a]);
  ASSERT p#>'{approval,quote_document_sha256s}' = to_jsonb(ARRAY[pdf_a])
    AND public.scope_price_owner_approval(f.job, f.rev)->'quote_document_sha256s' = to_jsonb(ARRAY[pdf_a]),
    'the decision records the documents it covers and the send lookup returns them';
  INSERT INTO public.scope_artifacts(scope_revision_id, artifact_type, storage_path, bucket_id, sha256,
      size_bytes, content_type)
    VALUES (f.rev, 'per_contact_pdf', 'zztest/b.pdf', 'scope-artifacts', pdf_b, 23, 'application/pdf');
  ASSERT public.scope_price_owner_approval(f.job, f.rev)->'quote_document_sha256s' = to_jsonb(ARRAY[pdf_a]),
    'a PDF stored after the decision is not covered by it';
  refused := false;
  BEGIN PERFORM public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org, ARRAY[pdf_a, pdf_b]);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'scope_owner_approval_documents_changed'; END;
  ASSERT refused, 'a replay never widens the documents a decision covers';
  ASSERT (public.record_scope_price_approval(f.job, f.rev, v_approver, 'session', org, ARRAY[pdf_a]))->>'replayed' = 'true',
    'a replay naming the same documents replays';
  -- A revision with no quote PDF: the decision covers no document.
  g := pg_temp.scope_job(org);
  p := public.record_scope_price_approval(g.job, g.rev, v_approver, 'session', org, '{}'::text[]);
  ASSERT p#>'{approval,quote_document_sha256s}' = '[]'::jsonb, 'a decision with no documents covers none';
  refused := false;
  BEGIN INSERT INTO public.scope_owner_approvals(kind, job_id, scope_revision_id, scope_hash, pricing_hash,
      quote_document_sha256s, approver_user_id, authority, via)
    VALUES ('price', g.job, g.rev, 'x', 'y', ARRAY['not-a-hash'], v_approver, 'owner', 'session');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused, 'a document entry must be a sha256';
END $$;

-- 14. Shipped state, switch off: deploying changes nothing staff can do.
-- Release on acceptance, the manual approval, a direct approver write, the
-- automatic issue and its sweep, and crew order moves all go as before with no
-- decision at all; each one the switch would have refused or held is recorded
-- once (job_work_order_owner_unapproved plus one job event), privately.
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'owner_approval_saved_revision_required_v1';
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  acc record; man record; dir record; stranger record; auto record; crewjob record;
  r jsonb; v_row jsonb; crew uuid; crew2 uuid; refused boolean;
BEGIN
  -- Acceptance releases as before; the work order stays a draft for the
  -- approver or the automatic issue.
  acc := pg_temp.scope_job(org, 'accepted');
  r := public.release_scope_job_drafts(acc.job, acc.rev);
  ASSERT r = '{"released": true, "replayed": false}'::jsonb, 'off: acceptance releases as before, same reply';
  ASSERT (SELECT released_at IS NOT NULL FROM public.scope_job_draft_sets WHERE job_id = acc.job), 'off: released';
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = acc.wo), 'off: release never approves, as before';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = acc.job
    AND event_type = 'scope_job_draft_work_order_released') = 1, 'off: one release audit';
  ASSERT NOT EXISTS (SELECT 1 FROM public.job_events WHERE job_id = acc.job
    AND event_type = 'scope_job_draft_issue_held'), 'off: no held audit';
  ASSERT (SELECT count(*) FROM public.job_work_order_owner_unapproved WHERE job_id = acc.job
    AND event = 'released' AND missing @> ARRAY['price_approval', 'work_order_approval']) = 1,
    'off: the release the switch would have held is recorded';
  r := public.release_scope_job_drafts(acc.job, acc.rev);
  ASSERT r = '{"released": true, "replayed": true}'::jsonb AND (SELECT count(*) FROM public.job_work_order_owner_unapproved
    WHERE job_id = acc.job) = 1, 'off: a repeat release records nothing more, same reply';

  -- The approver's approval issues a bound order with no decision, exactly as
  -- before: the same reply, nothing decided.
  man := pg_temp.filled_job(org);
  v_row := public.approve_job_work_order(man.wo, v_approver, 'session', pg_temp.wo_stamp(man.wo), org);
  ASSERT v_row->>'status' = 'approved' AND NOT v_row ? 'owner_approval',
    'off: the manual approval issues as before, with the reply it gave before';
  ASSERT (SELECT status = 'approved' AND approved_by = v_approver AND work_order_approval_id IS NULL
      AND price_approval_id IS NULL FROM public.work_orders WHERE id = man.wo),
    'off: sealed by the approver';
  ASSERT NOT EXISTS (SELECT 1 FROM public.scope_owner_approvals WHERE job_id = man.job),
    'off: the approval records no owner decision';
  ASSERT (SELECT work_order_id FROM public.jobs WHERE id = man.job) = man.wo, 'off: the job points at it';
  ASSERT (SELECT count(*) FROM public.job_work_order_owner_unapproved WHERE work_order_id = man.wo
    AND event = 'issued' AND path = 'session' AND scope_revision_id = man.rev
    AND missing @> ARRAY['price_approval', 'work_order_approval']) = 1,
    'off: the issue the switch would have refused is recorded';

  dir := pg_temp.filled_job(org);
  v_row := public.approve_job_work_order(dir.wo, v_approver, 'session', pg_temp.wo_stamp(dir.wo));
  ASSERT v_row->>'status' = 'approved' AND NOT v_row ? 'owner_approval',
    'off: the four-argument approval issues as before, with the reply it gave before';

  -- A shared-lane draft approved before the customer accepted keeps the
  -- error it gives today.
  stranger := pg_temp.scope_job(org);
  refused := false;
  BEGIN PERFORM public.approve_job_work_order(stranger.wo, v_approver, 'session', pg_temp.wo_stamp(stranger.wo), org);
  EXCEPTION WHEN check_violation THEN
    refused := SQLERRM = 'scope_drafts_acceptance_required';
  END;
  ASSERT refused, 'off: approving before acceptance keeps the error it gives today';

  -- A direct write by a named approver seals as before.
  dir := pg_temp.filled_job(org);
  UPDATE public.work_orders SET status = 'approved', approved_by = v_approver, approved_via = 'session'
    WHERE id = dir.wo;
  ASSERT (SELECT status = 'approved' FROM public.work_orders WHERE id = dir.wo), 'off: an approver write seals as before';
  ASSERT EXISTS (SELECT 1 FROM public.job_work_order_owner_unapproved WHERE work_order_id = dir.wo
    AND event = 'issued' AND missing @> ARRAY['price_approval', 'work_order_approval']), 'off: recorded';
  stranger := pg_temp.filled_job(org);
  refused := false;
  BEGIN UPDATE public.work_orders SET status = 'approved', approved_by = gen_random_uuid(), approved_via = 'session'
    WHERE id = stranger.wo;
  EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  ASSERT refused, 'off: someone not on the lists still cannot approve';

  -- The automatic issue and its sweep work as before.
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_auto_issue_v1';
  auto := pg_temp.filled_job(org);
  ASSERT EXISTS (SELECT 1 FROM public.owner_approved_job_work_order_drafts(100) d WHERE d.work_order_id = auto.wo),
    'off: the sweep reads every filled draft, as before';
  v_row := public.auto_issue_job_work_order(auto.wo, pg_temp.wo_stamp(auto.wo));
  ASSERT v_row->>'status' = 'approved' AND v_row->>'approved_via' = 'auto' AND v_row->>'approved_by' IS NULL,
    'off: the automatic issue seals as before';
  ASSERT NOT EXISTS (SELECT 1 FROM public.scope_owner_approvals WHERE job_id = auto.job),
    'off: the automatic issue still decides nothing';
  ASSERT (SELECT count(*) FROM public.job_work_order_owner_unapproved WHERE work_order_id = auto.wo
    AND event = 'issued' AND path = 'auto' AND missing @> ARRAY['price_approval', 'work_order_approval']) = 1,
    'off: the automatic issue the switch would have refused is recorded';
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_auto_issue_v1';

  -- Crew orders on a saved-quote job move as before.
  crewjob := pg_temp.scope_job(org, 'accepted');
  INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, crewjob.job, 'crew', 'sent') RETURNING id INTO crew;
  INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, crewjob.job, 'crew', 'draft') RETURNING id INTO crew2;
  UPDATE public.work_orders SET status = 'sent' WHERE id = crew2;
  UPDATE public.work_orders SET status = 'accepted' WHERE id = crew2;
  ASSERT (SELECT count(*) FROM public.work_orders WHERE id IN (crew, crew2) AND status IN ('sent', 'accepted')) = 2,
    'off: crew orders on a saved-quote job move as before';
  ASSERT (SELECT count(*) FROM public.job_work_order_owner_unapproved WHERE job_id = crewjob.job
    AND event = 'crew_status' AND work_order_kind = 'crew') = 2,
    'off: each crew move out of draft the switch would have refused is recorded once';

  -- One job event per record; records are private and append only.
  ASSERT (SELECT count(*) FROM public.job_events WHERE event_type = 'work_order_owner_unapproved')
    = (SELECT count(*) FROM public.job_work_order_owner_unapproved), 'one job event per record';
  refused := false;
  BEGIN DELETE FROM public.job_work_order_owner_unapproved WHERE job_id = crewjob.job;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused, 'records cannot be deleted';
  refused := false;
  BEGIN UPDATE public.job_work_order_owner_unapproved SET missing = '{}' WHERE job_id = crewjob.job;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  ASSERT refused, 'records cannot be changed';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_work_order_owner_unapproved'::regclass)
    AND NOT has_table_privilege('authenticated', 'public.job_work_order_owner_unapproved', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.job_work_order_owner_unapproved', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.job_work_order_owner_unapproved', 'INSERT')
    AND has_table_privilege('service_role', 'public.job_work_order_owner_unapproved', 'SELECT')
    AND NOT has_function_privilege('authenticated', 'public.record_work_order_owner_unapproved(uuid,uuid,text,text,text,uuid,text[])', 'EXECUTE')
    AND NOT has_function_privilege('service_role', 'public.record_work_order_owner_unapproved(uuid,uuid,text,text,text,uuid,text[])', 'EXECUTE'),
    'records are written only by the seal, the crew gate and the release';

  -- The same steps with the switch on are refused (sections 3, 6 and 7);
  -- turning it on here refuses the next of each kind.
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'owner_approval_saved_revision_required_v1';
  refused := false;
  BEGIN INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, crewjob.job, 'crew', 'sent');
  EXCEPTION WHEN SQLSTATE 'WO428' THEN refused := true; END;
  ASSERT refused, 'on: the same crew move is refused';
  acc := pg_temp.scope_job(org, 'accepted');
  r := public.release_scope_job_drafts(acc.job, acc.rev);
  ASSERT r->>'held' = 'true', 'on: the same release is held';
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'owner_approval_saved_revision_required_v1';
END $$;

-- 15. Switch off, fault injection: a record that cannot be written, or an
-- owner gate that cannot be read, never stops or rolls back a release, an
-- approval, an approver write, the automatic issue, its sweep, a crew move or
-- the draft read. Each does exactly what it does today.
CREATE FUNCTION public.owa_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'injected_audit_failure'; END $$;
DO $$
DECLARE
  org uuid := (SELECT id FROM owa_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM owa_people WHERE role = 'approver');
  acc record; man record; dir record; auto record; crewjob record;
  r jsonb; v_row jsonb; crew uuid; n_before bigint; pass int;
BEGIN
  ASSERT NOT public.owner_approval_required(), 'section 15 runs with the switch off';
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_auto_issue_v1';
  FOR pass IN 1..2 LOOP
    IF pass = 1 THEN
      CREATE TRIGGER owa_inject BEFORE INSERT ON public.job_work_order_owner_unapproved
        FOR EACH ROW EXECUTE FUNCTION public.owa_injected_failure();
    ELSE
      DROP TRIGGER owa_inject ON public.job_work_order_owner_unapproved;
      EXECUTE $f$CREATE OR REPLACE FUNCTION public.job_work_order_owner_gate(w public.work_orders, p_hash text DEFAULT NULL)
        RETURNS jsonb LANGUAGE plpgsql STABLE AS $g$ BEGIN RAISE EXCEPTION 'injected_gate_failure'; END $g$ $f$;
    END IF;
    n_before := (SELECT count(*) FROM public.job_work_order_owner_unapproved);

    acc := pg_temp.scope_job(org, 'accepted');
    r := public.release_scope_job_drafts(acc.job, acc.rev);
    ASSERT r = '{"released": true, "replayed": false}'::jsonb
      AND (SELECT released_at IS NOT NULL FROM public.scope_job_draft_sets WHERE job_id = acc.job),
      format('fault %s: the release goes as today', pass);
    r := public.read_scope_job_drafts(acc.job, acc.rev, org);
    ASSERT r#>>'{work_order,status}' = 'released', format('fault %s: the draft read goes as today', pass);

    man := pg_temp.filled_job(org);
    v_row := public.approve_job_work_order(man.wo, v_approver, 'session', pg_temp.wo_stamp(man.wo), org);
    ASSERT v_row->>'status' = 'approved' AND NOT v_row ? 'owner_approval'
      AND (SELECT work_order_id FROM public.jobs WHERE id = man.job) = man.wo,
      format('fault %s: the manual approval issues as today', pass);

    dir := pg_temp.filled_job(org);
    UPDATE public.work_orders SET status = 'approved', approved_by = v_approver, approved_via = 'session'
      WHERE id = dir.wo;
    ASSERT (SELECT status = 'approved' AND sealed_content_hash IS NOT NULL FROM public.work_orders WHERE id = dir.wo),
      format('fault %s: an approver write seals as today', pass);

    auto := pg_temp.filled_job(org);
    ASSERT EXISTS (SELECT 1 FROM public.owner_approved_job_work_order_drafts(100) d WHERE d.work_order_id = auto.wo),
      format('fault %s: the sweep lists the draft as today', pass);
    v_row := public.auto_issue_job_work_order(auto.wo, pg_temp.wo_stamp(auto.wo));
    ASSERT v_row->>'status' = 'approved' AND v_row->>'approved_via' = 'auto',
      format('fault %s: the automatic issue seals as today', pass);

    crewjob := pg_temp.scope_job(org, 'accepted');
    INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, crewjob.job, 'crew', 'draft')
      RETURNING id INTO crew;
    UPDATE public.work_orders SET status = 'sent' WHERE id = crew;
    INSERT INTO public.work_orders(org_id, job_id, kind, status) VALUES (org, crewjob.job, 'crew', 'sent');
    ASSERT (SELECT count(*) FROM public.work_orders WHERE job_id = crewjob.job AND kind = 'crew' AND status = 'sent') = 2,
      format('fault %s: crew moves go as today', pass);

    IF pass = 1 THEN
      ASSERT (SELECT count(*) FROM public.job_work_order_owner_unapproved) = n_before,
        'fault 1: no record was written and nothing else was lost';
    END IF;
  END LOOP;
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_auto_issue_v1';
END $$;

ROLLBACK;
