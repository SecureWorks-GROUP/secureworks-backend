-- Follow-up 32: disabled source triggers return before JSON and subtransactions.
-- Depends on the source-refresh migration; installs nothing and changes no flag.
SET LOCAL lock_timeout = '5s';
DO $guard$ DECLARE expected record; actual text; BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('job_profit_job_materials_facts_trg','c68cfb847ac5e1977d49921c5f8bcbb3','9a0eebd657a33d900c034acff62a5b7a'),
  ('job_profit_trade_invoice_lines_trg','ad19960c16b70e7a01edf23e5548b992','8698ae83543b41978843cf733f4cdecf'),
  ('job_profit_trade_invoices_trg','99f06b1ed0c78912066eb0c0a1580886','d8e506d4243b2c737a913952e3b795a2'),
  ('job_profit_purchase_orders_trg','8649695fc23c0a0ee4a98db3241f3141','98cb290513c092d7df51ac721d929265'),
  ('job_profit_job_budgets_trg','37c81e2243c34c856affa3a69495d546','a5433aaa8ce0223bb087b764349720cf'),
  ('job_profit_xero_invoices_trg','32bc7d9b55ac7729060d07b789b9ff41','76d77bf43e9874e7e6ef358715ff69b4'),
  ('job_profit_xero_supplier_credit_note_allocations_trg','4efd07011f47e56e032e0dad5efd7c64','b75fd82bb3f2b3992e36a94924c1b5ca'),
  ('job_profit_jobs_trg','da5bf00325176da007b6808e2c066c24','86e1589c72699461aafe55440b38d0d9'),
  ('job_profit_work_orders_trg','ffc5e6da41eaf6a9004b5f9d2e1ee1bc','c74da79440da60d97ed43ac5dfbc55d3'),
  ('job_profit_group_work_order_shares_trg','4da9601c746b00df6d5359162c8f40d1','94dce45040045cd5446602cf158e55f5'),
  ('job_profit_group_work_orders_trg','6eb5f8387af4417b0718d8c9c3744181','d4038d01db1351ae7077a13d2b175b72')
 ) v(function_name,before_md5,after_md5) LOOP
  SELECT md5(prosrc) INTO actual FROM pg_proc
   WHERE oid=to_regprocedure('public.'||expected.function_name||'()');
  IF actual IS DISTINCT FROM expected.before_md5 AND actual IS DISTINCT FROM expected.after_md5 THEN
   RAISE EXCEPTION 'FU32 preimage changed: %',expected.function_name;
  END IF;
 END LOOP;
END $guard$;

CREATE OR REPLACE FUNCTION public.job_profit_job_materials_facts_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('job_materials_facts',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'materials_fact');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_trade_invoice_lines_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('trade_invoice_lines',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'crew_line');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_trade_invoices_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('trade_invoices',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'crew_invoice');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_purchase_orders_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('purchase_orders',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'order');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_job_budgets_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('job_budgets',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'budget');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_xero_invoices_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('xero_invoices',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'xero_invoice');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_xero_supplier_credit_note_allocations_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('xero_supplier_credit_note_allocations',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'credit');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_jobs_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 -- Do not to_jsonb a jobs row: that would detoast unrelated scope/media blobs.
 IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.org_id,OLD.job_number,OLD.client_name,OLD.type,OLD.status,OLD.metadata,OLD.expected_costs,OLD.pricing_json,OLD.completed_at,OLD.created_at,OLD.legacy) IS NOT DISTINCT FROM ROW(NEW.id,NEW.org_id,NEW.job_number,NEW.client_name,NEW.type,NEW.status,NEW.metadata,NEW.expected_costs,NEW.pricing_json,NEW.completed_at,NEW.created_at,NEW.legacy) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('jobs',
  CASE WHEN TG_OP<>'INSERT' THEN jsonb_build_object('id',OLD.id) END,
  CASE WHEN TG_OP<>'DELETE' THEN jsonb_build_object('id',NEW.id) END,'job');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_work_orders_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('work_orders',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'work_order');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_group_work_order_shares_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('group_work_order_shares',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'group_share');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_group_work_orders_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- feature_flags_pkey: return before row JSON or the helper exception block.
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('group_work_orders',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'group_work_order');
 RETURN NULL;
END $fn$;
