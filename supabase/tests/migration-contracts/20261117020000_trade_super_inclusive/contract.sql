-- One super rule (P1-01): every amount includes super. The fund gets 12/112
-- of the total less reimbursements and the person the rest. An invoice priced
-- before keeps its own rule. Synthetic records only; every fixture write is
-- rolled back.
BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  zz uuid := 'f1170000-0000-4000-8000-00000000000a';
  job uuid := 'f1170000-0000-4000-8000-000000000101';
  inv uuid;
  got record;
  refused boolean;
  v_header jsonb;
  v_lines jsonb;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES (zz,org,'ZZTEST Crew','crew') ON CONFLICT(id) DO NOTHING;

  -- 0. The switch ships off and the start date is not set.
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'trade_super_inclusive_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the super inclusive switch must ship off';
  END IF;
  IF (SELECT starts_on FROM public.trade_super_inclusive_settings WHERE id = 1) IS NOT NULL THEN
    RAISE EXCEPTION 'the start date must ship unset';
  END IF;

  -- 1. The worked example: total 1,120. Super 120 (12/112), paid 1,000.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES(org,zz,'pending_acknowledgment',1120,1120,0,1120,false,0.12,120,1000,'super_inclusive_v1','ZZTEST-INC-1') RETURNING id INTO inv;
  -- With GST on: GST stays 10% of the whole total.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES(org,zz,'pending_acknowledgment',1120,1120,112,1232,true,0.12,120,1000,'super_inclusive_v1','ZZTEST-INC-2');
  -- A reimbursement carries no super: 1,120 work + 200 materials. Base 1,120,
  -- super 120, paid 1,200.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,super_base_ex,invoice_number)
    VALUES(org,zz,'pending_acknowledgment',1320,1320,0,1320,false,0.12,120,1200,'super_inclusive_v1',1120,'ZZTEST-INC-3');
  -- Half a cent rounds up, as ops-api rounds it: 1,000.02 * 12 / 112 = 107.145.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES(org,zz,'pending_acknowledgment',1000.02,1000.02,0,1000.02,false,0.12,107.15,892.87,'super_inclusive_v1','ZZTEST-INC-4');

  -- 2. An invoice priced before (12/6 split, no basis) is still valid.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,invoice_number)
    VALUES(org,zz,'pending_acknowledgment',1000,1000,0,1000,false,0.12,120,940,'ZZTEST-OLD-1');
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,invoice_number)
    VALUES(org,zz,'pending_acknowledgment',1000,1000,0,1000,false,0.12,120,1000,'employer_12_v2','ZZTEST-OLD-2');

  -- 3. Refused: 12% of the total on the inclusive rule; net pay equal to the
  --    total; the other half-cent rounding; super on a reimbursement; the 12/6
  --    split stamped inclusive; an unknown basis.
  FOR got IN SELECT * FROM (VALUES
      (1120::numeric, 134.40::numeric, 985.60::numeric, NULL::numeric, 'super_inclusive_v1'::text, '12% of the total'),
      (1120, 120, 1120, NULL, 'super_inclusive_v1', 'nothing withheld'),
      (1000.02, 107.14, 892.88, NULL, 'super_inclusive_v1', 'half a cent rounded down'),
      (1320, 141.43, 1178.57, NULL, 'super_inclusive_v1', 'super on a reimbursement with a base stored'),
      (1000, 120, 940, NULL, 'super_inclusive_v1', 'the 12/6 split stamped inclusive'),
      (1120, 120, 1000, NULL, 'super_inclusive_v2', 'an unknown basis')
    ) AS t(gross, sup, net, base, basis, why)
  LOOP
    refused := false;
    BEGIN
      INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,super_base_ex,invoice_number)
        VALUES(org,zz,'pending_acknowledgment',got.gross,got.gross,0,got.gross,false,0.12,got.sup,got.net,got.basis,
          CASE WHEN got.why LIKE '%base stored%' THEN 1120 ELSE got.base END,'ZZTEST-BAD');
    EXCEPTION WHEN check_violation THEN refused := true; END;
    IF NOT refused THEN RAISE EXCEPTION 'stored: %', got.why; END IF;
  END LOOP;

  -- 4. The weekly persist carries the basis and the base onto the row.
  INSERT INTO public.jobs(id,org_id,type,status,job_number) VALUES(job,org,'repair','scheduled','ZZTEST-INC-JOB');
  v_header := jsonb_build_object(
    'org_id', org, 'user_id', zz, 'week_start', '2026-11-16', 'week_end', '2026-11-22',
    'total_hours', 0, 'total_breaks_minutes', 0,
    'subtotal_ex', 1320, 'gst', 0, 'total_inc', 1320, 'gst_on', false,
    'super_rate', 0.12, 'super_amount', 120, 'gross_earned', 1320, 'net_pay', 1200,
    'super_basis', 'super_inclusive_v1', 'super_base_ex', 1120,
    'invoice_source', 'hourly', 'status', 'draft');
  v_lines := jsonb_build_array(
    jsonb_build_object('job_id', job, 'job_number', 'ZZTEST-INC-JOB', 'line_type', 'labour',
      'description', 'ZZTEST labour', 'quantity', 1, 'unit', 'ea', 'unit_rate', 1120,
      'total_hours', 0, 'line_total_ex', 1120, 'line_position', 0),
    jsonb_build_object('job_id', job, 'job_number', 'ZZTEST-INC-JOB', 'line_type', 'materials',
      'description', 'ZZTEST materials', 'quantity', 1, 'unit', 'ea', 'unit_rate', 200,
      'total_hours', 0, 'line_total_ex', 200, 'line_position', 1));
  inv := public.persist_weekly_trade_invoice_v1(v_header, v_lines, NULL);
  SELECT super_basis, super_base_ex, super_amount, net_pay INTO got FROM public.trade_invoices WHERE id = inv;
  IF got.super_basis IS DISTINCT FROM 'super_inclusive_v1' OR got.super_base_ex <> 1120 OR got.super_amount <> 120 OR got.net_pay <> 1200 THEN
    RAISE EXCEPTION 'the weekly persist dropped the super rule: %', got;
  END IF;
  -- A payload with no basis inserts exactly as before.
  v_header := v_header - 'super_basis' - 'super_base_ex'
    || jsonb_build_object('week_start', '2026-11-09', 'week_end', '2026-11-15',
      'subtotal_ex', 1120, 'total_inc', 1120, 'gross_earned', 1120, 'super_amount', 134.40, 'net_pay', 1052.80);
  inv := public.persist_weekly_trade_invoice_v1(v_header, jsonb_build_array(v_lines->0), NULL);
  SELECT super_basis, super_base_ex INTO got FROM public.trade_invoices WHERE id = inv;
  IF got.super_basis IS NOT NULL OR got.super_base_ex IS NOT NULL THEN
    RAISE EXCEPTION 'a payload with no basis stamped one: %', got;
  END IF;
