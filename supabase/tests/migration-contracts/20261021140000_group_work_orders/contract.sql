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
  VALUES (v_group, 'client', 'Alex Client', 'share_link');

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
  v_a_share numeric;
  v_b_share numeric;
  v_draft uuid := 'a2140000-0000-4000-8000-000000000401';
  v_live uuid := 'a2140000-0000-4000-8000-000000000402';
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
     OR has_function_privilege('authenticated', 'public.unfreeze_group_work_order_split(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.group_work_order_write_split(uuid, boolean)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'group-wo: a trade must not execute the split functions';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.freeze_group_work_order_split(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.project_group_work_order_split(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.unfreeze_group_work_order_split(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.trade_invoice_lines_group_share_snapshot()', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'group-wo: service_role must execute the freeze and the line snapshot';
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
    IF SQLERRM IS DISTINCT FROM 'group_split_not_frozen' THEN
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
  INSERT INTO public.group_work_order_time_entries
    (group_id, user_id, work_date, start_time, finish_time, break_minutes, hours)
  VALUES
    (v_freeze, v_a, '2026-10-21', '08:00', '10:00', 0, 2.00),
    (v_freeze, v_b, '2026-10-21', '08:00', '10:00', 0, 2.00);

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

  UPDATE public.group_work_order_time_entries
  SET hours = 7.50
  WHERE group_id = v_freeze AND user_id = v_a;
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

  SET LOCAL ROLE service_role;
  PERFORM public.unfreeze_group_work_order_split(v_freeze);
  RESET ROLE;
  IF (SELECT split_frozen_at FROM public.group_work_orders WHERE id = v_freeze) IS NOT NULL THEN
    RAISE EXCEPTION 'group-wo: unfreeze left the marker set';
  END IF;
  SELECT share_ex INTO v_a_share FROM public.group_work_order_shares
  WHERE group_id = v_freeze AND user_id = v_a;
  SELECT share_ex INTO v_b_share FROM public.group_work_order_shares
  WHERE group_id = v_freeze AND user_id = v_b;
  IF v_a_share IS DISTINCT FROM 425.43 OR v_b_share IS DISTINCT FROM 56.72
     OR (SELECT round(sum(share_ex), 2) FROM public.group_work_order_shares WHERE group_id = v_freeze) IS DISTINCT FROM 482.15
  THEN
    RAISE EXCEPTION 'group-wo: unfreeze recomputed % and %', v_a_share, v_b_share;
  END IF;

  SET LOCAL ROLE service_role;
  PERFORM public.freeze_group_work_order_split(v_freeze);
  RESET ROLE;
  INSERT INTO public.trade_invoices (
    id, org_id, user_id, status, subtotal_ex, gst, total_inc,
    gst_on, super_rate, super_amount, gross_earned, net_pay
  ) VALUES (
    v_live, v_org, v_b, 'pending_acknowledgment',
    400, 0, 400, false, 0.12, 48, 400, 376
  );
  INSERT INTO public.trade_invoice_lines (
    trade_invoice_id, job_id, line_type, line_total_ex, group_share_id
  ) VALUES (v_live, v_pot_job, 'group share', 56.72, (
    SELECT id FROM public.group_work_order_shares
    WHERE group_id = v_freeze AND user_id = v_b
  ));
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM public.unfreeze_group_work_order_split(v_freeze);
    RAISE EXCEPTION 'group-wo: unfreeze ran over a live invoice';
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

ROLLBACK;
