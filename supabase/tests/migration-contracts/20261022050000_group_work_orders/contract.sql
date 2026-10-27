-- Group work orders: one group per job and job work order, no dollar pot on
-- the group, and a trade reads only their own share, hours and points.
-- Feedback and the sealed price on any other job stay hidden.
-- The first check is the break target.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_group_work_orders_job_work_order'
      AND conrelid = 'public.group_work_orders'::regclass
  ) THEN
    RAISE EXCEPTION 'group-wo: missing unique job and work order';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'group_work_orders'
      AND column_name = 'agreed_labour_ex'
  ) THEN
    RAISE EXCEPTION 'group-wo: the group row must not store the pot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'group_work_order_shares'
      AND column_name = 'pot_ex'
  ) THEN
    RAISE EXCEPTION 'group-wo: a share row must snapshot pot_ex';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trade_invoice_lines'
      AND column_name = 'group_share_id'
  ) THEN
    RAISE EXCEPTION 'group-wo: trade_invoice_lines.group_share_id is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'group_work_order_client_link_send_v1' AND enabled = false
  ) THEN
    RAISE EXCEPTION 'group-wo: the client-link flag must exist and be off';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'group_work_order_v1' AND enabled = false
  ) THEN
    RAISE EXCEPTION 'group-wo: the master switch must exist and be off';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'completion_pack_client_email_v1' AND enabled = false
  ) THEN
    RAISE EXCEPTION 'group-wo: the completion-pack email flag must exist and be off';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'group_work_order_time_entries'
      AND column_name = 'updated_at'
  ) THEN
    RAISE EXCEPTION 'group-wo: hours updated_at is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'group_work_orders'
      AND column_name = 'hours_changed_at'
  ) THEN
    RAISE EXCEPTION 'group-wo: hours_changed_at is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.group_work_order_settings
    WHERE id = 1
      AND google_review_url = 'https://share.google/AFyfkE7jLfCZcxanV'
      AND review_prompt_min_rating = 4
  ) THEN
    RAISE EXCEPTION 'group-wo: review settings must be the seeded url and minimum 4';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'work_orders'
      AND policyname = 'work_orders_job_kind_hidden_from_clients'
      AND permissive = 'RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION 'group-wo: job work orders must stay hidden from PostgREST';
  END IF;
  IF has_table_privilege('authenticated', 'public.group_work_order_signatures', 'SELECT')
     OR has_table_privilege('anon', 'public.group_work_orders', 'SELECT') THEN
    RAISE EXCEPTION 'group-wo: signatures and anon must not have a select grant';
  END IF;
END $$;

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_staff uuid := 'a2140000-0000-4000-8000-000000000001';
  v_a uuid := 'a2140000-0000-4000-8000-00000000000a';
  v_b uuid := 'a2140000-0000-4000-8000-00000000000b';
  v_c uuid := 'a2140000-0000-4000-8000-00000000000c';
  v_job uuid := 'a2140000-0000-4000-8000-000000000101';
  v_other_job uuid := 'a2140000-0000-4000-8000-000000000102';
  v_group uuid := 'a2140000-0000-4000-8000-000000000201';
  v_other uuid := 'a2140000-0000-4000-8000-000000000202';
  n int;
  seen numeric;
BEGIN
  INSERT INTO public.users (id, org_id, name, role) VALUES
    (v_staff, v_org, 'Office', 'ops_manager'),
    (v_a, v_org, 'Crew A', 'crew'),
    (v_b, v_org, 'Crew B', 'crew'),
    (v_c, v_org, 'Crew C', 'crew')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.jobs (id, org_id, type, status, job_number) VALUES
    (v_job, v_org, 'makesafe', 'scheduled', 'GWO-1'),
    (v_other_job, v_org, 'makesafe', 'scheduled', 'GWO-2');

  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token) VALUES
    (v_group, v_org, v_job, 'a2140000-0000-4000-8000-000000000301', 'token-this-job'),
    (v_other, v_org, v_other_job, 'a2140000-0000-4000-8000-000000000302', 'token-other-job');

  BEGIN
    INSERT INTO public.group_work_orders (org_id, job_id, work_order_id, share_token)
    VALUES (v_org, v_job, 'a2140000-0000-4000-8000-000000000301', 'token-duplicate');
    RAISE EXCEPTION 'group-wo: a second group on the same job and work order was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO public.group_work_order_participants (group_id, user_id) VALUES
    (v_group, v_a),
    (v_group, v_b);

  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status) VALUES
    ('a2140000-0000-4000-8000-0000000000a2', v_job, v_a, '2026-10-21', 'scheduled'),
    ('a2140000-0000-4000-8000-0000000000b2', v_job, v_b, '2026-10-21', 'scheduled');

  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_group, v_a, '2026-10-21', '08:00', '16:00', 30, 7.50),
    (v_group, v_b, '2026-10-21', '08:00', '12:00', 0, 4.00);

  INSERT INTO public.group_work_order_shares
    (group_id, user_id, hours, points, share_ex, pot_ex)
  VALUES
    (v_group, v_a, 7.50, 300, 321.43, 482.15),
    (v_group, v_b, 4.00, 80, 200.00, 482.15),
    (v_other, v_b, 1.00, 20, 9999.99, 9999.99);

  INSERT INTO public.group_work_order_feedback (
    group_id, sales_process_rating, communication_rating, cleanliness_rating,
    punctuality_rating, crew_rating, submitted_via, free_text
  ) VALUES (v_group, 5, 5, 5, 5, 5, 'share_link', 'office only');

  INSERT INTO public.group_work_order_signatures
    (group_id, signer_kind, signer_name, signed_via)
  VALUES (v_group, 'crew', 'Alex Client', 'share_link');

  -- Participant A sees their own pot and share, not B's share or the other job.
  PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.group_work_order_shares;
  IF n <> 1 THEN
    RAISE EXCEPTION 'group-wo: participant A saw % share rows', n;
  END IF;
  SELECT share_ex INTO seen FROM public.group_work_order_shares;
  IF seen IS DISTINCT FROM 321.43 THEN
    RAISE EXCEPTION 'group-wo: participant A did not see their own share';
  END IF;
  SELECT pot_ex INTO seen FROM public.group_work_order_shares;
  IF seen IS DISTINCT FROM 482.15 THEN
    RAISE EXCEPTION 'group-wo: participant A did not see their own pot snapshot';
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_order_shares WHERE share_ex = 200 OR pot_ex = 9999.99) THEN
    RAISE EXCEPTION 'group-wo: participant A saw someone else''s share or another job''s price';
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_time_entries;
  IF n <> 1 THEN
    RAISE EXCEPTION 'group-wo: participant A saw % time rows', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_order_time_entries WHERE hours = 4) THEN
    RAISE EXCEPTION 'group-wo: participant A saw another crew member''s hours';
  END IF;
  SELECT count(*) INTO n FROM public.group_work_orders;
  IF n <> 1 THEN
    RAISE EXCEPTION 'group-wo: participant A saw % groups', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_orders WHERE share_token = 'token-other-job') THEN
    RAISE EXCEPTION 'group-wo: participant A saw the other job''s group';
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_feedback;
  IF n <> 0 THEN
    RAISE EXCEPTION 'group-wo: participant A read feedback';
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_settings;
  IF n <> 0 THEN
    RAISE EXCEPTION 'group-wo: participant A read review settings';
  END IF;
  RESET ROLE;

  -- Non-participant C sees no group, no share and no other job's price.
  PERFORM set_config('request.jwt.claim.sub', v_c::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.group_work_orders;
  IF n <> 0 THEN
    RAISE EXCEPTION 'group-wo: non-participant saw % groups', n;
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_shares;
  IF n <> 0 THEN
    RAISE EXCEPTION 'group-wo: non-participant saw % shares', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_order_shares WHERE pot_ex IN (482.15, 9999.99)) THEN
    RAISE EXCEPTION 'group-wo: non-participant read a sealed price';
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_time_entries;
  IF n <> 0 THEN
    RAISE EXCEPTION 'group-wo: non-participant saw hours';
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_feedback;
  IF n <> 0 THEN
    RAISE EXCEPTION 'group-wo: non-participant read feedback';
  END IF;
  RESET ROLE;

  -- Office sees the feedback. A trade does not.
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.group_work_order_feedback;
  IF n <> 1 THEN
    RAISE EXCEPTION 'group-wo: office saw % feedback rows', n;
  END IF;
  SELECT count(*) INTO n FROM public.group_work_order_shares;
  IF n <> 3 THEN
    RAISE EXCEPTION 'group-wo: office saw % share rows', n;
  END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM 1 FROM public.group_work_order_signatures;
    RAISE EXCEPTION 'group-wo: a trade selected signatures';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  SET LOCAL ROLE anon;
  BEGIN
    PERFORM 1 FROM public.group_work_orders;
    RAISE EXCEPTION 'group-wo: anon selected a group';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
