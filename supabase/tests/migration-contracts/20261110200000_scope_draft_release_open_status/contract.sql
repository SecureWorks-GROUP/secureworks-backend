-- Contract for 20261110200000_scope_draft_release_open_status.sql (TK-S28).
-- One approved quote makes one work order: the scope tool's draft cannot
-- proceed before acceptance, acceptance releases that same order once in
-- whatever open status it left the job, approving twice makes nothing new,
-- and the order keeps the accepted labour and revision. Runs with the
-- shipped switch state (owner_approval_saved_revision_required_v1 off),
-- then once with it on. Synthetic data only.
BEGIN;

CREATE FUNCTION pg_temp.tk_freeze(p_job uuid, p_number int, p_lines jsonb, p_labour numeric)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  rev uuid := gen_random_uuid();
  pricing jsonb := jsonb_build_object('totalExGST', 3000, 'gst', 300, 'totalIncGST', 3300,
    'labourCostEstimate', p_labour, 'internal', jsonb_build_object('labour_lines', p_lines),
    'parties', jsonb_build_array(jsonb_build_object('id', '__client__',
      'ex_gst', 3000, 'gst', 300, 'inc_gst', 3300)));
BEGIN
  UPDATE public.scope_revisions SET status = 'superseded', superseded_by_scope_revision_id = rev,
      superseded_at = now()
    WHERE job_id = p_job AND status = 'frozen';
  INSERT INTO public.scope_revisions(id, job_id, revision_number, status, scope_canonical_text,
      pricing_canonical_text, scope_hash, pricing_hash)
    VALUES (rev, p_job, p_number, 'frozen', '{}', pricing::text,
      encode(sha256(convert_to('{}', 'UTF8')), 'hex'),
      encode(sha256(convert_to(pricing::text, 'UTF8')), 'hex'));
  RETURN rev;
END $$;

CREATE FUNCTION pg_temp.tk_job(p_org uuid, OUT job uuid, OUT rev uuid, OUT wo uuid)
LANGUAGE plpgsql AS $$
BEGIN
  job := gen_random_uuid();
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
    VALUES (job, p_org, 'fencing', 'draft', 'ZZTEST-SE-TKS28-' || left(job::text, 8));
  rev := pg_temp.tk_freeze(job, 1,
    '[{"line_key":"crew","description":"Synthetic crew","total":800}]', 800);
  PERFORM public.prepare_scope_job_drafts(job, rev, p_org);
  SELECT w.id INTO wo FROM public.work_orders w WHERE w.job_id = job AND w.kind = 'job';
  UPDATE public.jobs SET status = 'quoted' WHERE id = job;
END $$;

CREATE FUNCTION pg_temp.tk_stamp(p_wo uuid) RETURNS timestamptz
LANGUAGE sql AS $$ SELECT updated_at FROM public.work_orders WHERE id = p_wo $$;

