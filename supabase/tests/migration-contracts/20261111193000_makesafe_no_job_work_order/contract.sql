-- Contract for 20261111193000_makesafe_no_job_work_order.sql.
-- A make-safe job never gets a job work order, whatever
-- job_work_order_all_types_v1 says: the job trigger skips it, the one writer
-- refuses it, and the 30-day backfill leaves it out and skips it by name.
-- Repair, miscellaneous, fencing and patio open theirs exactly as before.
-- The retirement removes only a make-safe's draft that nobody touched and
-- nothing refers to, keeps the whole row first, clears the job's pointer, and
-- finds nothing on a second run. Synthetic data only.
BEGIN;

CREATE FUNCTION pg_temp.ms_refused(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || ' ' || SQLERRM;
END $$;

CREATE FUNCTION pg_temp.ms_job(p_type text, p_status text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_job uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.jobs(id, org_id, type, status, job_number)
    VALUES (v_job, '00000000-0000-0000-0000-000000000001', p_type, p_status,
            'ZZTEST-MSNOWO-' || left(v_job::text, 8));
  RETURN v_job;
END $$;

-- A blank draft exactly as the writer made one for a make-safe before this
-- migration: the same columns, and the job pointed at it.
CREATE FUNCTION pg_temp.ms_blank_draft(p_job uuid, p_point boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_wo uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.work_orders (id, org_id, job_id, wo_number, kind, status, scope_items, origin)
    VALUES (v_wo, '00000000-0000-0000-0000-000000000001', p_job,
            'WO-ZZTEST-' || left(v_wo::text, 8), 'job', 'draft', '[]'::jsonb, 'backfill');
  IF p_point THEN
    UPDATE public.jobs SET work_order_id = v_wo WHERE id = p_job;
  END IF;
  RETURN v_wo;
END $$;

CREATE FUNCTION pg_temp.ms_job_work_orders(p_job uuid) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*) FROM public.work_orders WHERE job_id = p_job AND kind = 'job'
$$;

INSERT INTO public.users (id, org_id, name, role) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000019c1', '00000000-0000-0000-0000-000000000001', 'ZZTEST Crew', 'crew')
ON CONFLICT (id) DO NOTHING;

-- 1. The switch on: a make-safe opens nothing on insert, on a status change
-- or when a job becomes a make-safe. Every other type opens its blank draft.
DO $$
DECLARE
  v_safe uuid; v_safe_late uuid; v_repair uuid; v_misc uuid; v_fence uuid; v_patio uuid;
  v_retyped uuid;
BEGIN
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';

  v_safe := pg_temp.ms_job('makesafe', 'scheduled');
  ASSERT pg_temp.ms_job_work_orders(v_safe) = 0,
    'make-safe: the switch on opens no job work order';
  ASSERT (SELECT work_order_id IS NULL FROM public.jobs WHERE id = v_safe),
    'make-safe: the job points at no work order';

  v_safe_late := pg_temp.ms_job('makesafe', 'quoted');
  UPDATE public.jobs SET status = 'scheduled' WHERE id = v_safe_late;
  UPDATE public.jobs SET status = 'in_progress' WHERE id = v_safe_late;
  ASSERT pg_temp.ms_job_work_orders(v_safe_late) = 0,
    'make-safe: a status change opens no job work order';

  v_repair := pg_temp.ms_job('repair', 'scheduled');
  ASSERT (SELECT count(*) = 1 AND bool_and(status = 'draft' AND origin = 'job_approved'
                                           AND agreed_labour_ex IS NULL)
          FROM public.work_orders WHERE job_id = v_repair AND kind = 'job'),
    'repair: still opens one blank draft while the switch is on';
  v_misc := pg_temp.ms_job('miscellaneous', 'scheduled');
  ASSERT pg_temp.ms_job_work_orders(v_misc) = 1,
    'miscellaneous: still opens one blank draft while the switch is on';
  v_fence := pg_temp.ms_job('fencing', 'accepted');
  v_patio := pg_temp.ms_job('patio', 'accepted');
  ASSERT pg_temp.ms_job_work_orders(v_fence) = 1 AND pg_temp.ms_job_work_orders(v_patio) = 1,
    'fencing and patio: unchanged';

  -- A job that becomes a make-safe while open opens nothing; one that stops
  -- being a make-safe opens its draft like any job of its new type.
  v_retyped := pg_temp.ms_job('repair', 'quoted');
  UPDATE public.jobs SET type = 'makesafe', status = 'scheduled' WHERE id = v_retyped;
  ASSERT pg_temp.ms_job_work_orders(v_retyped) = 0,
    'make-safe: a job retyped to make-safe opens no job work order';
  UPDATE public.jobs SET type = 'repair' WHERE id = v_retyped;
  ASSERT pg_temp.ms_job_work_orders(v_retyped) = 1,
    'repair: a make-safe retyped to repair opens its draft';

  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_all_types_v1';
  v_safe := pg_temp.ms_job('makesafe', 'scheduled');
  v_repair := pg_temp.ms_job('repair', 'scheduled');
  ASSERT pg_temp.ms_job_work_orders(v_safe) = 0 AND pg_temp.ms_job_work_orders(v_repair) = 0,
    'the switch off: neither a make-safe nor a repair opens one';
  ASSERT pg_temp.ms_job_work_orders(pg_temp.ms_job('fencing', 'accepted')) = 1,
    'the switch off: fencing still opens its draft';
END $$;

-- 2. The one writer refuses a make-safe by name, switch on or off, and
-- writes nothing. Its other answers are unchanged.
DO $$
DECLARE
  v_safe uuid := pg_temp.ms_job('makesafe', 'scheduled');
  v_repair uuid;
  v_wo uuid;
  err text;
BEGIN
  err := pg_temp.ms_refused(format('SELECT public.ensure_job_work_order_draft(%L, ''manual'')', v_safe));
  ASSERT err LIKE '23514 %make-safe%', 'the switch off: the writer refuses a make-safe by name: ' || coalesce(err, 'it opened one');

  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';
  err := pg_temp.ms_refused(format('SELECT public.ensure_job_work_order_draft(%L, ''manual'')', v_safe));
  ASSERT err LIKE '23514 %make-safe%', 'the switch on: the writer refuses a make-safe by name: ' || coalesce(err, 'it opened one');
  err := pg_temp.ms_refused(format('SELECT public.ensure_job_work_order_draft(%L, ''backfill'')', v_safe));
  ASSERT err LIKE '23514 %make-safe%', 'the switch on: the backfill origin is refused too: ' || coalesce(err, 'it opened one');
  ASSERT pg_temp.ms_job_work_orders(v_safe) = 0, 'a refused make-safe has no job work order';
  ASSERT (SELECT work_order_id IS NULL FROM public.jobs WHERE id = v_safe),
    'a refused make-safe points at no work order';

  err := pg_temp.ms_refused(format('SELECT public.ensure_job_work_order_draft(%L, ''manual'')', gen_random_uuid()));
  ASSERT err LIKE 'P0002 %', 'a missing job is still not found: ' || coalesce(err, 'no error');

  v_repair := pg_temp.ms_job('repair', 'quoted');
  v_wo := public.ensure_job_work_order_draft(v_repair, 'manual');
  ASSERT v_wo IS NOT NULL AND public.ensure_job_work_order_draft(v_repair, 'manual') = v_wo,
    'repair: the writer opens one draft and returns the same one again';
  ASSERT (SELECT work_order_id = v_wo FROM public.jobs WHERE id = v_repair),
    'repair: the job points at its draft';

  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_all_types_v1';
  err := pg_temp.ms_refused(format('SELECT public.ensure_job_work_order_draft(%L, ''manual'')',
                                   pg_temp.ms_job('repair', 'quoted')));
  ASSERT err LIKE '23514 %fencing%patio%', 'the switch off: a repair is refused as before: ' || coalesce(err, 'it opened one');

  ASSERT public.job_type_never_gets_job_work_order('makesafe')
     AND public.job_type_never_gets_job_work_order(' MakeSafe ')
     AND NOT public.job_type_never_gets_job_work_order('repair')
     AND NOT public.job_type_never_gets_job_work_order('miscellaneous')
     AND NOT public.job_type_never_gets_job_work_order('fencing')
     AND NOT public.job_type_never_gets_job_work_order('patio')
     AND NOT public.job_type_never_gets_job_work_order('')
     AND NOT public.job_type_never_gets_job_work_order(NULL),
    'the rule names make-safe and nothing else';
END $$;

-- 3. The 30-day backfill: the preview leaves an active make-safe out, and a
-- reviewed make-safe id is skipped by name without stopping the other ids.
DO $$
DECLARE
  v_crew uuid := 'aaaaaaaa-0000-0000-0000-0000000019c1';
  v_safe uuid := pg_temp.ms_job('makesafe', 'scheduled');
  v_repair uuid := pg_temp.ms_job('repair', 'scheduled');
  v_result jsonb;
BEGIN
  INSERT INTO public.job_assignments (id, job_id, user_id, role, scheduled_date, created_at) VALUES
    (gen_random_uuid(), v_safe, v_crew, 'lead_installer', current_date, now()),
    (gen_random_uuid(), v_repair, v_crew, 'lead_installer', current_date, now());
  ASSERT public.job_work_order_recent_activity(v_safe), 'fixture: the make-safe has activity inside 30 days';
  ASSERT NOT EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() p WHERE p.job_id = v_safe),
    'preview: an active make-safe is left out';
  ASSERT NOT EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() p WHERE p.job_type = 'makesafe'),
    'preview: no make-safe at all';
  ASSERT EXISTS (SELECT 1 FROM public.preview_active_job_work_orders() p WHERE p.job_id = v_repair),
    'preview: an active repair is still listed';

  UPDATE public.feature_flags SET enabled = true
    WHERE flag_name IN ('job_work_order_all_types_v1', 'job_work_order_active_backfill_v1');
  v_result := public.apply_active_job_work_orders(ARRAY[v_safe, v_repair]);
  ASSERT (v_result->>'opened')::int = 1 AND v_result->'opened_ids' ? v_repair::text,
    'apply: the repair after the make-safe is still opened: ' || v_result::text;
  ASSERT (v_result->>'skipped')::int = 1 AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_result->'skipped_jobs') e
      WHERE e->>'job_id' = v_safe::text AND e->>'reason' = 'job_type_not_eligible'),
    'apply: the make-safe is skipped by name: ' || v_result::text;
  ASSERT NOT (v_result->'opened_ids' ? v_safe::text) AND pg_temp.ms_job_work_orders(v_safe) = 0,
    'apply: the make-safe has no job work order';
  ASSERT (SELECT count(*) = 1 AND bool_and(origin = 'backfill' AND status = 'draft')
          FROM public.work_orders WHERE job_id = v_repair AND kind = 'job'),
    'apply: the repair has its blank backfill draft';
  UPDATE public.feature_flags SET enabled = false
    WHERE flag_name IN ('job_work_order_all_types_v1', 'job_work_order_active_backfill_v1');