END $$;

-- One frozen snapshot. The group above has a fake work order, so it is used
-- only to prove an unfrozen share cannot be invoiced. The priced group is new.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_shaun uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  v_a uuid := 'a2140000-0000-4000-8000-00000000000a';
  v_b uuid := 'a2140000-0000-4000-8000-00000000000b';
  v_c uuid := 'a2140000-0000-4000-8000-00000000000c';
  v_job uuid := 'a2140000-0000-4000-8000-000000000101';
  v_pot_job uuid := 'a2140000-0000-4000-8000-000000000111';
  v_group uuid := 'a2140000-0000-4000-8000-000000000201';
  v_freeze uuid := 'a2140000-0000-4000-8000-000000000211';
  v_wo uuid;
  v_share_a uuid;
  v_first jsonb;
  v_again jsonb;
  v_quote jsonb;
  v_a_share numeric;
  v_b_share numeric;
  v_hours numeric;
  v_draft uuid := 'a2140000-0000-4000-8000-000000000401';
  v_live uuid := 'a2140000-0000-4000-8000-000000000402';
  v_dup uuid := 'a2140000-0000-4000-8000-000000000403';
  v_wrong uuid := 'a2140000-0000-4000-8000-000000000404';
  v_submit uuid := 'a2140000-0000-4000-8000-000000000405';
  v_submit2 uuid := 'a2140000-0000-4000-8000-000000000406';
  v_save uuid := 'a2140000-0000-4000-8000-000000000407';
  v_media uuid := 'a2140000-0000-4000-8000-000000000501';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'group_work_orders'
      AND column_name = 'split_frozen_at'
  ) THEN
    RAISE EXCEPTION 'group-wo: split_frozen_at is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.freeze_group_work_order_split(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.project_group_work_order_split(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.unfreeze_group_work_order_split(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.group_work_order_write_split(uuid, boolean)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'group-wo: a trade must not execute the split functions';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.freeze_group_work_order_split(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.project_group_work_order_split(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.unfreeze_group_work_order_split(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.trade_invoice_lines_group_share_snapshot()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'group-wo: service_role must execute the freeze and the line snapshot';
  END IF;
  IF has_function_privilege('authenticated', 'public.group_work_order_lock_job(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.group_work_order_lock_job(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.group_work_order_lock_job(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'group-wo: the job lock must be service_role only';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'group_work_order_lock_job'
      AND (
        p.proacl IS NULL
        OR EXISTS (
          SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'group-wo: PUBLIC must not execute the job lock';
  END IF;

  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_draft, v_org, v_a, 'draft',
    250, 0, 250, false, 0.12, 30, 250, 235
  );
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, line_type, line_total_ex, group_share_id
    )
    SELECT v_draft, v_job, 'group share', s.share_ex, s.id
    FROM public.group_work_order_shares s
    WHERE s.group_id = v_group AND s.user_id = v_a;
    RAISE EXCEPTION 'group-wo: an unfrozen share line was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_client_signoff_required' THEN
      RAISE EXCEPTION 'group-wo: unfrozen line said %', SQLERRM;
    END IF;
  END;

  INSERT INTO public.users (id, org_id, name, role)
  VALUES (v_shaun, v_org, 'Shaun', 'ops_manager')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_pot_job, v_org, 'fencing', 'quoted', 'GWO-POT');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_pot_job, 'GWO-POT-1', 'job', 'draft', 482.15, '[]', 'group split fixture'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-POT-1';
  UPDATE public.work_orders
  SET status = 'approved', approved_by = v_shaun
  WHERE id = v_wo;
  IF (SELECT sealed_content_hash FROM public.work_orders WHERE id = v_wo) IS NULL THEN
    RAISE EXCEPTION 'group-wo: the pot work order did not seal';
  END IF;

  INSERT INTO public.trade_rates (id, org_id, user_id, hourly_rate, effective_from) VALUES
    ('a2140000-0000-4000-8000-0000000000a1', v_org, v_a, 40, '2026-01-01'),
    ('a2140000-0000-4000-8000-0000000000b1', v_org, v_b, 20, '2026-01-01');
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_freeze, v_org, v_pot_job, v_wo, 'token-freeze');
  INSERT INTO public.group_work_order_participants (group_id, user_id) VALUES
    (v_freeze, v_a),
    (v_freeze, v_b);
  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status) VALUES
    ('a2140000-0000-4000-8000-0000000000a3', v_pot_job, v_a, '2026-10-21', 'scheduled'),
    ('a2140000-0000-4000-8000-0000000000b3', v_pot_job, v_b, '2026-10-21', 'scheduled');
  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_freeze, v_a, '2026-10-21', '08:00', '10:00', 0, 2.00),
    (v_freeze, v_b, '2026-10-21', '08:00', '10:00', 0, 2.00);

  -- A quote before the client has signed writes nothing.
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.project_group_work_order_split(v_freeze);
    RAISE EXCEPTION 'group-wo: a quote without a sign-off was returned';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_client_signoff_required' THEN
      RAISE EXCEPTION 'group-wo: unsigned project said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF (SELECT count(*) FROM public.group_work_order_shares WHERE group_id = v_freeze) <> 0
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NOT NULL
  THEN
    RAISE EXCEPTION 'group-wo: an unsigned project wrote a share';
  END IF;

  INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
  VALUES (v_media, v_pot_job, 'signature', 'photo', 'data:image/png;base64,iVBORw0KGgo=');
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor
  ) VALUES (
    v_pot_job, 'share_link', 'Alex Client', true, 5, v_media, 'client link'
  );

  SET LOCAL ROLE service_role;
  v_quote := public.project_group_work_order_split(v_freeze);
  RESET ROLE;
  IF (SELECT count(*) FROM public.group_work_order_shares WHERE group_id = v_freeze) <> 0
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NOT NULL
     OR v_quote->>'frozen' IS DISTINCT FROM 'false'
     OR position('321.43' IN v_quote::text) = 0
     OR position('160.72' IN v_quote::text) = 0
  THEN
    RAISE EXCEPTION 'group-wo: project wrote or misquoted %', v_quote;
  END IF;

  -- A draft save before freeze stores the line, writes no share, and
  -- leaves the marker null.
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_save, v_org, v_a, 'draft',
    321.43, 0, 321.43, false, 0.12, 38.57, 321.43, 302.14
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_save, v_pot_job, 'group share', 321.43);
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NOT NULL
     OR (SELECT count(*) FROM public.group_work_order_shares WHERE group_id = v_freeze) <> 0
     OR (SELECT group_share_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_save) IS NOT NULL
  THEN
    RAISE EXCEPTION 'group-wo: a draft save froze or held the share';
  END IF;
  DELETE FROM public.trade_invoice_lines WHERE trade_invoice_id = v_save;
  DELETE FROM public.trade_invoices WHERE id = v_save;

  SET LOCAL ROLE service_role;
  v_first := public.freeze_group_work_order_split(v_freeze);
  RESET ROLE;
  SELECT share_ex INTO v_a_share FROM public.group_work_order_shares
  WHERE group_id = v_freeze AND user_id = v_a;
  SELECT share_ex INTO v_b_share FROM public.group_work_order_shares
  WHERE group_id = v_freeze AND user_id = v_b;
  IF v_a_share IS DISTINCT FROM 321.43 OR v_b_share IS DISTINCT FROM 160.72
     OR (SELECT round(sum(share_ex), 2) FROM public.group_work_order_shares WHERE group_id = v_freeze) IS DISTINCT FROM 482.15
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NULL
  THEN
    RAISE EXCEPTION 'group-wo: freeze priced % and %', v_a_share, v_b_share;
  END IF;

  BEGIN
    UPDATE public.group_work_order_time_entries
    SET hours = 7.50
    WHERE group_id = v_freeze AND user_id = v_a;
    RAISE EXCEPTION 'group-wo: frozen hours were edited';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_frozen' THEN
      RAISE EXCEPTION 'group-wo: hour edit said %', SQLERRM;
    END IF;
  END;
  SELECT hours INTO v_hours FROM public.group_work_order_time_entries
  WHERE group_id = v_freeze AND user_id = v_a;
  IF v_hours IS DISTINCT FROM 2.00 THEN
    RAISE EXCEPTION 'group-wo: frozen hours moved to %', v_hours;
  END IF;
  SET LOCAL ROLE service_role;
  v_again := public.freeze_group_work_order_split(v_freeze);
  RESET ROLE;
  IF v_again IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'group-wo: a second freeze rewrote the snapshot';
  END IF;

  SET LOCAL ROLE service_role;
  BEGIN
    INSERT INTO public.group_work_order_participants (group_id, user_id)
    VALUES (v_freeze, v_c);
    RAISE EXCEPTION 'group-wo: a late joiner was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_frozen' THEN
      RAISE EXCEPTION 'group-wo: late joiner said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF EXISTS (
    SELECT 1 FROM public.group_work_order_participants
    WHERE group_id = v_freeze AND user_id = v_c
  ) THEN
    RAISE EXCEPTION 'group-wo: the late joiner row survived';
  END IF;

  BEGIN
    UPDATE public.group_work_order_shares
    SET share_ex = 1
    WHERE group_id = v_freeze AND user_id = v_a;
    RAISE EXCEPTION 'group-wo: a frozen share was rewritten';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_frozen' THEN
      RAISE EXCEPTION 'group-wo: share guard said %', SQLERRM;
    END IF;
  END;

  SELECT id INTO v_share_a FROM public.group_work_order_shares
  WHERE group_id = v_freeze AND user_id = v_a;
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, line_type, line_total_ex, group_share_id
    ) VALUES (v_draft, v_pot_job, 'group share', 1.00, v_share_a);
    RAISE EXCEPTION 'group-wo: a mismatched share line was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_share_amount_mismatch' THEN
      RAISE EXCEPTION 'group-wo: amount guard said %', SQLERRM;
    END IF;
  END;
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex, group_share_id
  ) VALUES (v_draft, v_pot_job, 'group share', 321.43, v_share_a);

  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_dup, v_org, v_a, 'draft',
    321.43, 0, 321.43, false, 0.12, 38.57, 321.43, 302.14
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex, group_share_id
  ) VALUES (v_dup, v_pot_job, 'group share', 321.43, v_share_a);
  IF (SELECT group_share_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_dup) IS DISTINCT FROM v_share_a
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NULL
  THEN
    RAISE EXCEPTION 'group-wo: a second draft did not keep the frozen share';
  END IF;

  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_wrong, v_org, v_b, 'draft',
    321.43, 0, 321.43, false, 0.12, 38.57, 321.43, 302.14
  );
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, line_type, line_total_ex, group_share_id
    ) VALUES (v_wrong, v_pot_job, 'group share', 321.43, v_share_a);
    RAISE EXCEPTION 'group-wo: another trade invoiced this share';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_share_owner_mismatch' THEN
      RAISE EXCEPTION 'group-wo: owner guard said %', SQLERRM;
    END IF;
  END;

  -- Save then submit: a pending line replaces the drafts' hold. A second
  -- pending line is the duplicate. Unfreeze refuses until that submit is
  -- back to draft, which is what the strip below needs.
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_submit, v_org, v_a, 'pending_acknowledgment',
    321.43, 0, 321.43, false, 0.12, 38.57, 321.43, 302.14
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_submit, v_pot_job, 'group share', 321.43);
  IF (SELECT group_share_id FROM public.trade_invoice_lines WHERE trade_invoice_id = v_submit) IS DISTINCT FROM v_share_a
  THEN
    RAISE EXCEPTION 'group-wo: submitting over a draft did not stamp the share';
  END IF;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_submit2, v_org, v_a, 'pending_acknowledgment',
    321.43, 0, 321.43, false, 0.12, 38.57, 321.43, 302.14
  );
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, line_type, line_total_ex
    ) VALUES (v_submit2, v_pot_job, 'group share', 321.43);
    RAISE EXCEPTION 'group-wo: a second live share line was stored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_share_already_invoiced' THEN
      RAISE EXCEPTION 'group-wo: duplicate share said %', SQLERRM;
    END IF;
  END;
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.unfreeze_group_work_order_split(v_freeze, v_shaun);
    RAISE EXCEPTION 'group-wo: unfreeze ran over a submitted invoice';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_has_live_invoice' THEN
      RAISE EXCEPTION 'group-wo: submitted unfreeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NULL THEN
    RAISE EXCEPTION 'group-wo: a refused unfreeze cleared the marker';
  END IF;
  UPDATE public.trade_invoices SET status = 'draft' WHERE id = v_submit;

  -- A draft share invoice is returned. The snapshot is cleared, not recomputed.
  SET LOCAL ROLE service_role;
  PERFORM public.unfreeze_group_work_order_split(v_freeze, v_shaun);
  RESET ROLE;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NOT NULL
     OR (SELECT count(*) FROM public.group_work_order_shares WHERE group_id = v_freeze) <> 0
     OR (SELECT status FROM public.trade_invoices WHERE id = v_draft) IS DISTINCT FROM 'draft'
     OR (SELECT subtotal_ex FROM public.trade_invoices WHERE id = v_draft) IS DISTINCT FROM 0
     OR (SELECT gross_earned FROM public.trade_invoices WHERE id = v_draft) IS DISTINCT FROM 0
     OR (SELECT super_amount FROM public.trade_invoices WHERE id = v_draft) IS DISTINCT FROM 0
     OR (SELECT net_pay FROM public.trade_invoices WHERE id = v_draft) IS DISTINCT FROM 0
     OR (SELECT gst FROM public.trade_invoices WHERE id = v_draft) IS DISTINCT FROM 0
     OR (SELECT total_inc FROM public.trade_invoices WHERE id = v_draft) IS DISTINCT FROM 0
     OR EXISTS (
       SELECT 1 FROM public.trade_invoice_lines WHERE trade_invoice_id = v_draft
     )
  THEN
    RAISE EXCEPTION 'group-wo: unfreeze did not strip the share and recalculate the draft';
  END IF;

  UPDATE public.group_work_order_time_entries
  SET hours = 7.50
  WHERE group_id = v_freeze AND user_id = v_a;
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.freeze_group_work_order_split(v_freeze);
    RAISE EXCEPTION 'group-wo: an edited hour was covered by the older drawing';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_client_signoff_required' THEN
      RAISE EXCEPTION 'group-wo: edited hours said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor
  ) VALUES (
    v_pot_job, 'on_site', 'Alex Client', true, 5, v_media, 'user:' || v_a::text
  );
  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_freeze);
  RESET ROLE;
  SELECT share_ex INTO v_a_share FROM public.group_work_order_shares
  WHERE group_id = v_freeze AND user_id = v_a;
  SELECT share_ex INTO v_b_share FROM public.group_work_order_shares
  WHERE group_id = v_freeze AND user_id = v_b;
  IF v_a_share IS DISTINCT FROM 425.43 OR v_b_share IS DISTINCT FROM 56.72
     OR (SELECT round(sum(share_ex), 2) FROM public.group_work_order_shares WHERE group_id = v_freeze) IS DISTINCT FROM 482.15
  THEN
    RAISE EXCEPTION 'group-wo: the second freeze priced % and %', v_a_share, v_b_share;
  END IF;

  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_live, v_org, v_b, 'approved',
    56.72, 0, 56.72, false, 0.12, 6.81, 56.72, 53.32
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex, group_share_id
  ) VALUES (v_live, v_pot_job, 'group share', 56.72, (
    SELECT id FROM public.group_work_order_shares
    WHERE group_id = v_freeze AND user_id = v_b
  ));
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.unfreeze_group_work_order_split(v_freeze, v_shaun);
    RAISE EXCEPTION 'group-wo: unfreeze ran over an approved invoice';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_has_live_invoice' THEN
      RAISE EXCEPTION 'group-wo: live unfreeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NULL THEN
    RAISE EXCEPTION 'group-wo: a refused unfreeze cleared the marker';
  END IF;
