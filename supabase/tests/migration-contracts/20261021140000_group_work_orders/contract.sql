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

ROLLBACK;
