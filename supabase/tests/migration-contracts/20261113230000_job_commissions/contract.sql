-- Contract for 20261113230000_job_commissions.sql. Every fixture write is
-- inside a transaction that rolls back.

-- 1. Privileges. The rate: staff read, nobody but the service role writes, the
-- writer is service-role only, the two owner rates are seeded and no editor is
-- named yet. The commission record, its read and the cap: service only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commission_rates', 'commission_rate_settings', 'job_commissions'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'commission contract: row-level security is off on %', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('anon', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'commission contract: a browser role can write or anon can read %', t;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.job_commissions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.commission_rate_settings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_job_commission', 'SELECT')
     OR has_table_privilege('anon', 'public.v_job_commission', 'SELECT')
     OR has_table_privilege('anon', 'public.v_commission_rates', 'SELECT') THEN
    RAISE EXCEPTION 'commission contract: a browser role can read a commission record or the editor list';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.v_commission_rates', 'SELECT') THEN
    RAISE EXCEPTION 'commission contract: staff cannot read the rate';
  END IF;
  IF has_function_privilege('anon', 'public.set_commission_rate(text, numeric, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_commission_rate(text, numeric, text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.set_commission_rate(text, numeric, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assert_job_commission_cap(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.job_commission_claimed_ex_gst(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'commission contract: the rate writer or the cap is callable by a browser role';
  END IF;
  IF (SELECT array_agg(trade || ':' || rule_id || ':' || percent ORDER BY trade) FROM public.v_commission_rates)
     IS DISTINCT FROM ARRAY['fence:fence_gross_profit_rate:15.00', 'patio:patio_gross_profit_rate:8.00'] THEN
    RAISE EXCEPTION 'commission contract: the seeded rates are not fence 15 and patio 8';
  END IF;
  IF (SELECT cardinality(editor_user_ids) FROM public.commission_rate_settings WHERE id = 1) <> 0 THEN
    RAISE EXCEPTION 'commission contract: an editor is named by the migration';
  END IF;
END $$;

-- 2. The rate: only a named editor changes it, as a new row keeping the rule;
-- a rate row is never edited; staff read it, a trade does not.
BEGIN;
INSERT INTO public.users (id, org_id, name, role)
VALUES ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-000000000001', 'ZZTEST owner', 'owner'),
       ('00000000-0000-0000-0000-00000000c0a2', '00000000-0000-0000-0000-000000000001', 'ZZTEST trade', 'lead_installer');
DO $$
DECLARE
  owner uuid := '00000000-0000-0000-0000-00000000c0a1';
  refused boolean;
  r jsonb;
BEGIN
  refused := false;
  BEGIN PERFORM public.set_commission_rate('patio', 9, 'test', owner);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_rate_editor_only'; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: a rate changed with no editor named'; END IF;

  UPDATE public.commission_rate_settings SET editor_user_ids = ARRAY[owner] WHERE id = 1;
  r := public.set_commission_rate('patio', 9, 'test', owner);
  IF (r->>'previous_percent')::numeric <> 8 OR (SELECT percent FROM public.v_commission_rates WHERE trade = 'patio') <> 9
     OR (SELECT rule_id FROM public.v_commission_rates WHERE trade = 'patio') <> 'patio_gross_profit_rate'
     OR (SELECT count(*) FROM public.commission_rates WHERE trade = 'patio') <> 2 THEN
    RAISE EXCEPTION 'commission contract: an editor''s rate change was not a new row keeping the rule: %', r;
  END IF;
  refused := false;
  BEGIN PERFORM public.set_commission_rate('patio', 8.155, 'test', owner);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_rate_percent_invalid'; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: a third decimal on a rate was accepted'; END IF;
  refused := false;
  BEGIN PERFORM public.set_commission_rate('fence', 16, 'test', '00000000-0000-0000-0000-00000000c0a2');
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_rate_editor_only'; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: someone not on the editor list changed a rate'; END IF;
  refused := false;
  BEGIN UPDATE public.commission_rates SET percent = 50 WHERE trade = 'fence';
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: a rate row was edited'; END IF;
END $$;
-- Staff see the rate under their own sign-in; a trade sees nothing.
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT SELECT ON public.users TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-00000000c0a1';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.v_commission_rates) <> 2 THEN
    RAISE EXCEPTION 'commission contract: staff cannot read the rates under their own sign-in';
  END IF;
END $$;
RESET ROLE;
SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-00000000c0a2';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.v_commission_rates) <> 0 THEN
    RAISE EXCEPTION 'commission contract: a trade can read the commission rate';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;

-- 3. The record is copied from each stored budget, and the cap holds every
-- write: only the named salesperson, only up to the amount.
BEGIN;
INSERT INTO public.users (id, org_id, name, role)
VALUES ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-000000000001', 'ZZTEST seller', 'estimator'),
       ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-000000000001', 'ZZTEST trade', 'lead_installer'),
       ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-000000000002', 'ZZTEST elsewhere', 'estimator');
INSERT INTO public.jobs (id, org_id, status, type, job_number)
SELECT ('00000000-0000-0000-0000-00000000d00' || n)::uuid, '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'ZZTEST-D00' || n
  FROM generate_series(1, 6) n;
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
SELECT ('00000000-0000-0000-0000-00000000e00' || n)::uuid, ('00000000-0000-0000-0000-00000000d00' || n)::uuid,
       1, 'frozen', '{}', '{}', repeat('a', 64), repeat('b', 64)
  FROM generate_series(1, 5) n;
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
VALUES ('00000000-0000-0000-0000-00000000e007', '00000000-0000-0000-0000-00000000d001', 2, 'frozen', '{}', '{}', repeat('a', 64), repeat('b', 64));
-- d001: named, 15% of 3485 = 522.75. d002: a salesperson of another company.
-- d003: nobody named. d004: a loss (0). d005: no commission figure.
INSERT INTO public.job_budgets (job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count,
  sell_ex_gst, gst, total_inc_gst, cost_before_commission_ex_gst, gross_profit_ex_gst,
  commission_rule_id, commission_pct, commission_ex_gst, profit_after_commission_ex_gst, salesperson_staff_id, budget)
VALUES
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e001', 1, repeat('b', 64), 'fence', true, 0,
   10000, 1000, 11000, 6515, 3485, 'fence_gross_profit_rate', 15, 522.75, 2962.25, '00000000-0000-0000-0000-00000000c001', '{"version":"budget.v1"}'),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000e002', 1, repeat('b', 64), 'fence', true, 0,
   10000, 1000, 11000, 6515, 3485, 'fence_gross_profit_rate', 15, 522.75, 2962.25, '00000000-0000-0000-0000-00000000c003', '{"version":"budget.v1"}'),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-00000000e003', 1, repeat('b', 64), 'fence', true, 0,
   10000, 1000, 11000, 6515, 3485, 'fence_gross_profit_rate', 15, 522.75, 2962.25, NULL, '{"version":"budget.v1"}'),
  ('00000000-0000-0000-0000-00000000d004', '00000000-0000-0000-0000-00000000e004', 1, repeat('b', 64), 'fence', true, 0,
   10000, 1000, 11000, 10100, -100, 'fence_gross_profit_rate', 15, 0, -100, '00000000-0000-0000-0000-00000000c001', '{"version":"budget.v1"}'),
  ('00000000-0000-0000-0000-00000000d005', '00000000-0000-0000-0000-00000000e005', 1, repeat('b', 64), 'fence', true, 0,
   10000, 1000, 11000, 6515, 3485, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-00000000c001', '{"version":"budget.v1"}');
INSERT INTO public.trade_invoices (id, user_id, status)
VALUES ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000c001', 'pending_acknowledgment'),
       ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000c001', 'pending_acknowledgment'),
       ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000c001', 'draft'),
       ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000c002', 'pending_acknowledgment');
DO $$
DECLARE
  seller uuid := '00000000-0000-0000-0000-00000000c001';
  j1 uuid := '00000000-0000-0000-0000-00000000d001';
  i1 uuid := '00000000-0000-0000-0000-00000000f001';
  i2 uuid := '00000000-0000-0000-0000-00000000f002';
  draft uuid := '00000000-0000-0000-0000-00000000f003';
  other uuid := '00000000-0000-0000-0000-00000000f004';
  refused boolean;
  v record;
  code text;
BEGIN
  -- The record of each budget.
  IF (SELECT array_agg(right(job_id::text, 4) || ':' || state || ':' || COALESCE(expected_amount_ex_gst::text, '-')
                       ORDER BY job_id) FROM public.job_commissions)
     IS DISTINCT FROM ARRAY['d001:named:522.75', 'd002:salesperson_not_found:-', 'd003:no_salesperson:-',
                            'd004:named:0.00', 'd005:no_amount:-'] THEN
    RAISE EXCEPTION 'commission contract: the records do not match their budgets: %',
      (SELECT array_agg(job_id || ':' || state) FROM public.job_commissions);
  END IF;
  IF (SELECT sealed_salesperson_id FROM public.job_commissions WHERE job_id = '00000000-0000-0000-0000-00000000d002')
       IS DISTINCT FROM '00000000-0000-0000-0000-00000000c003'::uuid
     OR (SELECT salesperson_user_id FROM public.job_commissions WHERE job_id = '00000000-0000-0000-0000-00000000d002') IS NOT NULL THEN
    RAISE EXCEPTION 'commission contract: a salesperson of another company was named';
  END IF;

  -- The salesperson, up to the amount, to the cent.
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES (i1, j1, 'Commission', 500);
  refused := false;
  BEGIN INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES (i2, j1, 'commission', 22.76);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_over_amount'; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: commission over the amount was accepted'; END IF;

  -- A draft does not hold the amount; it is checked when it is submitted.
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES (draft, j1, 'commission', 10);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES (i2, j1, 'commission', 22.75);
  SELECT * INTO v FROM public.v_job_commission WHERE job_id = j1;
  IF v.claimed_ex_gst <> 522.75 OR v.remaining_ex_gst <> 0 THEN
    RAISE EXCEPTION 'commission contract: the read does not show what counts (% / %)', v.claimed_ex_gst, v.remaining_ex_gst;
  END IF;
  refused := false;
  BEGIN UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = draft;
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_over_amount'; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: a draft over the amount was submitted'; END IF;

  -- A line the office refused frees its amount.
  UPDATE public.trade_invoice_lines SET office_review_status = 'rejected' WHERE trade_invoice_id = i2;
  UPDATE public.trade_invoices SET status = 'pending_acknowledgment' WHERE id = draft;

  -- Anyone else is refused, on a line or by taking the invoice over.
  refused := false;
  BEGIN INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES (other, j1, 'commission', 1);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_not_salesperson'; END;
  IF NOT refused THEN
    RAISE EXCEPTION 'commission contract: a commission line was accepted from someone other than the salesperson';
  END IF;
  refused := false;
  BEGIN UPDATE public.trade_invoices SET user_id = '00000000-0000-0000-0000-00000000c002' WHERE id = i1;
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_not_salesperson'; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: an invoice carrying commission changed hands'; END IF;

  -- Other lines, and jobs with no record, keep today's rules.
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex) VALUES (other, j1, 'labour', 100);
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (other, '00000000-0000-0000-0000-00000000d006', 'commission', 999);

  -- No person, another company's person, a loss, no figure.
  FOREACH code IN ARRAY ARRAY['d002:commission_not_salesperson', 'd003:commission_not_salesperson',
                              'd004:commission_over_amount', 'd005:commission_amount_unknown'] LOOP
    refused := false;
    BEGIN
      INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
      VALUES (i1, ('00000000-0000-0000-0000-00000000' || split_part(code, ':', 1))::uuid, 'commission', 0.01);
    EXCEPTION WHEN OTHERS THEN refused := SQLERRM = split_part(code, ':', 2);
    END;
    IF NOT refused THEN RAISE EXCEPTION 'commission contract: % was not refused as expected', code; END IF;
  END LOOP;

  -- Write-once, and a later budget is the job's current record.
  refused := false;
  BEGIN UPDATE public.job_commissions SET expected_amount_ex_gst = 9999 WHERE job_id = j1;
  EXCEPTION WHEN check_violation THEN refused := true; END;
  IF NOT refused THEN RAISE EXCEPTION 'commission contract: a commission record was changed'; END IF;
  INSERT INTO public.job_budgets (job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count,
    sell_ex_gst, gst, total_inc_gst, cost_before_commission_ex_gst, gross_profit_ex_gst,
    commission_rule_id, commission_pct, commission_ex_gst, profit_after_commission_ex_gst, salesperson_staff_id, budget)
  VALUES (j1, '00000000-0000-0000-0000-00000000e007', 2, repeat('b', 64), 'fence', true, 0,
    12000, 1200, 13200, 6515, 5485, 'fence_gross_profit_rate', 15, 822.75, 4662.25, seller, '{"version":"budget.v1"}');
  SELECT * INTO v FROM public.v_job_commission WHERE job_id = j1;
  IF v.version <> 2 OR v.expected_amount_ex_gst <> 822.75 OR (SELECT count(*) FROM public.v_job_commission WHERE job_id = j1) <> 1 THEN
    RAISE EXCEPTION 'commission contract: the read does not show the current record';
  END IF;
END $$;
ROLLBACK;
