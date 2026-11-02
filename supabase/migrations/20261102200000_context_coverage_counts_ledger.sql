-- Context: the coverage counter counts the AI notes ledger the job card reads
-- (Road to done X, notes-counter fix), 2 Nov 2026.
--
-- context_coverage() counted a job as having current AI notes only from the
-- older note store (current_job_context_facts): 513 of 1,485 open jobs on
-- 2 Nov. The job card reads the reader's ledger (context_ledger_generations,
-- status live): counting either source, 633 of 1,485. The counter now counts
-- a job when either source has current notes for it, and adds a 'sources'
-- block (older_store, ledger_live) so both stay visible. Every existing key
-- keeps its name; with_current_fact and the dependent counts now include the
-- ledger. Read only.
-- Rollback: supabase/rollbacks/20261102200000_context_coverage_counts_ledger_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.context_coverage()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH older AS (SELECT DISTINCT job_id FROM public.current_job_context_facts),
 ledger AS (SELECT DISTINCT job_id FROM public.context_ledger_generations WHERE status = 'live' AND job_id IS NOT NULL),
 facts AS (SELECT job_id FROM older UNION SELECT job_id FROM ledger),
 evidence AS (SELECT DISTINCT job_id FROM public.business_events WHERE job_id IS NOT NULL),
 open_jobs AS (SELECT j.id FROM public.jobs j WHERE coalesce(j.status::text,'unknown') NOT IN ('cancelled','archived','lost','closed','complete','completed')),
 open_invoices AS (SELECT i.job_id FROM public.xero_invoices i WHERE upper(coalesce(i.status,''))='AUTHORISED' AND i.amount_due>0 AND upper(coalesce(i.invoice_type,'ACCREC'))='ACCREC')
 SELECT jsonb_build_object(
  'jobs',jsonb_build_object('total',(SELECT count(*) FROM open_jobs),'with_current_fact',(SELECT count(*) FROM open_jobs j JOIN facts f ON f.job_id=j.id),
   'no_current_fact',(SELECT count(*) FROM open_jobs j WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=j.id)),
   'evidence_without_current_fact',(SELECT count(*) FROM open_jobs j WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=j.id) AND EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=j.id)),
   'no_evidence_yet',(SELECT count(*) FROM open_jobs j WHERE NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=j.id) AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=j.id)),
   'sources',jsonb_build_object('older_store',(SELECT count(*) FROM open_jobs j JOIN older o ON o.job_id=j.id),'ledger_live',(SELECT count(*) FROM open_jobs j JOIN ledger l ON l.job_id=j.id))),
  'invoices',jsonb_build_object('total',(SELECT count(*) FROM open_invoices),'with_current_fact',(SELECT count(*) FROM open_invoices i JOIN facts f ON f.job_id=i.job_id),
   'no_current_fact',(SELECT count(*) FROM open_invoices i WHERE i.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=i.job_id)),
   'evidence_without_current_fact',(SELECT count(*) FROM open_invoices i WHERE i.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=i.job_id) AND EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=i.job_id)),
   'no_evidence_yet',(SELECT count(*) FROM open_invoices i WHERE i.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.job_id=i.job_id) AND NOT EXISTS(SELECT 1 FROM evidence e WHERE e.job_id=i.job_id)),
   'unlinked',(SELECT count(*) FROM open_invoices WHERE job_id IS NULL)))
$function$;
