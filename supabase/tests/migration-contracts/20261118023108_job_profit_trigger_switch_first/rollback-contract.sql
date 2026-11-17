DO $check$ DECLARE expected record; BEGIN
 FOR expected IN SELECT * FROM (VALUES
 ('job_profit_job_materials_facts_trg','c68cfb847ac5e1977d49921c5f8bcbb3'),
 ('job_profit_trade_invoice_lines_trg','ad19960c16b70e7a01edf23e5548b992'),
 ('job_profit_trade_invoices_trg','99f06b1ed0c78912066eb0c0a1580886'),
 ('job_profit_purchase_orders_trg','8649695fc23c0a0ee4a98db3241f3141'),
 ('job_profit_job_budgets_trg','37c81e2243c34c856affa3a69495d546'),
 ('job_profit_xero_invoices_trg','32bc7d9b55ac7729060d07b789b9ff41'),
 ('job_profit_xero_supplier_credit_note_allocations_trg','4efd07011f47e56e032e0dad5efd7c64'),
 ('job_profit_jobs_trg','da5bf00325176da007b6808e2c066c24'),
 ('job_profit_work_orders_trg','ffc5e6da41eaf6a9004b5f9d2e1ee1bc'),
 ('job_profit_group_work_order_shares_trg','4da9601c746b00df6d5359162c8f40d1'),
 ('job_profit_group_work_orders_trg','6eb5f8387af4417b0718d8c9c3744181')
 ) v(fn,body_md5) LOOP
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.'||expected.fn||'()')) IS DISTINCT FROM expected.body_md5 THEN
   RAISE EXCEPTION 'FU32 rollback did not restore %',expected.fn;
  END IF;
 END LOOP;
END $check$;
SELECT 'PASS: FU32 rollback restores all eleven parent wrappers' AS result;