CREATE FUNCTION pg_temp.tk_refused(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;

CREATE TEMP TABLE tk_people (role text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO tk_people VALUES
  ('org', '0a0a0a0a-0000-4000-8000-0000000028aa'), ('approver', gen_random_uuid());
INSERT INTO public.users(id, org_id, role, name)
  SELECT p.id, (SELECT id FROM tk_people WHERE role = 'org'), 'admin', 'ZZTEST Scope Checker'
  FROM tk_people p WHERE p.role = 'approver';
UPDATE public.work_order_settings
  SET approver_user_ids = approver_user_ids || (SELECT id FROM tk_people WHERE role = 'approver')
  WHERE id = 1;
UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN ('owner_approval_saved_revision_required_v1', 'job_work_order_auto_issue_v1');

-- 1. The whole ticket on one job, the office moving the card straight from
-- quoted to Deposit (no 'accepted' write).
DO $$
DECLARE
  org uuid := (SELECT id FROM tk_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM tk_people WHERE role = 'approver');
  f record; rev2 uuid; r jsonb; v_row jsonb; err text;
  lines2 jsonb := '[{"line_key":"crew","description":"Synthetic crew","total":800},
                    {"line_key":"gate","description":"Synthetic gate labour","total":290}]';
BEGIN
  f := pg_temp.tk_job(org);

  -- A new saved revision before acceptance refills the same draft.
  rev2 := pg_temp.tk_freeze(f.job, 2, lines2, 1090);
  r := public.prepare_scope_job_drafts(f.job, rev2, org);
  ASSERT r#>>'{work_order,id}' = f.wo::text, 'a new revision refills the same work order';
  ASSERT (SELECT count(*) FROM public.work_orders WHERE job_id = f.job AND kind = 'job') = 1,
    'one work order across revisions';
  ASSERT (SELECT agreed_labour_ex = 1090 AND scope_items = lines2 AND scope_revision_id = rev2
    FROM public.work_orders WHERE id = f.wo), 'the draft carries the saved labour, lines and revision';
  ASSERT (SELECT sum((l->>'total')::numeric) FROM public.work_orders w,
    jsonb_array_elements(w.scope_items) l WHERE w.id = f.wo) = 1090,
    'the crew lines add to the group labour amount';

  -- Before acceptance it cannot proceed.
  err := pg_temp.tk_refused(format(
    'SELECT public.approve_job_work_order(%L, %L, ''session'', %L, %L)',
    f.wo, v_approver, pg_temp.tk_stamp(f.wo), org));
  ASSERT err = 'scope_drafts_acceptance_required', 'approving before acceptance is refused: ' || coalesce(err, 'it went through');
  err := pg_temp.tk_refused(format('SELECT public.release_scope_job_drafts(%L, %L)', f.job, rev2));
  ASSERT err = 'scope_drafts_acceptance_required', 'a quoted job releases nothing';
  ASSERT (SELECT status = 'draft' AND approved_at IS NULL FROM public.work_orders WHERE id = f.wo),
    'the draft stays a draft';

  -- Acceptance by any open status releases the same order, once.
  UPDATE public.jobs SET status = 'deposit' WHERE id = f.job;
  err := pg_temp.tk_refused(format('SELECT public.release_scope_job_drafts(%L, %L)', f.job, rev2));
  ASSERT err IS NULL, 'quoted -> deposit releases the draft: ' || coalesce(err, '');
  ASSERT (SELECT released_at IS NOT NULL FROM public.scope_job_draft_sets WHERE job_id = f.job),
    'quoted -> deposit releases the draft: released_at stamped';
  r := public.release_scope_job_drafts(f.job, rev2);
  ASSERT r = '{"released": true, "replayed": true}'::jsonb, 'a repeated release replays';
  ASSERT (SELECT count(*) FROM public.job_events WHERE job_id = f.job
    AND event_type = 'scope_job_draft_work_order_released') = 1, 'one release audit';
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = f.wo), 'release never approves';

  -- A later saved revision cannot replace the released source.
  err := pg_temp.tk_refused(format('SELECT public.prepare_scope_job_drafts(%L, %L, %L)',
    f.job, pg_temp.tk_freeze(f.job, 3, '[{"line_key":"crew","description":"x","total":5}]', 5), org));
  ASSERT err IS NOT NULL, 'a released draft is never refilled';
  ASSERT (SELECT agreed_labour_ex = 1090 AND scope_revision_id = rev2 FROM public.work_orders
    WHERE id = f.wo), 'the released order keeps the accepted labour and revision';

  -- Approve once, then repeat: still exactly one order.
  v_row := public.approve_job_work_order(f.wo, v_approver, 'session', pg_temp.tk_stamp(f.wo), org);
  ASSERT v_row->>'status' = 'approved', 'the released order approves';
  err := pg_temp.tk_refused(format(
    'SELECT public.approve_job_work_order(%L, %L, ''session'', %L, %L)',
    f.wo, v_approver, pg_temp.tk_stamp(f.wo), org));
  ASSERT err LIKE 'work order is approved%', 'a repeat approval is refused: ' || coalesce(err, 'it went through');
  ASSERT (SELECT count(*) FROM public.work_orders WHERE job_id = f.job AND kind = 'job') = 1,
    'approving twice leaves exactly one work order';
  ASSERT (SELECT status = 'approved' AND agreed_labour_ex = 1090 AND scope_items = lines2
      AND scope_revision_id = rev2 AND quote_filled_scope_revision_id = rev2
    FROM public.work_orders WHERE id = f.wo), 'the one order keeps the accepted labour, lines and revision';
  ASSERT (SELECT work_order_id FROM public.jobs WHERE id = f.job) = f.wo, 'the job points at it';
  ASSERT public.ensure_job_work_order_draft(f.job, 'manual') = f.wo, 'asking again opens no second order';
  ASSERT (SELECT count(*) FROM public.work_orders WHERE job_id = f.job AND kind = 'job') = 1,
    'still one work order';