END $$;

-- 4. Retirement. Only an untouched, unreferenced blank draft on a make-safe
-- goes. Every other row is exactly as it was.
CREATE TEMP TABLE ms_kept (label text PRIMARY KEY, wo uuid NOT NULL, before jsonb);
CREATE TEMP TABLE ms_gone (label text PRIMARY KEY, wo uuid NOT NULL, job uuid NOT NULL,
                           before jsonb, pointed boolean NOT NULL);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_crew uuid := 'aaaaaaaa-0000-0000-0000-0000000019c1';
  v_job uuid; v_wo uuid; v_invoice uuid; v_col text; v_label text;
  v_edits text[][] := ARRAY[
    ['labour',        'agreed_labour_ex = 250'],
    ['scope items',   'scope_items = ''[{"description":"Synthetic tarp","qty":1}]''::jsonb'],
    ['instructions',  'special_instructions = ''Synthetic note'''],
    ['a date',        'scheduled_date = current_date'],
    ['a trade name',  'trade_name = ''ZZTEST Trade'''],
    ['an assignee',   'assigned_user_id = ''aaaaaaaa-0000-0000-0000-0000000019c1'''],
    ['a hand edit',   'hand_edited_at = now()'],
    ['a quote fill',  'quote_filled_at = now()'],
    ['sent',          'sent_at = now()'],
    ['viewed',        'viewed_at = now()'],
    ['accepted',      'accepted_at = now()'],
    ['completed',     'completed_at = now()'],
    ['an approval time', 'approved_at = now()'],
    ['an approver',   'approved_by = ''aaaaaaaa-0000-0000-0000-0000000019c1'''],
    ['a scope revision', 'scope_revision_id = gen_random_uuid()'],
    ['a quote-fill scope revision', 'quote_filled_scope_revision_id = gen_random_uuid()'],
    ['a price approval', 'price_approval_id = gen_random_uuid()'],
    ['a work order approval', 'work_order_approval_id = gen_random_uuid()'],
    ['an approval', 'status = ''approved'', agreed_labour_ex = 250, approved_at = now(), approved_via = ''session'', sealed_content_hash = repeat(''a'', 64), approved_by = ''aaaaaaaa-0000-0000-0000-0000000019c1''']
  ];
