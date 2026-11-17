BEGIN;
\ir ../20261117171901_group_inclusive_pay_basis/fixture.sql
DO $$
DECLARE
  grp uuid;
  crew uuid := 'f1171901-0000-4000-8000-000000000004';
  original_hash text;
  approval uuid;
  refused boolean;
BEGIN
  grp := pg_temp.zztest_group_fixture();
  DELETE FROM public.group_work_order_time_entries WHERE group_id = grp AND user_id = crew;
  IF public.group_claim_split_hash(grp) IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST hash exists before every crew member has hours';
  END IF;
  INSERT INTO public.group_work_order_time_entries
    (group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
    VALUES(grp,crew,'2026-11-16','00:00','22:00',0,22);
  original_hash := public.group_claim_split_hash(grp);
  IF original_hash IS DISTINCT FROM md5(
      '224000|f1171901-0000-4000-8000-000000000002|1000|67200'
      '|f1171901-0000-4000-8000-000000000003|1000|33600'
      '|f1171901-0000-4000-8000-000000000004|2200|123200')
     OR public.group_claim_split_hash(grp) IS DISTINCT FROM original_hash THEN
    RAISE EXCEPTION 'ZZTEST hash differs from exact projected split or repeated call';
  END IF;
  UPDATE public.group_work_order_time_entries
    SET hours = hours + 0.25, finish_time = '22:15'
    WHERE group_id = grp AND user_id = crew;
  IF public.group_claim_split_hash(grp) IS NULL
     OR public.group_claim_split_hash(grp) = original_hash THEN
    RAISE EXCEPTION 'ZZTEST changed hours retained the approved hash';
  END IF;
  DELETE FROM public.trade_rates WHERE user_id = crew;
  IF public.group_claim_split_hash(grp) IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST missing day rate retained a hash';
  END IF;
  IF EXISTS (SELECT 1 FROM public.group_work_order_shares WHERE group_id = grp)
     OR (SELECT split_frozen_at FROM public.group_work_orders WHERE id = grp) IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST hash wrote a share or froze the split';
  END IF;

  refused := false;
  BEGIN
    INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision)
      VALUES(grp,crew,original_hash,'dispute');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST dispute accepted no reason'; END IF;
  INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision,reason)
    VALUES(grp,crew,original_hash,'dispute','ZZTEST disputed split');
  INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision)
    VALUES(grp,crew,original_hash,'approve') RETURNING id INTO approval;
  refused := false;
  BEGIN
    INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision)
      VALUES(grp,crew,original_hash,'approve');
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST duplicate approval accepted'; END IF;
  refused := false;
  BEGIN
    UPDATE public.group_work_order_approvals SET reason = 'ZZTEST edited' WHERE id = approval;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST approval update accepted'; END IF;
  refused := false;
  BEGIN
    DELETE FROM public.group_work_order_approvals WHERE id = approval;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST approval delete accepted'; END IF;

  UPDATE public.group_work_orders
    SET claim_state = 'waiting_approval', claim_started_by = crew,
        claim_deadline_at = '2026-11-18T00:00:00Z' WHERE id = grp;
  UPDATE public.group_work_order_participants
    SET named_by = crew, named_at = '2026-11-16T00:00:00Z' WHERE group_id = grp AND user_id = crew;
  UPDATE public.group_work_order_time_entries SET suggested = '{"source":"ZZTEST clock"}',
    changed_from_suggestion = true WHERE group_id = grp AND user_id = crew;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_orders WHERE id = grp
      AND claim_state = 'waiting_approval' AND claim_started_by = crew AND claim_deadline_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.group_work_order_participants WHERE group_id = grp
      AND user_id = crew AND named_by = crew AND named_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.group_work_order_time_entries WHERE group_id = grp
      AND user_id = crew AND suggested->>'source' = 'ZZTEST clock' AND changed_from_suggestion) THEN
    RAISE EXCEPTION 'ZZTEST claim evidence did not read back';
  END IF;
  INSERT INTO public.group_work_order_events(group_id,job_id,action,actor_user_id)
    SELECT grp,g.job_id,a,crew FROM public.group_work_orders g
      CROSS JOIN unnest(ARRAY['name_crew','leave_claim','confirm_hours','approve_split',
        'dispute_split','escalate','issue_invoices','office_settle','restore_participant']) a
      WHERE g.id = grp;
  IF (SELECT count(*) FROM public.feature_flags
      WHERE flag_name IN ('group_claim_flow_v1','group_claim_all_jobs_v1') AND NOT enabled) <> 2
     OR has_table_privilege('authenticated','public.group_work_order_approvals','SELECT')
     OR has_table_privilege('anon','public.group_work_order_approvals','INSERT')
     OR has_table_privilege('service_role','public.group_work_order_approvals','UPDATE')
     OR has_table_privilege('service_role','public.group_work_order_approvals','DELETE')
     OR NOT has_table_privilege('service_role','public.group_work_order_approvals','SELECT')
     OR NOT has_table_privilege('service_role','public.group_work_order_approvals','INSERT')
     OR has_function_privilege('authenticated','public.group_claim_split_hash(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.group_claim_split_hash(uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.group_claim_split_hash(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'ZZTEST group claim activation or access differs';
  END IF;
END $$;
SELECT 'PASS: P1-13.3 exact split identity, claim evidence and append-only approvals' AS result;
ROLLBACK;