END $$;

-- 2. A release held at acceptance and then moved on by the deposit
-- (accepted -> awaiting_deposit -> order_materials) is retried there.
DO $$
DECLARE
  org uuid := (SELECT id FROM tk_people WHERE role = 'org');
  f record; r jsonb;
BEGIN
  f := pg_temp.tk_job(org);
  UPDATE public.jobs SET status = 'accepted' WHERE id = f.job;
  UPDATE public.jobs SET status = 'awaiting_deposit' WHERE id = f.job;
  UPDATE public.jobs SET status = 'order_materials' WHERE id = f.job;
  r := public.release_scope_job_drafts(f.job, f.rev);
  ASSERT r = '{"released": true, "replayed": false}'::jsonb, 'order_materials releases a held draft';
  ASSERT (SELECT released_at IS NOT NULL FROM public.scope_job_draft_sets WHERE job_id = f.job),
    'released once';
END $$;

-- 3. Every open status past acceptance releases; nothing else does.
DO $$
DECLARE
  org uuid := (SELECT id FROM tk_people WHERE role = 'org');
  f record; s text; err text;
BEGIN
  FOREACH s IN ARRAY public.job_work_order_open_statuses() LOOP
    CONTINUE WHEN s = 'partially_accepted';
    f := pg_temp.tk_job(org);
    UPDATE public.jobs SET status = s WHERE id = f.job;
    err := pg_temp.tk_refused(format('SELECT public.release_scope_job_drafts(%L, %L)', f.job, f.rev));
    ASSERT err IS NULL, s || ' releases: ' || coalesce(err, '');
  END LOOP;
  FOREACH s IN ARRAY ARRAY['draft', 'quoted', 'partially_accepted', 'cancelled', 'lost',
      'complete', 'invoiced'] LOOP
    f := pg_temp.tk_job(org);
    UPDATE public.jobs SET status = s WHERE id = f.job;
    err := pg_temp.tk_refused(format('SELECT public.release_scope_job_drafts(%L, %L)', f.job, f.rev));
    ASSERT err = 'scope_drafts_acceptance_required', s || ' releases nothing: ' || coalesce(err, 'released');
    ASSERT (SELECT released_at IS NULL FROM public.scope_job_draft_sets WHERE job_id = f.job),
      s || ' leaves the draft unreleased';
  END LOOP;
  -- The accepted revision must still be the prepared one.
  f := pg_temp.tk_job(org);
  UPDATE public.jobs SET status = 'scheduled' WHERE id = f.job;
  err := pg_temp.tk_refused(format('SELECT public.release_scope_job_drafts(%L, %L)', f.job, gen_random_uuid()));
  ASSERT err = 'scope_drafts_accepted_revision_mismatch', 'another revision is refused in any status';
END $$;

-- 4. Switch on: an acceptance by an open status is retained and the issue
-- waits for the owner, as for 'accepted'.
UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'owner_approval_saved_revision_required_v1';
DO $$
DECLARE
  org uuid := (SELECT id FROM tk_people WHERE role = 'org');
  f record; r jsonb;
BEGIN
  f := pg_temp.tk_job(org);
  UPDATE public.jobs SET status = 'scheduled' WHERE id = f.job;
  r := public.release_scope_job_drafts(f.job, f.rev);
  ASSERT r->>'held' = 'true' AND r->>'acceptance_recorded' = 'true',
    'on: an open-status acceptance is recorded and held for the owner';
  ASSERT (SELECT acceptance_recorded_at IS NOT NULL AND released_at IS NULL
    FROM public.scope_job_draft_sets WHERE job_id = f.job), 'on: acceptance kept, nothing issued';
  ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = f.wo), 'on: the draft waits';
END $$;

DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.release_scope_job_drafts(uuid,uuid,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.release_scope_job_drafts(uuid,uuid,boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.release_scope_job_drafts(uuid,uuid,boolean)', 'EXECUTE'),
    'the release stays the service role''s only';
END $$;

ROLLBACK;
