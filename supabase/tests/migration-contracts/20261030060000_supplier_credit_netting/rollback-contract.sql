-- After the down: the engine, the placement view and the tie-out are the
-- bodies the migration replaced; the side rule and the per-row part are gone;
-- the credit note copy (slice 1's) is kept.
DO $$
BEGIN
  IF to_regclass('public.v_supplier_credit_allocations') IS NOT NULL
     OR to_regprocedure('public.job_cost_credit_note_part(numeric,numeric,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'supplier credit netting rollback: the side rule or the per-row part survived';
  END IF;
  IF obj_description('public.v_job_cost_events'::regclass, 'pg_class')
       NOT LIKE 'Job profit engine (20261009130000, CFO-12 20261019120000, CFO-18/20 20261020181800): %'
     OR pg_get_viewdef('public.v_job_cost_events'::regclass) LIKE '%xero_credit_note%'
     OR pg_get_viewdef('public.v_job_cost_events'::regclass) NOT LIKE '%agent_ai%' THEN
    RAISE EXCEPTION 'supplier credit netting rollback: v_job_cost_events is not 20261028173000''s body';
  END IF;
  IF obj_description('public.v_supplier_credit_placement'::regclass, 'pg_class') NOT LIKE 'Supplier credit notes (20261030010000, TP-07 slice 1): %'
     OR (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.v_supplier_credit_placement'::regclass AND attnum > 0 AND NOT attisdropped) <> 20
     OR COALESCE((SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_supplier_credit_placement'::regclass), '') NOT LIKE '%security_invoker=true%' THEN
    RAISE EXCEPTION 'supplier credit netting rollback: the placement view is not 20261030010000''s';
  END IF;
  IF obj_description('public.xero_tieout_monthly(date,integer,uuid)'::regprocedure, 'pg_proc') NOT LIKE 'TP-01 Xero tie-out (20261029121500): %'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.xero_tieout_monthly(date,integer,uuid)'::regprocedure) LIKE '%v_supplier_credit_placement%'
     OR public.xero_tieout_monthly('2032-03-15', 1, NULL) -> 'months' -> 0 -> 'credit_notes' ->> 'status' <> 'not_yet_read' THEN
    RAISE EXCEPTION 'supplier credit netting rollback: the tie-out is not 20261029121500''s';
  END IF;
  IF to_regclass('public.xero_supplier_credit_notes') IS NULL OR to_regclass('public.xero_supplier_credit_note_allocations') IS NULL THEN
    RAISE EXCEPTION 'supplier credit netting rollback: took the credit note copy, which is slice 1''s';
  END IF;
  IF has_table_privilege('authenticated', 'public.v_supplier_credit_placement', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_supplier_credit_placement', 'SELECT')
     OR has_function_privilege('authenticated', 'public.xero_tieout_monthly(date,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.xero_tieout_monthly(date,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'supplier credit netting rollback: grants were not put back';
  END IF;
END $$;
-- A second down is a no-op.
\ir ../../../rollbacks/20261030060000_supplier_credit_netting_down.sql
-- And the migration applies again on the rolled-back stack.
BEGIN;
\ir ../../../migrations/20261030060000_supplier_credit_netting.sql
DO $$
BEGIN
  IF to_regclass('public.v_supplier_credit_allocations') IS NULL
     OR pg_get_viewdef('public.v_job_cost_events'::regclass) NOT LIKE '%xero_credit_note%' THEN
    RAISE EXCEPTION 'supplier credit netting rollback: the migration does not re-apply after its down';
  END IF;
END $$;
ROLLBACK;