END $$;

-- One of two participants has hours and no trade_rates row. Freeze and the
-- quote both refuse and name that person. No share row is written.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_shaun uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  v_rated uuid := 'a2140000-0000-4000-8000-00000000000a';
  v_missing uuid := 'a2140000-0000-4000-8000-00000000000c';
  v_job uuid := 'a2140000-0000-4000-8000-000000000121';
  v_group uuid := 'a2140000-0000-4000-8000-000000000221';
  v_wo uuid;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, v_org, 'fencing', 'quoted', 'GWO-NORATE');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_job, 'GWO-NORATE-1', 'job', 'draft', 482.15, '[]', 'missing rate'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-NORATE-1';
  UPDATE public.work_orders
  SET status = 'approved', approved_by = v_shaun
  WHERE id = v_wo;
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_group, v_org, v_job, v_wo, 'token-norate');
  INSERT INTO public.group_work_order_participants (group_id, user_id) VALUES
    (v_group, v_rated),
    (v_group, v_missing);
  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status) VALUES
    ('a2140000-0000-4000-8000-0000000000a4', v_job, v_rated, '2026-10-21', 'scheduled'),
    ('a2140000-0000-4000-8000-0000000000c4', v_job, v_missing, '2026-10-21', 'scheduled');
  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_group, v_rated, '2026-10-21', '08:00', '10:00', 0, 2.00),
    (v_group, v_missing, '2026-10-21', '08:00', '10:00', 0, 2.00);

  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.project_group_work_order_split(v_group);
    RAISE EXCEPTION 'group-wo: a missing rate was quoted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'group_share_rate_missing:%'
       OR position(v_missing::text IN SQLERRM) = 0
       OR position(v_rated::text IN SQLERRM) > 0
    THEN
      RAISE EXCEPTION 'group-wo: missing-rate project said %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM public.freeze_group_work_order_split(v_group);
    RAISE EXCEPTION 'group-wo: a missing rate was frozen';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'group_share_rate_missing:%'
       OR position(v_missing::text IN SQLERRM) = 0
    THEN
      RAISE EXCEPTION 'group-wo: missing-rate freeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF (SELECT count(*) FROM public.group_work_order_shares WHERE group_id = v_group) <> 0
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_group) IS NOT NULL
  THEN
    RAISE EXCEPTION 'group-wo: a missing rate wrote a share';
  END IF;
