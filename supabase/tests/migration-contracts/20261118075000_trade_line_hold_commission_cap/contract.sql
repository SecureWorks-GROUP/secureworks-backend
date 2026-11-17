-- P1-05.8 commission cap on a holding invoice (Follow-up 27 item 2).
-- Fixtures roll back; the database is left as found.
-- Merge-safety rule 17: re-apply first (a no-op at this body), so an
-- earlier contract in the shard cannot leave a different body behind.
\ir ../../../migrations/20261118075000_trade_line_hold_commission_cap.sql
BEGIN;
SET LOCAL statement_timeout = '60s';
INSERT INTO public.users (id, org_id, name, role)
VALUES ('00000000-0000-0000-0000-0000000c5001', '00000000-0000-0000-0000-000000000001', 'ZZTEST seller', 'estimator');
INSERT INTO public.jobs (id, org_id, status, type, job_number)
VALUES ('00000000-0000-0000-0000-0000000c5d01', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'ZZTEST-C5D01'),
       ('00000000-0000-0000-0000-0000000c5d02', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing', 'ZZTEST-C5D02');
INSERT INTO public.scope_revisions (id, job_id, revision_number, status, scope_canonical_text, pricing_canonical_text, scope_hash, pricing_hash)
VALUES ('00000000-0000-0000-0000-0000000c5e01', '00000000-0000-0000-0000-0000000c5d01', 1, 'frozen', '{}', '{}', repeat('a', 64), repeat('b', 64)),
       ('00000000-0000-0000-0000-0000000c5e02', '00000000-0000-0000-0000-0000000c5d02', 1, 'frozen', '{}', '{}', repeat('a', 64), repeat('b', 64));
-- c5d01: no commission figure (state no_amount). c5d02: named, 10.00.
INSERT INTO public.job_budgets (job_id, scope_revision_id, version, pricing_hash, trade, complete, gap_count,
  sell_ex_gst, gst, total_inc_gst, cost_before_commission_ex_gst, gross_profit_ex_gst,
  commission_rule_id, commission_pct, commission_ex_gst, profit_after_commission_ex_gst, salesperson_staff_id, budget)
VALUES
  ('00000000-0000-0000-0000-0000000c5d01', '00000000-0000-0000-0000-0000000c5e01', 1, repeat('b', 64), 'fence', true, 0,
   100, 10, 110, 50, 50, NULL, NULL, NULL, NULL, '00000000-0000-0000-0000-0000000c5001', '{"version":"budget.v1"}'),
  ('00000000-0000-0000-0000-0000000c5d02', '00000000-0000-0000-0000-0000000c5e02', 1, repeat('b', 64), 'fence', true, 0,
   100, 10, 110, 50, 50, 'fence_gross_profit_rate', 20, 10, 40, '00000000-0000-0000-0000-0000000c5001', '{"version":"budget.v1"}');
-- One holding invoice (zero header money, as the held money check requires)
-- and one payable invoice, both the salesperson's.
INSERT INTO public.trade_invoices (id, org_id, user_id, status, invoice_kind,
  subtotal_ex, gross_earned, gst, total_inc, gst_on, super_rate, super_amount, net_pay)
VALUES ('00000000-0000-0000-0000-0000000c5f01', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000c5001',
        'pending_ops_review', 'held', 0, 0, 0, 0, false, 0.12, 0, 0),
       ('00000000-0000-0000-0000-0000000c5f02', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000c5001',
        'pending_acknowledgment', 'standard', 0, 0, 0, 0, false, 0.12, 0, 0);

DO $$
DECLARE
  nofig uuid := '00000000-0000-0000-0000-0000000c5d01';
  named uuid := '00000000-0000-0000-0000-0000000c5d02';
  held uuid := '00000000-0000-0000-0000-0000000c5f01';
  payable uuid := '00000000-0000-0000-0000-0000000c5f02';
  line uuid;
  refused boolean;
BEGIN
  IF (SELECT state FROM public.job_commissions WHERE job_id = nofig) <> 'no_amount' THEN
    RAISE EXCEPTION 'cap contract: fixture is not a no-figure record';
  END IF;

  -- 1. A zero commission line on a holding invoice is saved.
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex,
    office_review_status, hold_reason, held_at)
  VALUES (held, nofig, 'commission', 0, 'awaiting', 'commission_no_figure', now())
  RETURNING id INTO line;

  -- 2. A non-zero commission line on a holding invoice runs the full check.
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex,
      office_review_status, hold_reason, held_at)
    VALUES (held, nofig, 'commission', 5, 'awaiting', 'commission_no_figure', now());
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_amount_unknown';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'cap contract: a non-zero commission line on a holding invoice was accepted'; END IF;

  -- 3. A standard invoice keeps main's rule: even a zero line is refused
  -- when the job has no figure.
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
    VALUES (payable, nofig, 'commission', 0);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_amount_unknown';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'cap contract: a standard invoice skipped the cap'; END IF;
  -- Within the figure on a standard invoice passes; over it is refused.
  INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
  VALUES (payable, named, 'commission', 10);
  refused := false;
  BEGIN
    INSERT INTO public.trade_invoice_lines (trade_invoice_id, job_id, line_type, line_total_ex)
    VALUES (payable, named, 'commission', 0.01);
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_over_amount';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'cap contract: commission over the figure was accepted'; END IF;

  -- 4. Releasing the held line onto a payable invoice fires the cap.
  refused := false;
  BEGIN UPDATE public.trade_invoice_lines SET trade_invoice_id = payable WHERE id = line;
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_amount_unknown';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'cap contract: moving a held line to a payable invoice skipped the cap'; END IF;
  -- Giving the held line an amount fires the cap.
  refused := false;
  BEGIN UPDATE public.trade_invoice_lines SET line_total_ex = 5 WHERE id = line;
  EXCEPTION WHEN OTHERS THEN refused := SQLERRM = 'commission_amount_unknown';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'cap contract: an amount on a held line skipped the cap'; END IF;

  -- 5. The zero held line claims nothing against the figure.
  IF public.job_commission_claimed_ex_gst(nofig) <> 0 THEN
    RAISE EXCEPTION 'cap contract: a zero held line was counted';
  END IF;
END $$;
ROLLBACK;