BEGIN
  -- Goes: pointed at by its job, and not pointed at.
  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO ms_gone VALUES ('pointed', v_wo, v_job, NULL, true);
  v_job := pg_temp.ms_job('makesafe', 'complete');
  v_wo := pg_temp.ms_blank_draft(v_job, false);
  INSERT INTO ms_gone VALUES ('closed job, not pointed', v_wo, v_job, NULL, false);
  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  -- A legacy row with no scope list. Written past the draft guard, which
  -- would stamp the change as a hand edit.
  SET LOCAL session_replication_role = replica;
  UPDATE public.work_orders SET scope_items = NULL WHERE id = v_wo;
  SET LOCAL session_replication_role = origin;
  INSERT INTO ms_gone VALUES ('no scope list at all', v_wo, v_job, NULL, true);
  UPDATE ms_gone g SET before = (SELECT to_jsonb(w) FROM public.work_orders w WHERE w.id = g.wo);

  -- Stays: a make-safe draft somebody put anything on. Each differs from a
  -- blank draft in that one column only: the write goes past the draft
  -- guard, which would also stamp a hand edit.
  FOR i IN 1 .. array_length(v_edits, 1) LOOP
    v_job := pg_temp.ms_job('makesafe', 'scheduled');
    v_wo := pg_temp.ms_blank_draft(v_job);
    SET LOCAL session_replication_role = replica;
    EXECUTE format('UPDATE public.work_orders SET %s WHERE id = %L', v_edits[i][2], v_wo);
    SET LOCAL session_replication_role = origin;
    INSERT INTO ms_kept VALUES ('make-safe draft with ' || v_edits[i][1], v_wo, NULL);
  END LOOP;
  -- And the office's own edit, through the guard.
  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  UPDATE public.work_orders SET special_instructions = 'Synthetic office note' WHERE id = v_wo;
  ASSERT (SELECT hand_edited_at IS NOT NULL FROM public.work_orders WHERE id = v_wo),
    'fixture: an office edit is stamped as a hand edit';
  INSERT INTO ms_kept VALUES ('make-safe draft the office edited', v_wo, NULL);

  -- Stays: a make-safe draft something refers to.
  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay)
  VALUES (gen_random_uuid(), v_org, v_crew, 'draft', 10, 0, 10, false, 0.12, 1.2, 10, 9.4)
  RETURNING id INTO v_invoice;

  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex, job_work_order_id)
    VALUES (v_invoice, v_job, 'labour', 10, v_wo);
  INSERT INTO ms_kept VALUES ('make-safe draft a crew invoice line is stamped with', v_wo, NULL);

  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex, source_work_order_id)
    VALUES (v_invoice, v_job, 'labour', 10, v_wo);
  INSERT INTO ms_kept VALUES ('make-safe draft a crew invoice line is sourced from', v_wo, NULL);

  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.trade_invoices (id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay, work_order_id)
  VALUES (gen_random_uuid(), v_org, v_crew, 'draft', 10, 0, 10, false, 0.12, 1.2, 10, 9.4, v_wo);
  INSERT INTO ms_kept VALUES ('make-safe draft a trade invoice names', v_wo, NULL);

  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.group_work_orders (org_id, job_id, work_order_id, share_token)
    VALUES (v_org, v_job, v_wo, 'zztest-msnowo-' || v_wo::text);
  INSERT INTO ms_kept VALUES ('make-safe draft in a crew group', v_wo, NULL);

  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.work_order_variations (org_id, job_id, work_order_id, trade_invoice_id, reported_by, description)
    VALUES (v_org, v_job, v_wo, v_invoice, v_crew, 'Synthetic extra');
  INSERT INTO ms_kept VALUES ('make-safe draft with a variation', v_wo, NULL);

  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.job_work_order_owner_unapproved (job_id, work_order_id, work_order_kind, event)
    VALUES (v_job, v_wo, 'job', 'issued');
  INSERT INTO ms_kept VALUES ('make-safe draft with an unapproved-issue record', v_wo, NULL);

  -- A customer variation names its work order only once approved, and a
  -- scope draft set and an owner approval need a saved scope revision behind
  -- them. The rows only have to exist, so their own guards are skipped.
  SET LOCAL session_replication_role = replica;
  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.work_order_customer_variations (org_id, job_id, work_order_id, description, created_by)
    VALUES (v_org, v_job, v_wo, 'Synthetic customer extra', 'zztest');
  INSERT INTO ms_kept VALUES ('make-safe draft with a customer variation', v_wo, NULL);
  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.scope_job_draft_sets (job_id, org_id, scope_revision_id, work_order_id,
      labour_lines, totals, amounts_confirmed)
    VALUES (v_job, v_org, gen_random_uuid(), v_wo, '[]'::jsonb, '{}'::jsonb, false);
  INSERT INTO ms_kept VALUES ('make-safe draft in a scope draft set', v_wo, NULL);
  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  v_wo := pg_temp.ms_blank_draft(v_job);
  INSERT INTO public.scope_owner_approvals (kind, job_id, org_id, approver_user_id, authority, via,
      work_order_id, work_order_content_hash, work_order_updated_at)
    VALUES ('work_order', v_job, v_org, v_crew, 'owner', 'session', v_wo, repeat('a', 64), now());
  INSERT INTO ms_kept VALUES ('make-safe draft with an owner approval', v_wo, NULL);
  SET LOCAL session_replication_role = origin;

  -- Stays: every blank draft on a job that is not a make-safe.
  FOREACH v_col IN ARRAY ARRAY['repair', 'miscellaneous', 'fencing', 'patio'] LOOP
    v_job := pg_temp.ms_job(v_col, 'quoted');
    v_wo := pg_temp.ms_blank_draft(v_job);
    INSERT INTO ms_kept VALUES (v_col || ' blank draft', v_wo, NULL);
  END LOOP;

  -- Stays: a crew work order on a make-safe. It is not a job work order.
  v_job := pg_temp.ms_job('makesafe', 'scheduled');
  INSERT INTO public.work_orders (id, org_id, job_id, wo_number, kind, status, scope_items)
    VALUES (gen_random_uuid(), v_org, v_job, 'WO-ZZTEST-CREW', 'crew', 'draft', '[]'::jsonb)
    RETURNING id INTO v_wo;
  INSERT INTO ms_kept VALUES ('make-safe crew work order', v_wo, NULL);

  UPDATE ms_kept k SET before = (SELECT to_jsonb(w) FROM public.work_orders w WHERE w.id = k.wo);
