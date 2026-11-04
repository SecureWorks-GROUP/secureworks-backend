-- (Job Profit, 3 Nov 2026, variable checks) An AI materials fact no longer counts on a job when Bookkeeping's
-- ledger evidences that bill on another job and not on this one.
-- Found by verify/scripts/variables_check.py (context-system, 3 Nov 03:3xZ, expected values from Bookkeeping's
-- ledger and Xero): bill 26023 (James Waters, 520.00) counted on SWP-26595 by an agent_ai fact while the ledger
-- evidences it on SWP-261203; bill 26020 (436.36) counted on SWP-26941 while the ledger evidences it on SWP-26701.
-- The fact path already stood aside when a bill line was placed on the same job (bill_line); it never asked the
-- ledger. R57: Bookkeeping's evidence places bills; an AI-only link never outranks it.
-- Both sides change: the AI fact stands aside, and the bill (which stood aside for that fact) is placed by the
-- ledger's evidence on the ledger's job, so the cost moves to the right job instead of disappearing.
-- Only AI-made facts (not manual_queue or manual_split, which a person made) are outranked.
-- Bills the ledger has no row for keep their fact (left Provisional, as before); those are Bookkeeping's to place.
-- Guard: v_job_cost_events must be the definition this was written against (md5 c02f50d6...).
-- Rollback: supabase/rollbacks/20261103050000_job_cost_ledger_beats_ai_fact_down.sql (exact earlier definition).

DO $mig$
DECLARE
  v_def text;
  v_old1 text := 'WHERE b.xero_invoice_id = f.xero_invoice_id AND b.job_id = f.job_id))';
  v_new1 text := 'WHERE b.xero_invoice_id = f.xero_invoice_id AND b.job_id = f.job_id)) AND NOT (COALESCE(f.automation_source, ''''::text) <> ALL (ARRAY[''manual_queue''::text, ''manual_split''::text]) AND (EXISTS ( SELECT 1 FROM v_bookkeeping_line_evidence_current e WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) AND NOT (EXISTS ( SELECT 1 FROM v_bookkeeping_line_evidence_current e2 WHERE e2.xero_invoice_id = f.xero_invoice_id AND e2.evidenced AND e2.job_id = f.job_id)))';
  v_old2 text := 'WHERE f.xero_invoice_id = x.xero_invoice_id AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = ''manual_split''::text)))';
  v_new2 text := 'WHERE f.xero_invoice_id = x.xero_invoice_id AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = ''manual_split''::text) AND NOT (COALESCE(f.automation_source, ''''::text) <> ALL (ARRAY[''manual_queue''::text, ''manual_split''::text]) AND (EXISTS ( SELECT 1 FROM v_bookkeeping_line_evidence_current e WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) AND NOT (EXISTS ( SELECT 1 FROM v_bookkeeping_line_evidence_current e2 WHERE e2.xero_invoice_id = f.xero_invoice_id AND e2.evidenced AND e2.job_id = f.job_id)))))';
BEGIN
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) = 'a3ab8d8be6e4ff755736cbe53a7d131f' THEN
    RAISE NOTICE 'v_job_cost_events already lets the ledger outrank an AI fact';
    RETURN;
  END IF;
  IF md5(v_def) <> 'c02f50d66a1aeb82195f1df8b0c4ed06' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     OR (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: a fact guard is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> 'a3ab8d8be6e4ff755736cbe53a7d131f' THEN
    RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$mig$;
