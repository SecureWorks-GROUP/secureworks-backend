-- After 20261104080000's down: v_job_profit is production's 20261103171500 definition again, without the column, with
-- its grants; job_profit(uuid) is its own definition with its grants; the new function is gone.
DO $$
BEGIN
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '44c5f76f8fe56c656faee0fc1286a89b' THEN
    RAISE EXCEPTION 'rollback: v_job_profit is not the earlier definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND attname = 'expected_cost_missing' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'rollback: v_job_profit still has expected_cost_missing';
  END IF;
  IF to_regprocedure('public.job_profit_expected_cost_missing(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: job_profit_expected_cost_missing(uuid) is still there';
  END IF;
  IF COALESCE((SELECT relacl::text FROM pg_class WHERE oid = 'public.v_job_profit'::regclass), '')
     <> (SELECT definition FROM public.contract_jp_preimage WHERE object = 'v_job_profit_acl') THEN
    RAISE EXCEPTION 'rollback: v_job_profit grants are %, not %', (SELECT relacl::text FROM pg_class WHERE oid = 'public.v_job_profit'::regclass),
      (SELECT definition FROM public.contract_jp_preimage WHERE object = 'v_job_profit_acl');
  END IF;
  IF md5(pg_get_functiondef('public.job_profit(uuid)'::regprocedure)) <> (SELECT definition FROM public.contract_jp_preimage WHERE object = 'job_profit_def_md5')
     OR COALESCE((SELECT proacl::text FROM pg_proc WHERE oid = 'public.job_profit(uuid)'::regprocedure), '')
        <> (SELECT definition FROM public.contract_jp_preimage WHERE object = 'job_profit_acl') THEN
    RAISE EXCEPTION 'rollback: job_profit(uuid) is not its earlier definition and grants';
  END IF;
  PERFORM 1 FROM public.v_job_profit LIMIT 1;
  PERFORM 1 FROM public.job_profit('00000000-0000-0000-0000-000000000000');
END $$;
