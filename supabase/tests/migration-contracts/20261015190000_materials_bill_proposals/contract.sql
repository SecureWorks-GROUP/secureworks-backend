-- Contract for 20261015190000_materials_bill_proposals.sql. Every fixture write is
-- inside a transaction that rolls back.

-- 1. The proposals store is service role only: row security on, the browser roles
--    hold nothing, the service role holds its policy.
DO $$
BEGIN
  IF to_regclass('public.materials_bill_proposals') IS NULL THEN
    RAISE EXCEPTION 'contract: materials_bill_proposals is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.materials_bill_proposals'::regclass) THEN
    RAISE EXCEPTION 'contract: materials_bill_proposals requires row-level security';
  END IF;
  IF has_table_privilege('anon', 'public.materials_bill_proposals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.materials_bill_proposals', 'SELECT') THEN
    RAISE EXCEPTION 'contract: a browser role can read materials_bill_proposals';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'materials_bill_proposals' AND policyname = 'service_role_all') THEN
    RAISE EXCEPTION 'contract: the service role policy is missing';
  END IF;
END $$;

-- 2. One live proposal per bill, history kept; the shapes the agent may write.
BEGIN;
DO $$
DECLARE
  v_job uuid := gen_random_uuid(); -- facts carry the id only; no job row is needed
  v_q uuid;
  v_refused boolean;
BEGIN
  INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, sub_total)
    VALUES ('bill-1', '10093385', 736.63) RETURNING id INTO v_q;

  INSERT INTO public.materials_bill_proposals
    (xero_invoice_id, queue_id, proposal_kind, proposed_job_id, proposed_job_number, confidence, rule, reason, input_hash, outcome)
    VALUES ('bill-1', v_q, 'job', NULL, 'SWF-261009', 'medium', 'invoice_email', 'r', 'h1', 'queued_for_review');

  v_refused := false;
  BEGIN
    INSERT INTO public.materials_bill_proposals (xero_invoice_id, proposal_kind, confidence, rule, reason, input_hash, outcome)
      VALUES ('bill-1', 'not_job_related', 'medium', 'overhead_account', 'r', 'h2', 'queued_for_review');
  EXCEPTION WHEN unique_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'contract: a second live proposal for one bill was accepted'; END IF;

  UPDATE public.materials_bill_proposals SET outcome = 'superseded' WHERE xero_invoice_id = 'bill-1';
  INSERT INTO public.materials_bill_proposals (xero_invoice_id, proposal_kind, confidence, rule, reason, input_hash, outcome)
    VALUES ('bill-1', 'review', 'low', 'split_bill', 'r', 'h3', 'queued_for_review');
  IF (SELECT count(*) FROM public.materials_bill_proposals WHERE xero_invoice_id = 'bill-1') <> 2 THEN
    RAISE EXCEPTION 'contract: superseded history was not kept beside the live proposal';
  END IF;

  -- A job proposal must name its job; a review never does.
  v_refused := false;
  BEGIN
    INSERT INTO public.materials_bill_proposals (xero_invoice_id, proposal_kind, confidence, rule, reason, input_hash, outcome)
      VALUES ('bill-2', 'job', 'medium', 'x', 'r', 'h', 'queued_for_review');
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'contract: a job proposal with no job was accepted'; END IF;

  -- Only a high job proposal the agent placed may read assigned.
  v_refused := false;
  BEGIN
    INSERT INTO public.materials_bill_proposals
      (xero_invoice_id, proposal_kind, proposed_job_number, confidence, rule, reason, input_hash, outcome, auto_assigned_at)
      VALUES ('bill-3', 'job', 'SWF-261009', 'medium', 'invoice_email', 'r', 'h', 'assigned', now());
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'contract: a medium proposal was accepted as assigned'; END IF;
  INSERT INTO public.materials_bill_proposals
    (xero_invoice_id, proposal_kind, proposed_job_number, confidence, rule, reason, input_hash, outcome, auto_assigned_at)
    VALUES ('bill-4', 'job', 'SWF-261009', 'high', 'job_number', 'r', 'h', 'assigned', now());

  -- 3. The agent's fact source, and nothing else new.
  INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, amount_ex_gst, confidence, automation_source)
    VALUES ('bill-4', v_job, 1, 'high', 'agent_prematch');
  v_refused := false;
  BEGIN
    INSERT INTO public.job_materials_facts (xero_invoice_id, job_id, amount_ex_gst, confidence, automation_source)
      VALUES ('bill-5', v_job, 1, 'high', 'guess');
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'contract: an unknown fact source was accepted'; END IF;

  -- 4. A bill voided in Xero leaves the list with its reason.
  UPDATE public.materials_reconciliation_queue SET status = 'void_in_xero', closed_reason = 'xero_bill_voided' WHERE id = v_q;
  v_refused := false;
  BEGIN
    UPDATE public.materials_reconciliation_queue SET status = 'gone' WHERE id = v_q;
  EXCEPTION WHEN check_violation THEN v_refused := true;
  END;
  IF NOT v_refused THEN RAISE EXCEPTION 'contract: an unknown queue status was accepted'; END IF;
END $$;
ROLLBACK;
