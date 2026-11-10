-- Contract for 20261111090000_job_work_order_acceptance_gate.sql (RQ-19.a).
-- A fencing or patio job's work order is not issued, and no crew group
-- opens on it, until the customer has accepted the job, by every path: the
-- office approval, a direct status write, an approved insert and a group
-- insert. Acceptance in any open status issues it, a job finished later still
-- issues a late work order, and jobs of other types are untouched. Runs with
-- the shipped switch state (owner_approval_saved_revision_required_v1 off).
-- Synthetic data only.
BEGIN;

CREATE FUNCTION pg_temp.rq_refused(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END $$;

-- A job in p_status with one complete draft job work order (labour 1250).
CREATE FUNCTION pg_temp.rq_job(p_org uuid, p_type text, p_status text, OUT job uuid, OUT wo uuid)
LANGUAGE plpgsql AS $$
BEGIN
  job := gen_random_uuid();
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
    VALUES (job, p_org, p_type, 'quoted', 'ZZTEST-SE-RQ19A-' || left(job::text, 8));
  wo := public.ensure_job_work_order_draft(job, 'manual');
  UPDATE public.work_orders SET agreed_labour_ex = 1250,
      scope_items = '[{"description":"Synthetic crew labour","qty":1,"unit":"job","price":1250}]'
    WHERE id = wo;
  IF p_status <> 'quoted' THEN UPDATE public.jobs SET status = p_status WHERE id = job; END IF;
END $$;

CREATE FUNCTION pg_temp.rq_approve(p_wo uuid, p_org uuid, p_approver uuid) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.rq_refused(format(
    'SELECT public.approve_job_work_order(%L, %L, ''session'', %L, %L)',
    p_wo, p_approver, (SELECT updated_at FROM public.work_orders WHERE id = p_wo), p_org))
$$;

CREATE TEMP TABLE rq_people (role text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO rq_people VALUES
  ('org', '0a0a0a0a-0000-4000-8000-00000000190a'), ('approver', gen_random_uuid());
INSERT INTO public.users(id, org_id, role, name)
  SELECT p.id, (SELECT id FROM rq_people WHERE role = 'org'), 'admin', 'ZZTEST Scope Checker'
  FROM rq_people p WHERE p.role = 'approver';
UPDATE public.work_order_settings
  SET approver_user_ids = approver_user_ids || (SELECT id FROM rq_people WHERE role = 'approver')
  WHERE id = 1;
UPDATE public.feature_flags SET enabled = false
  WHERE flag_name IN ('owner_approval_saved_revision_required_v1', 'job_work_order_auto_issue_v1');

-- 1. The rule itself.
DO $$
BEGIN
  ASSERT public.job_not_yet_accepted('fencing', 'quoted') AND public.job_not_yet_accepted('patio', 'draft')
    AND public.job_not_yet_accepted('fencing', 'partially_accepted') AND public.job_not_yet_accepted('patio', 'lost'),
    'draft, quoted, partially accepted and lost fencing and patio jobs are not accepted yet';
  ASSERT NOT public.job_not_yet_accepted('fencing', 'accepted') AND NOT public.job_not_yet_accepted('patio', 'deposit')
    AND NOT public.job_not_yet_accepted('fencing', 'complete') AND NOT public.job_not_yet_accepted('patio', 'archived'),
    'accepted and later statuses count as accepted';
  ASSERT NOT public.job_not_yet_accepted('makesafe', 'quoted') AND NOT public.job_not_yet_accepted('repair', 'draft')
    AND NOT public.job_not_yet_accepted(NULL, 'quoted'),
    'other job types are not judged by this rule';
END $$;

-- 2. A quoted fencing job: the office approval is refused and the draft
-- stays a draft; the job accepted (straight to Deposit) then issues it.
DO $$
DECLARE
  org uuid := (SELECT id FROM rq_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM rq_people WHERE role = 'approver');
  f record; err text;
BEGIN
  f := pg_temp.rq_job(org, 'fencing', 'quoted');
  err := pg_temp.rq_approve(f.wo, org, v_approver);
  ASSERT err LIKE 'WO412 job_work_order_job_not_accepted%', 'quoted: the approval is refused: ' || coalesce(err, 'it went through');
  ASSERT (SELECT status = 'draft' AND approved_at IS NULL FROM public.work_orders WHERE id = f.wo),
    'quoted: the draft stays a draft';

  UPDATE public.jobs SET status = 'deposit' WHERE id = f.job;
  err := pg_temp.rq_approve(f.wo, org, v_approver);
  ASSERT err IS NULL, 'deposit: accepted, the approval issues it: ' || coalesce(err, '');
  ASSERT (SELECT status = 'approved' AND agreed_labour_ex = 1250 FROM public.work_orders WHERE id = f.wo),
    'deposit: issued with its labour';
  ASSERT (SELECT count(*) FROM public.work_orders WHERE job_id = f.job AND kind = 'job') = 1,
    'one work order on the job';

  -- Once issued, the job moving back to quoted leaves it issued (nothing unseals).
  UPDATE public.jobs SET status = 'quoted' WHERE id = f.job;
  ASSERT (SELECT status = 'approved' FROM public.work_orders WHERE id = f.wo), 'an issued order stays issued';
END $$;

-- 3. Every not-accepted status refuses, for both trades and by every write.
DO $$
DECLARE
  org uuid := (SELECT id FROM rq_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM rq_people WHERE role = 'approver');
  f record; err text; s text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fencing', 'patio'] LOOP
    FOREACH s IN ARRAY ARRAY['draft', 'quoted', 'partially_accepted', 'lost'] LOOP
      f := pg_temp.rq_job(org, t, s);
      err := pg_temp.rq_approve(f.wo, org, v_approver);
      ASSERT err LIKE 'WO412 job_work_order_job_not_accepted%',
        format('%s %s: the approval is refused: %s', t, s, coalesce(err, 'it went through'));
      err := pg_temp.rq_refused(format(
        'UPDATE public.work_orders SET status = ''approved'', approved_by = %L, approved_at = now(), approved_via = ''session'' WHERE id = %L',
        v_approver, f.wo));
      ASSERT err LIKE 'WO412 job_work_order_job_not_accepted%',
        format('%s %s: a direct status write is refused: %s', t, s, coalesce(err, 'it went through'));
      ASSERT (SELECT status = 'draft' FROM public.work_orders WHERE id = f.wo),
        format('%s %s: the draft stays a draft', t, s);
    END LOOP;
  END LOOP;

  -- An approved row inserted straight onto a quoted job is refused too.
  f := pg_temp.rq_job(org, 'patio', 'quoted');
  DELETE FROM public.work_orders WHERE id = f.wo;
  err := pg_temp.rq_refused(format(
    'INSERT INTO public.work_orders(org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, approved_by, approved_at, approved_via)
       VALUES (%L, %L, ''ZZTEST-SE-RQ19A-INS'', ''job'', ''approved'', 1250, ''[{"description":"x"}]'', %L, now(), ''session'')',
    org, f.job, v_approver));
  ASSERT err LIKE 'WO412 job_work_order_job_not_accepted%', 'an approved insert is refused: ' || coalesce(err, 'it went through');
END $$;

-- 4. Accepted and later statuses issue; a late order on a finished job still
-- issues, as today.
DO $$
DECLARE
  org uuid := (SELECT id FROM rq_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM rq_people WHERE role = 'approver');
  f record; err text; s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['accepted', 'awaiting_deposit', 'order_materials', 'scheduled', 'in_progress',
                           'complete', 'invoiced', 'get_review', 'archived'] LOOP
    f := pg_temp.rq_job(org, 'fencing', s);
    err := pg_temp.rq_approve(f.wo, org, v_approver);
    ASSERT err IS NULL, format('%s: the approval issues: %s', s, coalesce(err, ''));
    ASSERT (SELECT status = 'approved' FROM public.work_orders WHERE id = f.wo), s || ': issued';
  END LOOP;
END $$;

-- 5. No crew group opens on a job that is not accepted, even on an order
-- issued while it was; the job accepted again lets it open.
DO $$
DECLARE
  org uuid := (SELECT id FROM rq_people WHERE role = 'org');
  v_approver uuid := (SELECT id FROM rq_people WHERE role = 'approver');
  f record; err text; s text;
BEGIN
  f := pg_temp.rq_job(org, 'patio', 'accepted');
  ASSERT pg_temp.rq_approve(f.wo, org, v_approver) IS NULL, 'the order issues once accepted';
  FOREACH s IN ARRAY ARRAY['draft', 'quoted', 'partially_accepted', 'lost'] LOOP
    UPDATE public.jobs SET status = s WHERE id = f.job;
    err := pg_temp.rq_refused(format(
      'INSERT INTO public.group_work_orders(org_id, job_id, work_order_id, share_token, pay_basis)
         VALUES (%L, %L, %L, %L, ''gross_v1'')',
      org, f.job, f.wo, 'zztest-se-rq19a-' || s));
    ASSERT err LIKE 'WO412 group_job_not_accepted%', format('%s: no group opens: %s', s, coalesce(err, 'it opened'));
  END LOOP;
  ASSERT NOT EXISTS (SELECT 1 FROM public.group_work_orders WHERE job_id = f.job), 'no group on the job';
  UPDATE public.jobs SET status = 'scheduled' WHERE id = f.job;
  err := pg_temp.rq_refused(format(
    'INSERT INTO public.group_work_orders(org_id, job_id, work_order_id, share_token, pay_basis)
       VALUES (%L, %L, %L, ''zztest-se-rq19a-open'', ''gross_v1'')',
    org, f.job, f.wo));
  ASSERT err IS NULL, 'scheduled: the group opens: ' || coalesce(err, '');
  ASSERT (SELECT count(*) FROM public.group_work_orders WHERE job_id = f.job) = 1, 'one group';
END $$;

-- 6. Grants.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('authenticated', 'public.job_not_yet_accepted(text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.job_not_yet_accepted(text,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.job_not_yet_accepted(text,text)', 'EXECUTE'),
    'the rule is the service role''s only';
  ASSERT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_work_orders_issue_needs_acceptance' AND NOT tgisinternal)
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_group_work_orders_open_needs_acceptance' AND NOT tgisinternal),
    'both triggers are in place';
END $$;

ROLLBACK;