END $$;

DO $$
DECLARE
  v_jobs_before jsonb;
  v_ledger_before bigint := (SELECT count(*) FROM public.job_work_order_retired_drafts);
  v_removed integer;
  r record;
BEGIN
  ASSERT (SELECT count(*) FROM ms_gone) = 3 AND (SELECT count(*) FROM ms_kept) = 34,
    'fixture: 3 drafts to retire and 34 rows to keep';
  SELECT jsonb_object_agg(j.id, jsonb_build_object('work_order_id', j.work_order_id, 'status', j.status, 'type', j.type))
    INTO v_jobs_before
    FROM public.jobs j WHERE j.id IN (SELECT w.job_id FROM public.work_orders w JOIN ms_kept k ON k.wo = w.id);

  v_removed := public.retire_blank_makesafe_job_work_orders();
  ASSERT v_removed = 3, 'retire: exactly the untouched make-safe drafts go, got ' || v_removed;

  FOR r IN SELECT * FROM ms_gone LOOP
    ASSERT NOT EXISTS (SELECT 1 FROM public.work_orders WHERE id = r.wo),
      'retire: the blank make-safe draft is gone (' || r.label || ')';
    ASSERT (SELECT work_order_id IS NULL FROM public.jobs WHERE id = r.job),
      'retire: the job points at no work order (' || r.label || ')';
    ASSERT (SELECT count(*) = 1 AND bool_and(
              d.job_id = r.job AND d.job_type = 'makesafe'
              AND d.reason = 'makesafe_no_job_work_order'
              AND d.job_pointer_cleared = r.pointed
              AND d.work_order = r.before)
            FROM public.job_work_order_retired_drafts d WHERE d.work_order_id = r.wo),
      'retire: the whole row is kept in the record first (' || r.label || ')';
  END LOOP;
  ASSERT (SELECT count(*) FROM public.job_work_order_retired_drafts) = v_ledger_before + 3,
    'retire: one record per draft removed and no other';

  FOR r IN SELECT k.*, (SELECT to_jsonb(w) FROM public.work_orders w WHERE w.id = k.wo) AS after FROM ms_kept k LOOP
    ASSERT r.after IS NOT NULL, 'retire: kept: ' || r.label;
    ASSERT r.after = r.before, 'retire: untouched: ' || r.label;
  END LOOP;
  ASSERT v_jobs_before = (
      SELECT jsonb_object_agg(j.id, jsonb_build_object('work_order_id', j.work_order_id, 'status', j.status, 'type', j.type))
      FROM public.jobs j WHERE j.id IN (SELECT w.job_id FROM public.work_orders w JOIN ms_kept k ON k.wo = w.id)),
    'retire: the jobs of the kept rows keep their pointer, status and type';

  -- A second run finds nothing.
  ASSERT public.retire_blank_makesafe_job_work_orders() = 0, 'retire: a second run removes nothing';
  ASSERT (SELECT count(*) FROM public.job_work_order_retired_drafts) = v_ledger_before + 3,
    'retire: a second run records nothing';
  ASSERT (SELECT count(*) FROM public.work_orders w JOIN ms_kept k ON k.wo = w.id) = 34,
    'retire: a second run keeps every kept row';

  -- The retired job stays clear with the switch on, and opens a fresh draft
  -- only if it stops being a make-safe.
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'job_work_order_all_types_v1';
  SELECT * INTO r FROM ms_gone WHERE label = 'pointed';
  UPDATE public.jobs SET status = 'in_progress' WHERE id = r.job;
  ASSERT pg_temp.ms_job_work_orders(r.job) = 0, 'retire: the make-safe stays without a job work order';
  UPDATE public.jobs SET type = 'repair' WHERE id = r.job;
  ASSERT pg_temp.ms_job_work_orders(r.job) = 1, 'retire: the one-per-job rule does not hold the retired job back';
  UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'job_work_order_all_types_v1';