END $$;
ROLLBACK;

-- 5. Safe to apply twice: each patch is in its body exactly once.
DO $$
DECLARE
  v_def text;
BEGIN
  v_def := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'p_invoice->>''super_basis''', ''))) / length('p_invoice->>''super_basis''') <> 1 THEN
    RAISE EXCEPTION 'weekly persist does not carry the basis exactly once';
  END IF;
  v_def := pg_get_functiondef('public.persist_trade_work_order_invoice_v1(jsonb,jsonb,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'p_invoice->>''super_basis''', ''))) / length('p_invoice->>''super_basis''') <> 1 THEN
    RAISE EXCEPTION 'work order persist does not carry the basis exactly once';
  END IF;
  v_def := pg_get_functiondef('public.unfreeze_group_work_order_split(uuid,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'group_split_super_inclusive_invoice', ''))) / length('group_split_super_inclusive_invoice') <> 1 THEN
    RAISE EXCEPTION 'unfreeze does not refuse a super inclusive invoice exactly once';
  END IF;
END $$;

-- 6. The start date is not readable or writable by browser roles.
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.trade_super_inclusive_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_super_inclusive_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.trade_super_inclusive_settings', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.trade_super_inclusive_settings', 'SELECT') THEN
    RAISE EXCEPTION 'trade_super_inclusive_settings privileges are wrong';
  END IF;
END $$;