END $$;

-- Every pay type is refused on an open group while the switch is off, and a
-- share is refused when normal pay is already on the job. Commission and
-- travel are not pay. SVG is not a signature.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_shaun uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  v_a uuid := 'a2140000-0000-4000-8000-00000000000a';
  v_b uuid := 'a2140000-0000-4000-8000-00000000000b';
  v_extra uuid := 'd2140000-0000-4000-8000-00000000000d';
  v_job uuid := 'd2140000-0000-4000-8000-000000000111';
  v_group uuid := 'd2140000-0000-4000-8000-000000000211';
  v_invoice uuid := 'd2140000-0000-4000-8000-000000000401';
  v_pay_job uuid := 'd2140000-0000-4000-8000-000000000112';
  v_pay_group uuid := 'd2140000-0000-4000-8000-000000000212';
  v_pay_invoice uuid := 'd2140000-0000-4000-8000-000000000402';
  v_open_job uuid := 'd2140000-0000-4000-8000-000000000113';
  v_open_invoice uuid := 'd2140000-0000-4000-8000-000000000403';
  v_hours_job uuid := 'd2140000-0000-4000-8000-000000000114';
  v_hours_group uuid := 'd2140000-0000-4000-8000-000000000214';
  v_sign_job uuid := 'd2140000-0000-4000-8000-000000000115';
  v_sign_group uuid := 'd2140000-0000-4000-8000-000000000215';
  v_strip_job uuid := 'd2140000-0000-4000-8000-000000000116';
  v_strip_group uuid := 'd2140000-0000-4000-8000-000000000216';
  v_strip_invoice uuid := 'd2140000-0000-4000-8000-000000000404';
  v_void_job uuid := 'd2140000-0000-4000-8000-000000000117';
  v_void_group uuid := 'd2140000-0000-4000-8000-000000000217';
  v_other_job uuid := 'd2140000-0000-4000-8000-000000000118';
  v_other_invoice uuid := 'd2140000-0000-4000-8000-000000000406';
  v_week_invoice uuid := 'd2140000-0000-4000-8000-000000000405';
  v_deduction uuid := 'd2140000-0000-4000-8000-0000000000d1';
  v_wo uuid;
  v_type text;
  v_share numeric;
  v_def text;
  v_types text[] := ARRAY[
    'labour', 'fencing', 'patio', 'make safe', 'MakeSafe',
    'general labour', 'decking', 'hours', 'work order', 'work_order',
    'Other', 'mystery'
  ];
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag_name = 'group_work_order_v1' AND enabled
  ) THEN
    RAISE EXCEPTION 'group-wo: the switch must stay off while the backstop runs';
  END IF;

  INSERT INTO public.users (id, org_id, name, role)
  VALUES (v_extra, v_org, 'Extra Installer', 'crew')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, v_org, 'fencing', 'quoted', 'GWO-PAY');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_job, 'GWO-PAY-1', 'job', 'draft', 100, '[]', 'pay types'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-PAY-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_group, v_org, v_job, v_wo, 'token-pay-types');
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_invoice, v_org, v_a, 'draft', 0, 0, 0, false, 0.12, 0, 0, 0
  );
  FOREACH v_type IN ARRAY v_types LOOP
    BEGIN
      INSERT INTO public.trade_invoice_lines (
        trade_invoice_id, job_id, line_type, line_total_ex
      ) VALUES (v_invoice, v_job, v_type, 10);
      RAISE EXCEPTION 'group-wo: % was stored beside an open group', v_type;
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM IS DISTINCT FROM 'work_order_claim_blocked_by_group_share' THEN
        RAISE EXCEPTION 'group-wo: % said %', v_type, SQLERRM;
      END IF;
    END;
  END LOOP;
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES
    (v_invoice, v_job, 'commission', 10),
    (v_invoice, v_job, 'travel', 10);
  IF (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id = v_invoice) <> 2 THEN
    RAISE EXCEPTION 'group-wo: commission or travel was refused';
  END IF;

  BEGIN
    INSERT INTO public.group_work_order_signatures (
      group_id, signer_kind, user_id, signer_name, signature_png, signed_via
    ) VALUES (
      v_group, 'crew', v_a, 'Crew A',
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'on_site'
    );
    RAISE EXCEPTION 'group-wo: an SVG signature was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.group_work_order_signatures (
      group_id, signer_kind, user_id, signer_name, signature_png, signed_via
    ) VALUES (
      v_group, 'crew', v_a, 'Crew A',
      'data:image/png;base64,aaaa" onerror="alert(1)',
      'on_site'
    );
    RAISE EXCEPTION 'group-wo: an injected signature was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO public.group_work_order_signatures (
    group_id, signer_kind, user_id, signer_name, signature_png, signed_via
  ) VALUES (
    v_group, 'crew', v_a, 'Crew A', 'data:image/png;base64,iVBORw0KGgo=', 'on_site'
  );

  -- Normal pay on ops-reject does not block opening a group. Moving that
  -- invoice back to draft, without touching the line, blocks the share.
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_pay_job, v_org, 'fencing', 'quoted', 'GWO-PAY2');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_pay_job, 'GWO-PAY-2', 'job', 'draft', 100, '[]', 'pay then share'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-PAY-2';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_pay_invoice, v_org, v_a, 'ops-reject', 10, 0, 10, false, 0.12, 1.20, 10, 9.40
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_pay_invoice, v_pay_job, 'fencing', 10);
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_pay_group, v_org, v_pay_job, v_wo, 'token-pay-then-share');
  UPDATE public.trade_invoices SET status = 'draft' WHERE id = v_pay_invoice;
  BEGIN
    INSERT INTO public.trade_invoice_lines (
      trade_invoice_id, job_id, line_type, line_total_ex
    ) VALUES (v_pay_invoice, v_pay_job, 'group share', 10);
    RAISE EXCEPTION 'group-wo: a share was stored over existing pay';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_share_blocked_by_work_order_claim' THEN
      RAISE EXCEPTION 'group-wo: share over pay said %', SQLERRM;
    END IF;
  END;

  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_open_job, v_org, 'fencing', 'quoted', 'GWO-OPEN');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_open_job, 'GWO-OPEN-1', 'job', 'draft', 100, '[]', 'open blocked'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-OPEN-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_open_invoice, v_org, v_a, 'draft', 10, 0, 10, false, 0.12, 1.20, 10, 9.40
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_open_invoice, v_open_job, 'decking', 10);
  BEGIN
    INSERT INTO public.group_work_orders (org_id, job_id, work_order_id, share_token)
    VALUES (v_org, v_open_job, v_wo, 'token-open-blocked');
    RAISE EXCEPTION 'group-wo: a group opened over normal pay';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_open_blocked_by_work_order_claim' THEN
      RAISE EXCEPTION 'group-wo: open over pay said %', SQLERRM;
    END IF;
  END;

  -- 'Other' is pay on a group job. Pending Marnin.
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_other_job, v_org, 'fencing', 'quoted', 'GWO-OTHER');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_other_job, 'GWO-OTHER-1', 'job', 'draft', 100, '[]', 'other blocks open'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-OTHER-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_other_invoice, v_org, v_a, 'draft', 10, 0, 10, false, 0.12, 1.20, 10, 9.40
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_other_invoice, v_other_job, 'Other', 10);
  BEGIN
    INSERT INTO public.group_work_orders (org_id, job_id, work_order_id, share_token)
    VALUES (v_org, v_other_job, v_wo, 'token-other-blocked');
    RAISE EXCEPTION 'group-wo: a group opened over an Other line';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_open_blocked_by_work_order_claim' THEN
      RAISE EXCEPTION 'group-wo: open over Other said %', SQLERRM;
    END IF;
  END;

  -- Freeze names an installer who is assigned and has not joined.
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_hours_job, v_org, 'fencing', 'quoted', 'GWO-HOURS');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_hours_job, 'GWO-HOURS-1', 'job', 'draft', 482.15, '[]', 'assigned hours'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-HOURS-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  -- v_a and v_b already have a rate from the pot fixture (unique on org, user, effective_from).
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_hours_group, v_org, v_hours_job, v_wo, 'token-hours');
  INSERT INTO public.group_work_order_participants (group_id, user_id) VALUES
    (v_hours_group, v_a), (v_hours_group, v_b);
  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status) VALUES
    ('d2140000-0000-4000-8000-0000000000a5', v_hours_job, v_a, '2026-10-21', 'scheduled'),
    ('d2140000-0000-4000-8000-0000000000b5', v_hours_job, v_b, '2026-10-21', 'scheduled'),
    ('d2140000-0000-4000-8000-0000000000d5', v_hours_job, v_extra, '2026-10-21', 'scheduled');
  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_hours_group, v_a, '2026-10-21', '08:00', '10:00', 0, 2.00),
    (v_hours_group, v_b, '2026-10-21', '08:00', '10:00', 0, 2.00);
  INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
  VALUES (
    'd2140000-0000-4000-8000-000000000501', v_hours_job, 'signature', 'photo',
    'data:image/png;base64,iVBORw0KGgo='
  );
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor
  ) VALUES (
    v_hours_job, 'share_link', 'Alex Client', true, 5,
    'd2140000-0000-4000-8000-000000000501', 'client link'
  );
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.freeze_group_work_order_split(v_hours_group);
    RAISE EXCEPTION 'group-wo: freeze ignored an assigned installer';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'group_split_needs_hours:%'
       OR position(v_extra::text IN SQLERRM) = 0
       OR position(v_a::text IN SQLERRM) > 0
    THEN
      RAISE EXCEPTION 'group-wo: assigned-hours freeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  UPDATE public.job_assignments SET status = 'cancelled'
  WHERE id = 'd2140000-0000-4000-8000-0000000000d5';
  SET LOCAL ROLE service_role;
  PERFORM public.remove_group_work_order_participant(v_hours_group, v_b, v_shaun);
  BEGIN
    PERFORM public.freeze_group_work_order_split(v_hours_group);
    RAISE EXCEPTION 'group-wo: freeze ignored a removed participant who is still assigned';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'group_split_needs_hours:%'
       OR position(v_b::text IN SQLERRM) = 0
    THEN
      RAISE EXCEPTION 'group-wo: removed-participant freeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  UPDATE public.job_assignments SET status = 'cancelled'
  WHERE id = 'd2140000-0000-4000-8000-0000000000b5';
  -- Removing v_b bumped hours_changed_at past the drawing above.
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor, created_at
  ) VALUES (
    v_hours_job, 'share_link', 'Alex Client', true, 5,
    'd2140000-0000-4000-8000-000000000501', 'client link',
    COALESCE(
      (SELECT hours_changed_at FROM public.group_work_orders WHERE id = v_hours_group),
      clock_timestamp()
    ) + interval '1 second'
  );
  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_hours_group);
  BEGIN
    PERFORM public.remove_group_work_order_participant(v_hours_group, v_a, v_shaun);
    RAISE EXCEPTION 'group-wo: a participant was removed after freeze';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_frozen' THEN
      RAISE EXCEPTION 'group-wo: remove after freeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF NOT EXISTS (
    SELECT 1 FROM public.group_work_order_events
    WHERE group_id = v_hours_group AND action = 'remove_participant'
  ) THEN
    RAISE EXCEPTION 'group-wo: removing a participant was not audited';
  END IF;

  -- A drawn sign-off dated before the hours does not count, and neither
  -- does an office waiver or a revocation.
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_sign_job, v_org, 'fencing', 'quoted', 'GWO-SIGN');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_sign_job, 'GWO-SIGN-1', 'job', 'draft', 482.15, '[]', 'signoff date'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-SIGN-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_sign_group, v_org, v_sign_job, v_wo, 'token-sign');
  INSERT INTO public.group_work_order_participants (group_id, user_id)
  VALUES (v_sign_group, v_a);
  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status)
  VALUES ('d2140000-0000-4000-8000-0000000000a6', v_sign_job, v_a, '2026-10-21', 'scheduled');
  INSERT INTO public.group_work_order_time_entries (
    group_id, user_id, work_date, start_time, finish_time, break_minutes, hours, created_at
  ) VALUES (
    v_sign_group, v_a, '2026-10-21', '08:00', '10:00', 0, 2.00, '2026-10-22 00:00:00+00'
  );
  INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
  VALUES (
    'd2140000-0000-4000-8000-000000000502', v_sign_job, 'signature', 'photo',
    'data:image/png;base64,iVBORw0KGgo='
  );
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor, created_at
  ) VALUES (
    v_sign_job, 'on_site', 'Alex Client', true, 5,
    'd2140000-0000-4000-8000-000000000502', 'user:' || v_a::text,
    '2026-10-21 00:00:00+00'
  );
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.freeze_group_work_order_split(v_sign_group);
    RAISE EXCEPTION 'group-wo: a sign-off dated before the hours froze the split';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_client_signoff_required' THEN
      RAISE EXCEPTION 'group-wo: early sign-off said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  INSERT INTO public.job_client_signoffs (
    job_id, method, waiver_reason, captured_by_actor, created_at
  ) VALUES (
    v_sign_job, 'office_waiver', 'office waived', 'user:' || v_shaun::text,
    '2026-10-23 00:00:00+00'
  );
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.freeze_group_work_order_split(v_sign_group);
    RAISE EXCEPTION 'group-wo: an office waiver froze a group';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_client_signoff_required' THEN
      RAISE EXCEPTION 'group-wo: waiver freeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  INSERT INTO public.job_client_signoffs (
    job_id, method, captured_by, captured_by_actor, created_at
  ) VALUES (
    v_sign_job, 'revoked', v_shaun, 'user:' || v_shaun::text,
    '2026-10-24 00:00:00+00'
  );
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.freeze_group_work_order_split(v_sign_group);
    RAISE EXCEPTION 'group-wo: a revoked sign-off froze a group';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_client_signoff_required' THEN
      RAISE EXCEPTION 'group-wo: revoked freeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;

  -- Unfreeze strips only the share. Pending acknowledgement, acknowledged,
  -- and any Xero id, refuse.
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_strip_job, v_org, 'fencing', 'quoted', 'GWO-STRIP');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_strip_job, 'GWO-STRIP-1', 'job', 'draft', 482.15, '[]', 'strip share'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-STRIP-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_strip_group, v_org, v_strip_job, v_wo, 'token-strip');
  INSERT INTO public.group_work_order_participants (group_id, user_id)
  VALUES (v_strip_group, v_a), (v_strip_group, v_b);
  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status) VALUES
    ('d2140000-0000-4000-8000-0000000000a7', v_strip_job, v_a, '2026-10-21', 'scheduled'),
    ('d2140000-0000-4000-8000-0000000000b7', v_strip_job, v_b, '2026-10-21', 'scheduled');
  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_strip_group, v_a, '2026-10-21', '08:00', '10:00', 0, 2.00),
    (v_strip_group, v_b, '2026-10-21', '08:00', '10:00', 0, 2.00);
  INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
  VALUES (
    'd2140000-0000-4000-8000-000000000503', v_strip_job, 'signature', 'photo',
    'data:image/png;base64,iVBORw0KGgo='
  );
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor
  ) VALUES (
    v_strip_job, 'share_link', 'Alex Client', true, 5,
    'd2140000-0000-4000-8000-000000000503', 'client link'
  );
  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_strip_group);
  RESET ROLE;
  SELECT share_ex INTO v_share FROM public.group_work_order_shares
  WHERE group_id = v_strip_group AND user_id = v_a;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_strip_invoice, v_org, v_a, 'draft',
    10, 0, 10, false, 0.12, 1.20, 10, 9.40
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_strip_invoice, v_strip_job, 'travel', 10);
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_strip_invoice, v_strip_job, 'group share', v_share);
  UPDATE public.trade_invoices SET xero_bill_id = 'bill-strip' WHERE id = v_strip_invoice;
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.unfreeze_group_work_order_split(v_strip_group, v_shaun);
    RAISE EXCEPTION 'group-wo: unfreeze ran over a Xero id';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_has_live_invoice' THEN
      RAISE EXCEPTION 'group-wo: xero unfreeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  UPDATE public.trade_invoices
  SET xero_bill_id = NULL, status = 'acknowledged'
  WHERE id = v_strip_invoice;
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.unfreeze_group_work_order_split(v_strip_group, v_shaun);
    RAISE EXCEPTION 'group-wo: unfreeze ran over an acknowledged invoice';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_has_live_invoice' THEN
      RAISE EXCEPTION 'group-wo: acknowledged unfreeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_strip_group) IS NULL THEN
    RAISE EXCEPTION 'group-wo: a refused unfreeze cleared the strip marker';
  END IF;
  UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = v_strip_invoice;
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.unfreeze_group_work_order_split(v_strip_group, v_shaun);
    RAISE EXCEPTION 'group-wo: unfreeze ran over a submit in flight';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_has_live_invoice' THEN
      RAISE EXCEPTION 'group-wo: pending unfreeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_strip_group) IS NULL THEN
    RAISE EXCEPTION 'group-wo: a pending invoice unfroze the split';
  END IF;
  UPDATE public.trade_invoices SET status = 'queried' WHERE id = v_strip_invoice;
  SET LOCAL ROLE service_role;
  PERFORM public.unfreeze_group_work_order_split(v_strip_group, v_shaun);
  RESET ROLE;
  IF (SELECT status FROM public.trade_invoices WHERE id = v_strip_invoice) IS DISTINCT FROM 'queried'
     OR (SELECT count(*) FROM public.trade_invoice_lines
         WHERE trade_invoice_id = v_strip_invoice AND line_type = 'group share') <> 0
     OR (SELECT count(*) FROM public.trade_invoice_lines
         WHERE trade_invoice_id = v_strip_invoice AND line_type = 'travel') <> 1
     OR (SELECT subtotal_ex FROM public.trade_invoices WHERE id = v_strip_invoice) IS DISTINCT FROM 10
     OR (SELECT super_amount FROM public.trade_invoices WHERE id = v_strip_invoice) IS DISTINCT FROM 1.20
     OR (SELECT net_pay FROM public.trade_invoices WHERE id = v_strip_invoice) IS DISTINCT FROM 9.40
     OR (SELECT total_inc FROM public.trade_invoices WHERE id = v_strip_invoice) IS DISTINCT FROM 10
     OR (SELECT job_grand_total_ex FROM public.trade_invoices WHERE id = v_strip_invoice) IS NOT NULL
     OR (SELECT final_deductions_total_ex FROM public.trade_invoices WHERE id = v_strip_invoice) IS NOT NULL
     OR (SELECT to_be_paid_ex FROM public.trade_invoices WHERE id = v_strip_invoice) IS NOT NULL
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_strip_group) IS NOT NULL
  THEN
    RAISE EXCEPTION 'group-wo: unfreeze did not leave the travel line and the queried status';
  END IF;

  -- Hours were not edited, so the same sign-off still counts. A weekly
  -- invoice keeps its final-payout header and does not take the recurring
  -- deduction off gross.
  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_strip_group);
  RESET ROLE;
  SELECT share_ex INTO v_share FROM public.group_work_order_shares
  WHERE group_id = v_strip_group AND user_id = v_a;
  IF v_share IS DISTINCT FROM 321.43 THEN
    RAISE EXCEPTION 'group-wo: weekly re-freeze share was %', v_share;
  END IF;
  INSERT INTO public.trade_recurring_deductions (
    id, user_id, label, amount, first_week_start
  ) VALUES (
    v_deduction, v_a, 'Ute hire', 5, DATE '2026-10-19'
  );
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, invoice_source,
    week_start, week_end,
    subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay,
    job_grand_total_ex, final_deductions_total_ex, to_be_paid_ex,
    recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount
  ) VALUES (
    v_week_invoice, v_org, v_a, 'pending_acknowledgment', 'weekly_work_order',
    DATE '2026-10-19', DATE '2026-10-25',
    411.43, 0, 411.43,
    false, 0.12, 49.37, 411.43, 386.74,
    421.43, 10, 411.43,
    v_deduction, 'Ute hire', 5
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_week_invoice, v_strip_job, 'travel', 100);
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, line_type, line_total_ex
  ) VALUES (v_week_invoice, 'final_payout_deduction', -10);
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex
  ) VALUES (v_week_invoice, v_strip_job, 'group share', v_share);
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.unfreeze_group_work_order_split(v_strip_group, v_shaun);
    RAISE EXCEPTION 'group-wo: unfreeze ran over a weekly submit';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_split_has_live_invoice' THEN
      RAISE EXCEPTION 'group-wo: weekly pending unfreeze said %', SQLERRM;
    END IF;
  END;
  RESET ROLE;
  UPDATE public.trade_invoices SET status = 'queried' WHERE id = v_week_invoice;
  SET LOCAL ROLE service_role;
  PERFORM public.unfreeze_group_work_order_split(v_strip_group, v_shaun);
  RESET ROLE;
  IF (SELECT subtotal_ex FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 90
     OR (SELECT gross_earned FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 90
     OR (SELECT super_amount FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 10.80
     OR (SELECT net_pay FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 84.60
     OR (SELECT gst FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 0
     OR (SELECT total_inc FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 90
     OR (SELECT job_grand_total_ex FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 100
     OR (SELECT final_deductions_total_ex FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 10
     OR (SELECT to_be_paid_ex FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 90
     OR (SELECT recurring_deduction_amount FROM public.trade_invoices WHERE id = v_week_invoice) IS DISTINCT FROM 5
     OR (SELECT count(*) FROM public.trade_invoice_lines
         WHERE trade_invoice_id = v_week_invoice AND line_type = 'group share') <> 0
     OR (SELECT count(*) FROM public.trade_invoice_lines
         WHERE trade_invoice_id = v_week_invoice AND line_type = 'travel') <> 1
     OR (SELECT count(*) FROM public.trade_invoice_lines
         WHERE trade_invoice_id = v_week_invoice AND line_type = 'final_payout_deduction') <> 1
     OR (SELECT job_grand_total_ex FROM public.trade_invoices WHERE id = v_strip_invoice) IS NOT NULL
  THEN
    RAISE EXCEPTION 'group-wo: weekly unfreeze did not keep the deduction off gross';
  END IF;

  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_void_job, v_org, 'fencing', 'quoted', 'GWO-VOID');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_void_job, 'GWO-VOID-1', 'job', 'draft', 100, '[]', 'void stays'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-VOID-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_void_group, v_org, v_void_job, v_wo, 'token-void');
  SET LOCAL ROLE service_role;
  PERFORM public.void_group_work_order(v_void_group, v_shaun, 'permanent');
  RESET ROLE;
  BEGIN
    UPDATE public.group_work_orders SET status = 'open' WHERE id = v_void_group;
    RAISE EXCEPTION 'group-wo: a void group was reopened';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM IS DISTINCT FROM 'group_work_order_void' THEN
      RAISE EXCEPTION 'group-wo: unvoid said %', SQLERRM;
    END IF;
  END;
  UPDATE public.group_work_orders SET void_reason = 'still void' WHERE id = v_void_group;
  IF (SELECT status FROM public.group_work_orders WHERE id = v_void_group) IS DISTINCT FROM 'void'
     OR (SELECT void_reason FROM public.group_work_orders WHERE id = v_void_group) IS DISTINCT FROM 'still void'
  THEN
    RAISE EXCEPTION 'group-wo: void did not stay permanent';
  END IF;
  v_def := pg_get_functiondef('public.void_group_work_order(uuid,uuid,text)'::regprocedure);
  IF position('FOR UPDATE;' IN v_def) > 0
     AND position('FOR UPDATE;' IN v_def) < position('unfreeze_group_work_order_split' IN v_def)
  THEN
    RAISE EXCEPTION 'group-wo: void locks the row before unfreeze';
  END IF;
END $$;

-- Deleting hours or removing a participant invalidates a drawing. An
-- identical re-save does not. Unfreeze clears a deduction the reduced
-- payable cannot cover, and a busy weekly lock is named before a live
-- invoice.
DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-000000000001';
  v_shaun uuid := '9913309f-35ae-4a71-8e1f-f704ecc526ea';
  v_a uuid := 'a2140000-0000-4000-8000-00000000000a';
  v_b uuid := 'a2140000-0000-4000-8000-00000000000b';
  v_job uuid := 'd2140000-0000-4000-8000-000000000119';
  v_group uuid := 'd2140000-0000-4000-8000-000000000219';
  v_ded_job uuid := 'd2140000-0000-4000-8000-000000000120';
  v_ded_group uuid := 'd2140000-0000-4000-8000-000000000220';
  v_over uuid := 'd2140000-0000-4000-8000-000000000408';
  v_zero uuid := 'd2140000-0000-4000-8000-000000000409';
  v_fit uuid := 'd2140000-0000-4000-8000-000000000410';
  v_ded_over uuid := 'd2140000-0000-4000-8000-0000000000d2';
  v_ded_zero uuid := 'd2140000-0000-4000-8000-0000000000d3';
  v_ded_fit uuid := 'd2140000-0000-4000-8000-0000000000d4';
  v_wo uuid;
  v_share numeric;
  v_stamp timestamptz;
  v_updated timestamptz;
  v_note text;
  v_def text;
  v_counts boolean;
BEGIN
  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_job, v_org, 'fencing', 'quoted', 'GWO-STAMP');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_job, 'GWO-STAMP-1', 'job', 'draft', 100, '[]', 'hours stamp'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-STAMP-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_group, v_org, v_job, v_wo, 'token-stamp');
  INSERT INTO public.group_work_order_participants (group_id, user_id)
  VALUES (v_group, v_a);
  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status) VALUES
    ('d2140000-0000-4000-8000-0000000000a9', v_job, v_a, '2026-10-21', 'scheduled'),
    ('d2140000-0000-4000-8000-0000000000aa', v_job, v_b, '2026-10-21', 'scheduled');
  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_group, v_a, '2026-10-21', '08:00', '10:00', 0, 2.00);
  SELECT hours_changed_at INTO v_stamp FROM public.group_work_orders WHERE id = v_group;
  SELECT updated_at INTO v_updated
  FROM public.group_work_order_time_entries
  WHERE group_id = v_group AND user_id = v_a;
  IF v_stamp IS NULL OR v_updated IS NULL THEN
    RAISE EXCEPTION 'group-wo: inserting hours did not stamp the group';
  END IF;
  INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
  VALUES (
    'd2140000-0000-4000-8000-000000000504', v_job, 'signature', 'photo',
    'data:image/png;base64,iVBORw0KGgo='
  );
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor, created_at
  ) VALUES (
    v_job, 'share_link', 'Alex Client', true, 5,
    'd2140000-0000-4000-8000-000000000504', 'client link',
    v_stamp + interval '1 microsecond'
  );
  v_counts := public.group_client_signoff_counts(v_job);
  IF v_counts IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'group-wo: a drawing after the hour insert did not count';
  END IF;
  UPDATE public.group_work_order_time_entries
  SET work_date = '2026-10-21', start_time = '08:00', finish_time = '10:00',
      break_minutes = 0, hours = 2.00
  WHERE group_id = v_group AND user_id = v_a;
  IF (SELECT hours_changed_at FROM public.group_work_orders WHERE id = v_group) IS DISTINCT FROM v_stamp
     OR (SELECT updated_at FROM public.group_work_order_time_entries
         WHERE group_id = v_group AND user_id = v_a) IS DISTINCT FROM v_updated
     OR public.group_client_signoff_counts(v_job) IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'group-wo: an identical hour save moved the signature';
  END IF;
  PERFORM pg_sleep(0.05);
  UPDATE public.group_work_order_time_entries
  SET finish_time = '11:00', hours = 3.00
  WHERE group_id = v_group AND user_id = v_a;
  SELECT hours_changed_at INTO v_stamp FROM public.group_work_orders WHERE id = v_group;
  IF v_stamp IS NULL
     OR v_stamp <= (SELECT created_at FROM public.job_client_signoffs
                    WHERE job_id = v_job ORDER BY created_at DESC LIMIT 1)
     OR public.group_client_signoff_counts(v_job) IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'group-wo: a real hour change left the old drawing valid';
  END IF;
  DELETE FROM public.group_work_order_time_entries
  WHERE group_id = v_group AND user_id = v_a;
  IF (SELECT count(*) FROM public.group_work_order_time_entries WHERE group_id = v_group) <> 0
     OR public.group_client_signoff_counts(v_job) IS DISTINCT FROM false
     OR (SELECT hours_changed_at FROM public.group_work_orders WHERE id = v_group) <= v_stamp
  THEN
    RAISE EXCEPTION 'group-wo: deleting the last hour left the old drawing valid';
  END IF;
  SELECT hours_changed_at INTO v_stamp FROM public.group_work_orders WHERE id = v_group;
  INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
  VALUES (
    'd2140000-0000-4000-8000-000000000505', v_job, 'signature', 'photo',
    'data:image/png;base64,iVBORw0KGgo='
  );
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor, created_at
  ) VALUES (
    v_job, 'share_link', 'Alex Client', true, 5,
    'd2140000-0000-4000-8000-000000000505', 'client link',
    v_stamp + interval '1 microsecond'
  );
  IF public.group_client_signoff_counts(v_job) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'group-wo: a drawing after the hour delete did not count';
  END IF;
  INSERT INTO public.group_work_order_participants (group_id, user_id)
  VALUES (v_group, v_b);
  PERFORM pg_sleep(0.05);
  SET LOCAL ROLE service_role;
  PERFORM public.remove_group_work_order_participant(v_group, v_b, v_shaun);
  RESET ROLE;
  IF EXISTS (
       SELECT 1 FROM public.group_work_order_participants
       WHERE group_id = v_group AND user_id = v_b
     )
     OR public.group_client_signoff_counts(v_job) IS DISTINCT FROM false
     OR (SELECT hours_changed_at FROM public.group_work_orders WHERE id = v_group) <= v_stamp
  THEN
    RAISE EXCEPTION 'group-wo: removing a participant left the drawing valid';
  END IF;

  v_def := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
  IF position('group_split_busy: busy, try again' IN v_def) = 0
     OR position('group_split_has_live_invoice' IN v_def) = 0
     OR position('group_split_busy' IN v_def) > position('group_split_has_live_invoice' IN v_def)
  THEN
    RAISE EXCEPTION 'group-wo: a busy weekly lock is not named before a live invoice';
  END IF;

  INSERT INTO public.jobs (id, org_id, type, status, job_number)
  VALUES (v_ded_job, v_org, 'fencing', 'quoted', 'GWO-DED');
  INSERT INTO public.work_orders (
    org_id, job_id, wo_number, kind, status, agreed_labour_ex, scope_items, special_instructions
  ) VALUES (
    v_org, v_ded_job, 'GWO-DED-1', 'job', 'draft', 100, '[]', 'deduction refit'
  );
  SELECT id INTO v_wo FROM public.work_orders WHERE wo_number = 'GWO-DED-1';
  UPDATE public.work_orders SET status = 'approved', approved_by = v_shaun WHERE id = v_wo;
  INSERT INTO public.group_work_orders (id, org_id, job_id, work_order_id, share_token)
  VALUES (v_ded_group, v_org, v_ded_job, v_wo, 'token-ded');
  INSERT INTO public.group_work_order_participants (group_id, user_id)
  VALUES (v_ded_group, v_a);
  INSERT INTO public.job_assignments (id, job_id, user_id, scheduled_date, status)
  VALUES ('d2140000-0000-4000-8000-0000000000ab', v_ded_job, v_a, '2026-10-21', 'scheduled');
  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_ded_group, v_a, '2026-10-21', '08:00', '10:00', 0, 2.00);
  SELECT hours_changed_at INTO v_stamp FROM public.group_work_orders WHERE id = v_ded_group;
  INSERT INTO public.job_media (id, job_id, phase, type, storage_url)
  VALUES (
    'd2140000-0000-4000-8000-000000000506', v_ded_job, 'signature', 'photo',
    'data:image/png;base64,iVBORw0KGgo='
  );
  INSERT INTO public.job_client_signoffs (
    job_id, method, signed_name, happy, satisfaction_rating,
    signature_media_id, captured_by_actor, created_at
  ) VALUES (
    v_ded_job, 'share_link', 'Alex Client', true, 5,
    'd2140000-0000-4000-8000-000000000506', 'client link',
    v_stamp + interval '1 second'
  );
  INSERT INTO public.trade_recurring_deductions (id, user_id, label, amount, first_week_start)
  VALUES
    (v_ded_over, v_a, 'Ute hire', 50, DATE '2026-10-12'),
    (v_ded_zero, v_a, 'Ute hire', 50, DATE '2026-10-05'),
    (v_ded_fit, v_a, 'Ute hire', 5, DATE '2026-09-28');

  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_ded_group);
  RESET ROLE;
  SELECT share_ex INTO v_share FROM public.group_work_order_shares
  WHERE group_id = v_ded_group AND user_id = v_a;
  IF v_share IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'group-wo: sole share was %', v_share;
  END IF;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, invoice_source, week_start,
    subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay,
    recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount
  ) VALUES (
    v_over, v_org, v_a, 'queried', 'hourly', DATE '2026-10-12',
    110, 11, 121,
    true, 0.12, 13.20, 110, 103.40,
    v_ded_over, 'Ute hire', 50
  );
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_over, v_ded_job, 'travel', 10);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_over, v_ded_job, 'group share', v_share);
  SELECT hours_changed_at INTO v_stamp FROM public.group_work_orders WHERE id = v_ded_group;
  SET LOCAL ROLE service_role;
  PERFORM public.unfreeze_group_work_order_split(v_ded_group, v_shaun);
  RESET ROLE;
  v_note := 'Ute hire $50.00 NOT taken for the week starting 2026-10-12: the amount payable on this invoice ($10.40) is less than the deduction. Nothing was taken off. The office to recover it another way.';
  IF (SELECT net_pay FROM public.trade_invoices WHERE id = v_over) IS DISTINCT FROM 9.40
     OR (SELECT gst FROM public.trade_invoices WHERE id = v_over) IS DISTINCT FROM 1.00
     OR (SELECT total_inc FROM public.trade_invoices WHERE id = v_over) IS DISTINCT FROM 11
     OR (SELECT super_amount FROM public.trade_invoices WHERE id = v_over) IS DISTINCT FROM 1.20
     OR (SELECT recurring_deduction_id FROM public.trade_invoices WHERE id = v_over) IS NOT NULL
     OR (SELECT recurring_deduction_label FROM public.trade_invoices WHERE id = v_over) IS NOT NULL
     OR (SELECT recurring_deduction_amount FROM public.trade_invoices WHERE id = v_over) IS NOT NULL
     OR (SELECT recurring_deduction_note FROM public.trade_invoices WHERE id = v_over) IS DISTINCT FROM v_note
     OR (SELECT hours_changed_at FROM public.group_work_orders WHERE id = v_ded_group) IS DISTINCT FROM v_stamp
  THEN
    RAISE EXCEPTION 'group-wo: unfreeze left a deduction the payable cannot cover';
  END IF;

  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_ded_group);
  RESET ROLE;
  SELECT share_ex INTO v_share FROM public.group_work_order_shares
  WHERE group_id = v_ded_group AND user_id = v_a;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, invoice_source, week_start,
    subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay,
    recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount
  ) VALUES (
    v_zero, v_org, v_a, 'queried', 'hourly', DATE '2026-10-05',
    100, 10, 110,
    true, 0.12, 12.00, 100, 94.00,
    v_ded_zero, 'Ute hire', 50
  );
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_zero, v_ded_job, 'group share', v_share);
  SET LOCAL ROLE service_role;
  PERFORM public.unfreeze_group_work_order_split(v_ded_group, v_shaun);
  RESET ROLE;
  IF (SELECT net_pay FROM public.trade_invoices WHERE id = v_zero) IS DISTINCT FROM 0
     OR (SELECT gst FROM public.trade_invoices WHERE id = v_zero) IS DISTINCT FROM 0
     OR (SELECT total_inc FROM public.trade_invoices WHERE id = v_zero) IS DISTINCT FROM 0
     OR (SELECT subtotal_ex FROM public.trade_invoices WHERE id = v_zero) IS DISTINCT FROM 0
     OR (SELECT recurring_deduction_id FROM public.trade_invoices WHERE id = v_zero) IS NOT NULL
     OR (SELECT recurring_deduction_label FROM public.trade_invoices WHERE id = v_zero) IS NOT NULL
     OR (SELECT recurring_deduction_amount FROM public.trade_invoices WHERE id = v_zero) IS NOT NULL
     OR (SELECT recurring_deduction_note FROM public.trade_invoices WHERE id = v_zero) IS NOT NULL
  THEN
    RAISE EXCEPTION 'group-wo: a zero payable kept the deduction or its note';
  END IF;

  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_ded_group);
  RESET ROLE;
  SELECT share_ex INTO v_share FROM public.group_work_order_shares
  WHERE group_id = v_ded_group AND user_id = v_a;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, invoice_source, week_start,
    subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay,
    recurring_deduction_id, recurring_deduction_label, recurring_deduction_amount,
    recurring_deduction_note
  ) VALUES (
    v_fit, v_org, v_a, 'queried', 'hourly', DATE '2026-09-28',
    110, 11, 121,
    true, 0.12, 13.20, 110, 103.40,
    v_ded_fit, 'Ute hire', 5,
    'kept'
  );
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_fit, v_ded_job, 'travel', 10);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (v_fit, v_ded_job, 'group share', v_share);
  SET LOCAL ROLE service_role;
  PERFORM public.unfreeze_group_work_order_split(v_ded_group, v_shaun);
  RESET ROLE;
  IF (SELECT net_pay FROM public.trade_invoices WHERE id = v_fit) IS DISTINCT FROM 9.40
     OR (SELECT gst FROM public.trade_invoices WHERE id = v_fit) IS DISTINCT FROM 1.00
     OR (SELECT recurring_deduction_amount FROM public.trade_invoices WHERE id = v_fit) IS DISTINCT FROM 5
     OR (SELECT recurring_deduction_label FROM public.trade_invoices WHERE id = v_fit) IS DISTINCT FROM 'Ute hire'
     OR (SELECT recurring_deduction_note FROM public.trade_invoices WHERE id = v_fit) IS DISTINCT FROM 'kept'
     OR (SELECT recurring_deduction_id FROM public.trade_invoices WHERE id = v_fit) IS DISTINCT FROM v_ded_fit
  THEN
    RAISE EXCEPTION 'group-wo: unfreeze cleared a deduction the payable still covers';
  END IF;
END $$;

ROLLBACK;
