-- (Job Profit, finish-line row A3, 3 Nov 2026) A credit applied to a customer invoice reduces that invoice's own
-- division (Xero Business Unit), when the invoice has one.
--
-- Found by verify/scripts/a3_division_months.py (3 Nov 14:18Z read): v_job_revenue_events held business_unit NULL
-- on credit_applied rows, so a division total took the job's division. Jody Saxon's CN-1365 (-509.00 ex GST,
-- 27 Aug 2026, tracked SW - PATIOS in Xero) applied to INV-1075 on SW1346, a job number our job-number rule does
-- not map: Job Profit read it as no division, so SW - PATIOS August revenue was 509.00 above Xero and
-- "(no division)" August 509.00 below (cause customer_credit, gross 1,018.32 with CN-1548's 0.16).
-- Change, in v_job_revenue_events only (no amount, job, date or row changes; business_unit only): a credit_applied
-- row carries job_cost_document_business_unit(x.line_items), the Business Unit every invoice line with an amount
-- carries; NULL (job's division, as before) when the lines carry none or more than one.
--
-- Guard: v_job_revenue_events must be the definition this was written against (md5 aeb851cd8d3d6e807cd7a5d620e020a8,
-- pg_get_viewdef(..., true)); after the change it must be 2191799f0f51ef34b5fe90879e8387cb. The registered migration-contract stack does not
-- hold 20261103200000, so its view is that migration's starting definition (md5 ac208427bcf489ec12086cc08e3b9289,
-- after 18c6f924719d2c53ca537e8d58d7555f); that pair is pinned too. Needs 20261104090000 (its function).
-- Re-running it is a no-op.
-- Rollback: supabase/rollbacks/20261104091000_job_revenue_credit_division_down.sql (embeds the exact earlier definition).
-- Rehearsed 3 Nov 2026 on production after 20261104090000, in the same rolled-back transaction (CIO helper, Claude;
-- read 14:44Z): 4 credit rows take a division (CN-1365 on INV-1075 -509.00 SW - PATIOS; 0.16, 20.17, 230.22 on
-- fence and patio invoices), no amount, job or date change; total job cost 778,402.17 and invoiced 2,105,963.68
-- before and after. A3: 21 of 60 to 22 of 60 (SW - PATIOS August revenue now equals Xero).

SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  v_def text;
  v_after text;
  o1 text := $o1$    'Credit applied in Xero'::text AS description,
    NULL::text AS account_code,
    NULL::text AS business_unit,
$o1$;
  n1 text := $n1$    'Credit applied in Xero'::text AS description,
    NULL::text AS account_code,
    job_cost_document_business_unit(x.line_items) AS business_unit,
$n1$;
BEGIN
  IF to_regprocedure('public.job_cost_document_business_unit(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'job_cost_document_business_unit(jsonb) is missing: apply 20261104090000 first';
  END IF;
  v_def := pg_get_viewdef('public.v_job_revenue_events'::regclass, true);
  IF md5(v_def) IN ('2191799f0f51ef34b5fe90879e8387cb', '18c6f924719d2c53ca537e8d58d7555f') THEN
    RAISE NOTICE 'v_job_revenue_events already has 20261104091000';
    RETURN;
  END IF;
  v_after := CASE md5(v_def) WHEN 'aeb851cd8d3d6e807cd7a5d620e020a8' THEN '2191799f0f51ef34b5fe90879e8387cb' WHEN 'ac208427bcf489ec12086cc08e3b9289' THEN '18c6f924719d2c53ca537e8d58d7555f' END;
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'v_job_revenue_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, o1, ''))) / length(o1) <> 1 THEN
    RAISE EXCEPTION 'v_job_revenue_events: change 1 of 1 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o1, n1);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_revenue_events AS ' || v_def;
  IF md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true)) <> v_after THEN
    RAISE EXCEPTION 'v_job_revenue_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_revenue_events'::regclass, true));
  END IF;
END
$mig$;
