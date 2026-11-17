BEGIN;
\ir ../20261117171901_group_inclusive_pay_basis/fixture.sql
DO $$
DECLARE grp uuid; before_hash text; after_hash text; approval uuid; refused boolean;
BEGIN
  grp := pg_temp.zztest_group_fixture();
  DELETE FROM public.group_work_order_time_entries WHERE group_id=grp AND user_id='f1171901-0000-4000-8000-000000000004';
  IF public.group_claim_split_hash(grp) IS NOT NULL THEN RAISE EXCEPTION 'ZZTEST hash exists before all hours'; END IF;
  INSERT INTO public.group_work_order_time_entries(group_id,user_id,work_date,start_time,finish_time,break_minutes,hours)
    VALUES(grp,'f1171901-0000-4000-8000-000000000004','2026-11-16','00:00','22:00',0,22);
  before_hash := public.group_claim_split_hash(grp);
  IF before_hash IS NULL OR before_hash IS DISTINCT FROM public.group_claim_split_hash(grp) THEN
    RAISE EXCEPTION 'ZZTEST complete split hash missing or unstable';
  END IF;
  UPDATE public.group_work_order_time_entries SET hours=hours+.25 WHERE group_id=grp AND user_id='f1171901-0000-4000-8000-000000000004';
  after_hash := public.group_claim_split_hash(grp);
  IF after_hash IS NULL OR after_hash IS NOT DISTINCT FROM before_hash THEN RAISE EXCEPTION 'ZZTEST changed hours kept approval hash'; END IF;
  DELETE FROM public.trade_rates WHERE user_id='f1171901-0000-4000-8000-000000000004';
  IF public.group_claim_split_hash(grp) IS NOT NULL THEN RAISE EXCEPTION 'ZZTEST hash exists without a day rate'; END IF;
  refused := false;
  BEGIN
    INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision)
      VALUES(grp,'f1171901-0000-4000-8000-000000000002',before_hash,'dispute');
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST dispute accepted without a reason'; END IF;
  INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision)
    VALUES(grp,'f1171901-0000-4000-8000-000000000002',before_hash,'approve') RETURNING id INTO approval;
  refused := false;
  BEGIN
    INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision)
      VALUES(grp,'f1171901-0000-4000-8000-000000000002',before_hash,'approve');
  EXCEPTION WHEN unique_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST duplicate approval accepted'; END IF;
  refused := false;
  BEGIN UPDATE public.group_work_order_approvals SET via='office' WHERE id=approval;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST approval update accepted'; END IF;
  refused := false;
  BEGIN DELETE FROM public.group_work_order_approvals WHERE id=approval;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'ZZTEST approval delete accepted'; END IF;
END $$;
SELECT 'PASS: P1-13.3 split hash and append-only approvals' AS result;
ROLLBACK;