END $$;

-- 5. Who may do what, and what the migration left alone.
DO $$
BEGIN
  ASSERT NOT has_function_privilege('service_role', 'public.retire_blank_makesafe_job_work_orders()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.retire_blank_makesafe_job_work_orders()', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.retire_blank_makesafe_job_work_orders()', 'EXECUTE'),
    'no API role can run the retirement';
  ASSERT has_table_privilege('service_role', 'public.job_work_order_retired_drafts', 'SELECT')
     AND NOT has_table_privilege('service_role', 'public.job_work_order_retired_drafts', 'INSERT')
     AND NOT has_table_privilege('service_role', 'public.job_work_order_retired_drafts', 'UPDATE')
     AND NOT has_table_privilege('service_role', 'public.job_work_order_retired_drafts', 'DELETE')
     AND NOT has_table_privilege('authenticated', 'public.job_work_order_retired_drafts', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.job_work_order_retired_drafts', 'SELECT'),
    'the record is read only, and only for the service role';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_work_order_retired_drafts'::regclass),
    'the record has row level security on';
  ASSERT has_function_privilege('service_role', 'public.apply_active_job_work_orders(uuid[])', 'EXECUTE')
     AND has_function_privilege('service_role', 'public.preview_active_job_work_orders()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.apply_active_job_work_orders(uuid[])', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.preview_active_job_work_orders()', 'EXECUTE'),
    'the backfill keeps its grants';
  ASSERT (SELECT description LIKE '%make-safe%' FROM public.feature_flags
          WHERE flag_name = 'job_work_order_all_types_v1'),
    'the switch says a make-safe is left out';
  ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid = 'public.work_orders'::regclass AND conname = 'work_orders_kind_status_check')
         NOT LIKE '%cancelled%',
    'a job work order still has no cancelled state';
END $$;

ROLLBACK;
