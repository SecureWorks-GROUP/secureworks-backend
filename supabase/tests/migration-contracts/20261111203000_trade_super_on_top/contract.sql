-- An office super-on-top setting lets one trade's own invoice be stored in
-- full with ordinary lines. Without a setting nothing changes: the guard, the
-- split check and the weekly persist behave as before. Synthetic records
-- only; every fixture write is rolled back.
DO $$
BEGIN
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trade_super_bases'::regclass),
    'row level security is on';
  ASSERT NOT has_table_privilege('anon', 'public.trade_super_bases', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.trade_super_bases', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.trade_super_bases', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.trade_super_bases', 'UPDATE'),
    'a signed-in trade cannot read or write the setting';
  ASSERT has_table_privilege('service_role', 'public.trade_super_bases', 'INSERT'),
    'the service role writes the setting';
  ASSERT strpos(pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure), '(20261111203000)') > 0,
    'line guard patched';
  ASSERT strpos(pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)'::regprocedure), '(20261111203000)') > 0,
    'weekly persist patched';
END $$;

BEGIN;
DO $$
DECLARE
  org uuid := '00000000-0000-0000-0000-000000000001';
  ann uuid := 'f1110000-0000-4000-8000-00000000000a';
  bob uuid := 'f1110000-0000-4000-8000-00000000000b';
  ann_setting uuid;
  bob_setting uuid;
  inv uuid;
  line uuid;
  stored record;
  refused boolean;
BEGIN
  INSERT INTO public.users(id,org_id,name,role) VALUES
    (ann,org,'Ann Synthetic','crew'),(bob,org,'Bob Synthetic','crew') ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.trade_super_bases(org_id,user_id,super_basis,effective_from,created_by)
    VALUES(org,ann,'employer_12_v2','2026-11-02','user:synthetic-office') RETURNING id INTO ann_setting;
  INSERT INTO public.trade_super_bases(org_id,user_id,super_basis,effective_from,created_by)
    VALUES(org,bob,'employer_12_v2','2026-11-02','user:synthetic-office') RETURNING id INTO bob_setting;

  -- 1. One open setting per trade; only the one basis.
  refused := false;
  BEGIN
    INSERT INTO public.trade_super_bases(org_id,user_id,super_basis,effective_from,created_by)
      VALUES(org,ann,'employer_12_v2','2026-11-09','user:synthetic-office');
  EXCEPTION WHEN unique_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'a second open setting was accepted'; END IF;
  refused := false;
  BEGIN
    INSERT INTO public.trade_super_bases(org_id,user_id,super_basis,effective_from,effective_to,created_by)
      VALUES(org,ann,'something_else','2026-01-05','2026-01-11','user:synthetic-office');
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'an unknown basis was accepted'; END IF;

  -- 2. An invoice priced by the setting carries ordinary lines.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,super_basis_setting_id)
    VALUES(org,ann,'draft',400,400,0,400,false,0.12,48,400,'employer_12_v2',ann_setting) RETURNING id INTO inv;
  INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,total_hours,hourly_rate,line_total_ex)
    VALUES(inv,'labour',8,50,400) RETURNING id INTO line;
  UPDATE public.trade_invoice_lines SET description = 'Synthetic day' WHERE id = line;

  -- 3. An employer-super invoice with no setting still refuses them.
  INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis)
    VALUES(org,ann,'draft',400,400,0,400,false,0.12,48,400,'employer_12_v2') RETURNING id INTO inv;
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoice_lines(trade_invoice_id,line_type,total_hours,hourly_rate,line_total_ex)
      VALUES(inv,'labour',8,50,400);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_super_basis_mismatch';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'ordinary line accepted on an employer-super invoice with no office setting'; END IF;

  -- 4. The setting id needs the employer basis and the invoice's own trade.
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis_setting_id)
      VALUES(org,ann,'draft',400,400,0,400,false,0.12,48,376,ann_setting);
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'setting id accepted on the ordinary split'; END IF;
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoices(org_id,user_id,status,subtotal_ex,gross_earned,gst,total_inc,gst_on,super_rate,super_amount,net_pay,super_basis,super_basis_setting_id)
      VALUES(org,ann,'draft',400,400,0,400,false,0.12,48,400,'employer_12_v2',bob_setting);
  EXCEPTION WHEN foreign_key_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'another trade''s setting accepted'; END IF;

  -- 5. The weekly persist stores the basis only together with a setting.
  inv := public.persist_weekly_trade_invoice_v3(
    jsonb_build_object('org_id',org,'user_id',bob,'week_start','2026-11-02','week_end','2026-11-08',
      'status','draft','invoice_source','hourly','subtotal_ex',400,'gross_earned',400,'net_pay',400,
      'total_inc',400,'gst',0,'gst_on',false,'super_rate',0.12,'super_amount',48,
      'super_basis','employer_12_v2','super_basis_setting_id',bob_setting),
    jsonb_build_array(jsonb_build_object('line_type','labour','total_hours',8,'hourly_rate',50,'line_total_ex',400)),
    NULL);
  SELECT super_basis, super_basis_setting_id, net_pay, gross_earned INTO stored FROM public.trade_invoices WHERE id = inv;
  IF stored.super_basis IS DISTINCT FROM 'employer_12_v2' OR stored.super_basis_setting_id IS DISTINCT FROM bob_setting
     OR stored.net_pay <> stored.gross_earned THEN
    RAISE EXCEPTION 'weekly persist did not store the office basis: %', stored;
  END IF;
  IF (SELECT count(*) FROM public.trade_invoice_lines WHERE trade_invoice_id = inv) <> 1 THEN
    RAISE EXCEPTION 'weekly persist did not store the line';
  END IF;
  -- Replacing the draft on the ordinary split stores neither column.
  inv := public.persist_weekly_trade_invoice_v3(
    jsonb_build_object('org_id',org,'user_id',bob,'week_start','2026-11-02','week_end','2026-11-08',
      'status','draft','invoice_source','hourly','subtotal_ex',400,'gross_earned',400,'net_pay',376,
      'total_inc',400,'gst',0,'gst_on',false,'super_rate',0.12,'super_amount',48),
    jsonb_build_array(jsonb_build_object('line_type','labour','total_hours',8,'hourly_rate',50,'line_total_ex',400)),
    inv);
  SELECT super_basis, super_basis_setting_id, net_pay, gross_earned INTO stored FROM public.trade_invoices WHERE id = inv;
  IF stored.super_basis IS NOT NULL OR stored.super_basis_setting_id IS NOT NULL OR stored.net_pay <> 376 THEN
    RAISE EXCEPTION 'ordinary weekly persist changed: %', stored;
  END IF;
  -- A basis with no setting keeps its ordinary lines out, so nothing is saved.
  refused := false;
  BEGIN
    PERFORM public.persist_weekly_trade_invoice_v3(
      jsonb_build_object('org_id',org,'user_id',bob,'week_start','2026-11-02','week_end','2026-11-08',
        'status','draft','invoice_source','hourly','subtotal_ex',400,'gross_earned',400,'net_pay',400,
        'total_inc',400,'gst',0,'gst_on',false,'super_rate',0.12,'super_amount',48,
        'super_basis','employer_12_v2'),
      jsonb_build_array(jsonb_build_object('line_type','labour','total_hours',8,'hourly_rate',50,'line_total_ex',400)),
      inv);
  EXCEPTION WHEN check_violation THEN refused := SQLERRM = 'group_super_basis_mismatch';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'weekly persist stored super on top with no office setting'; END IF;
END $$;
ROLLBACK;
