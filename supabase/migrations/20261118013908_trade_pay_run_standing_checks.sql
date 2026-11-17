-- P1-08.3. An uncalled read only; no switch, trigger, schedule or money write.
-- Follow-up 27(5): whole cents billed > whole cents allowed stops the invoice.
-- Job Profit publishes document_id as text. No existing invoice index serves
-- that expression; this keeps its legacy trade branch bounded by document ids.
CREATE INDEX IF NOT EXISTS trade_pay_standing_document_idx ON public.trade_invoices ((id::text));
CREATE OR REPLACE FUNCTION public.trade_pay_run_standing_checks(
 p_org_id uuid, p_invoice_ids uuid[], p_stage text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp
AS $fn$
DECLARE
 v_ids uuid[];
 v_work_orders uuid[];
 v_changes jsonb := '{}'::jsonb;
 v_result jsonb;
/* block */ BEGIN
 IF p_stage IS NULL OR p_stage NOT IN ('before_xero','after_xero') THEN
  RAISE EXCEPTION 'standing_stage_invalid';
 END IF;
 SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_ids
 FROM unnest(p_invoice_ids) x;
 -- Exact ids use trade_invoices_pkey, never a week-wide invoice scan.
 IF EXISTS(SELECT 1 FROM public.trade_invoices i
   WHERE i.id=ANY(v_ids) AND i.org_id=p_org_id AND i.invoice_kind='held') THEN
  RAISE EXCEPTION 'standing_holding_invoice_given';
 END IF;
 IF cardinality(v_ids) <> (SELECT count(*) FROM public.trade_invoices i
   WHERE i.id=ANY(v_ids) AND i.org_id=p_org_id AND i.invoice_kind IN ('standard','follow_on'))
   OR array_position(v_ids,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'standing_invoice_not_found';
 END IF;
 -- idx_inv_lines_invoice and idx_wo_job restrict this to the selected jobs.
 SELECT coalesce(array_agg(DISTINCT w.id),'{}'::uuid[]) INTO v_work_orders
 FROM public.trade_invoice_lines l JOIN public.work_orders w ON w.job_id=l.job_id
 WHERE l.trade_invoice_id=ANY(v_ids) AND w.org_id=p_org_id
  AND w.kind='job' AND w.status IN ('draft','approved');
 IF to_regprocedure('public.work_order_amount_change_total(uuid)') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_object_agg(x::text,public.work_order_amount_change_total(x)),''{}''::jsonb) FROM unnest($1) x'
   INTO v_changes USING v_work_orders;
 END IF;

 WITH inv AS MATERIALIZED (
  SELECT i.id,i.invoice_number,i.user_id,i.week_start,i.super_basis,i.super_amount,
   i.net_pay,i.gross_earned,i.send_id
  FROM public.trade_invoices i WHERE i.id=ANY(v_ids) AND i.org_id=p_org_id
 ), ln AS MATERIALIZED (
  SELECT l.* FROM public.trade_invoice_lines l JOIN inv i ON i.id=l.trade_invoice_id
  WHERE l.office_review_status IS NULL OR l.office_review_status='approved'
 ), job AS MATERIALIZED (
  SELECT j.id,j.job_number,j.status,w.id work_order_id,
   w.agreed_labour_ex + coalesce((v_changes->>w.id::text)::numeric,0)
    + coalesce((SELECT sum(v.trade_allocation_ex) FROM public.work_order_customer_variations v
      WHERE v.work_order_id=w.id AND v.status='approved'),0) allowed
  FROM public.jobs j
  LEFT JOIN public.work_orders w ON w.job_id=j.id AND w.org_id=p_org_id
   AND w.kind='job' AND w.status IN ('draft','approved')
  WHERE j.id IN (SELECT job_id FROM ln WHERE job_id IS NOT NULL) AND j.org_id=p_org_id
 ), sums AS (
  SELECT i.id,coalesce(sum(l.line_total_ex) FILTER (WHERE lower(btrim(l.line_type)) IS DISTINCT FROM 'reimbursement'),0) super_base,
   coalesce(sum(l.line_total_ex) FILTER (WHERE l.job_id IS NOT NULL
    AND lower(btrim(l.line_type)) IS DISTINCT FROM 'reimbursement'),0) expected_cost
  FROM inv i LEFT JOIN ln l ON l.trade_invoice_id=i.id GROUP BY i.id
 ), costs AS MATERIALIZED (
  -- Consume Job Profit's read, not a second cost derivation. Both its legacy
  -- source ids and counted split parts keep the original line id before ':'.
  SELECT c.document_id,c.source_id,c.job_id,c.amount_ex
  FROM public.v_job_cost_events c JOIN inv i ON c.document_id=i.id::text
  LEFT JOIN ln l ON l.id::text=split_part(c.source_id,':',1) AND l.trade_invoice_id=i.id
  WHERE p_stage='after_xero' AND c.is_actual
   AND c.source IN ('trade_line','trade_employer_super')
   AND lower(btrim(l.line_type)) IS DISTINCT FROM 'reimbursement'
 ), invoice_costs AS (
  SELECT i.id,coalesce((SELECT sum(c.amount_ex) FROM costs c
   WHERE c.document_id=i.id::text AND EXISTS(SELECT 1 FROM ln l
    WHERE l.trade_invoice_id=i.id AND l.job_id=c.job_id
     AND l.id::text=split_part(c.source_id,':',1))),0) actual
  FROM inv i
 ), billed AS (
  -- idx_inv_lines_job bounds all historical lines to these jobs; invoice PK
  -- and the existing (job_id,work_order_id) group key serve the joins.
  SELECT l.job_id,i.id,coalesce((to_jsonb(i)->>'pay_run_id') IS NOT NULL,false) in_run,
   i.submitted_at,sum(l.line_total_ex) amount
  FROM job j JOIN public.trade_invoice_lines l ON l.job_id=j.id
  JOIN public.trade_invoices i ON i.id=l.trade_invoice_id AND i.org_id=p_org_id
  WHERE i.status IS DISTINCT FROM 'draft' AND i.status IS DISTINCT FROM 'ops-reject'
   AND i.invoice_kind IN ('standard','follow_on')
   AND (l.office_review_status IS NULL OR l.office_review_status='approved')
   AND lower(btrim(coalesce(l.line_type,''))) NOT IN ('commission','reimbursement')
   AND (lower(btrim(coalesce(l.line_type,''))) <> 'group share' OR EXISTS (
    SELECT 1 FROM public.group_work_orders g WHERE g.job_id=l.job_id
     AND g.work_order_id=l.job_work_order_id AND g.pay_basis='inclusive_12_112_v1'))
  GROUP BY l.job_id,i.id,i.submitted_at
 ), running AS (
  SELECT b.*,sum(amount) OVER (PARTITION BY job_id
    ORDER BY in_run DESC,submitted_at NULLS LAST,id ROWS UNBOUNDED PRECEDING) running,
   sum(amount) OVER (PARTITION BY job_id) billed_total
  FROM billed b
 ), cap AS (
  SELECT r.*,j.job_number,j.allowed,
   bool_or(round(running*100)>round(j.allowed*100)) OVER (PARTITION BY r.job_id
     ORDER BY in_run DESC,submitted_at NULLS LAST,r.id ROWS UNBOUNDED PRECEDING) crossed
  FROM running r JOIN job j ON j.id=r.job_id
 ), send AS MATERIALIZED (
  SELECT DISTINCT i.send_id,public.trade_send_totals(i.send_id) totals
  FROM inv i WHERE i.send_id IS NOT NULL
 ), observations AS (
  SELECT 'pay_equals_job_cost'::text code,i.id invoice_id,NULL::text job_number,
   round(s.expected_cost,2) expected,round(c.actual,2) actual,
   p_stage='after_xero' AND round(s.expected_cost,2)<>round(c.actual,2) failed,
   p_stage='before_xero' skipped,'checked after the bills are drafted'::text skipped_why,
   'Invoice '||i.invoice_number||': pay and job cost differ by '||abs(round(s.expected_cost-c.actual,2))::text||'.' words
  FROM inv i JOIN sums s ON s.id=i.id JOIN invoice_costs c ON c.id=i.id
  UNION ALL
  SELECT 'nobody_above_work_order',i.id,c.job_number,c.allowed,c.billed_total,
   coalesce(c.crossed,false),c.allowed IS NULL,'no work order amount',
   'Job '||c.job_number||' is billed '||round(c.billed_total-c.allowed,2)::text||' above its work order. This invoice waits until the amount is raised or the invoice is corrected.'
  FROM inv i JOIN cap c ON c.id=i.id
  UNION ALL
  SELECT 'super_is_12_over_112',i.id,NULL,round(s.super_base*12/112,2),i.super_amount,
   i.super_basis='inclusive_12_112_v1' AND (i.super_amount IS DISTINCT FROM round(s.super_base*12/112,2)
    OR i.net_pay IS DISTINCT FROM i.gross_earned-i.super_amount),
   i.super_basis IS DISTINCT FROM 'inclusive_12_112_v1','priced before the start date',
   'Invoice '||i.invoice_number||': super is '||coalesce(i.super_amount::text,'unknown')||', should be '||round(s.super_base*12/112,2)::text||'.'
  FROM inv i JOIN sums s ON s.id=i.id
  UNION ALL
  SELECT 'no_paid_line_without_work_order',i.id,j.job_number,1,
   CASE WHEN j.allowed IS NOT NULL OR (l.not_job_work_type_id IS NOT NULL AND l.office_review_status='approved') THEN 1 ELSE 0 END,
   j.allowed IS NULL AND NOT coalesce(l.not_job_work_type_id IS NOT NULL AND l.office_review_status='approved',false)
    AND NOT coalesce(j.status IN ('complete','completed','closed','archived','cancelled','lost'),false),
   coalesce(j.status IN ('complete','completed','closed','archived','cancelled','lost'),false),'job closed before the rule',
   'Invoice '||i.invoice_number||' has a line on job '||coalesce(j.job_number,'not recorded')||', which has no work order amount.'
  FROM inv i JOIN ln l ON l.trade_invoice_id=i.id LEFT JOIN job j ON j.id=l.job_id
  WHERE lower(btrim(l.line_type)) IS DISTINCT FROM 'reimbursement'
  UNION ALL
  SELECT 'nothing_lost',i.id,NULL,(s.totals->>'sent_ex')::numeric,
   (s.totals->>'in_pay_ex')::numeric+(s.totals->>'held_ex')::numeric+(s.totals->>'declined_ex')::numeric,
   i.send_id IS NOT NULL AND (s.totals->>'balanced')::boolean IS DISTINCT FROM true,
   i.send_id IS NULL,'sent before the hold rule',
   'Invoice '||i.invoice_number||': what was sent does not add up to what is in pay, held and declined.'
  FROM inv i LEFT JOIN send s ON s.send_id=i.send_id
  UNION ALL
  SELECT 'crew_accepted',i.id,j.job_number,0,CASE WHEN c.off_crew THEN 1 ELSE 0 END,
   c.off_crew,false,NULL,
   'Invoice '||i.invoice_number||': this trade added themselves to job '||coalesce(j.job_number,'not recorded')||' and was not accepted on its crew.'
  FROM inv i JOIN ln l ON l.trade_invoice_id=i.id LEFT JOIN job j ON j.id=l.job_id
  CROSS JOIN LATERAL (SELECT l.office_review_status IS DISTINCT FROM 'approved'
   AND public.trade_is_off_job_crew(i.user_id,l.job_id,i.week_start) off_crew) c
  WHERE l.job_id IS NOT NULL
 ), stops AS (
  SELECT invoice_id,code,string_agg(DISTINCT words COLLATE "C",' ' ORDER BY words COLLATE "C") words
  FROM observations WHERE failed AND NOT skipped GROUP BY invoice_id,code
 ), stopped AS (
  SELECT i.id,i.invoice_number,jsonb_agg(jsonb_build_object('code','standing_'||s.code,'words',s.words)
   ORDER BY s.code COLLATE "C") stops FROM inv i JOIN stops s ON s.invoice_id=i.id GROUP BY i.id,i.invoice_number
 ), clean_cost AS (
  -- Read by invoice, not by line: an unexplained extra cost cannot disappear.
  SELECT coalesce((SELECT sum(s.expected_cost) FROM sums s WHERE NOT EXISTS(
   SELECT 1 FROM stopped t WHERE t.id=s.id)),0) expected,
   coalesce((SELECT sum(c.amount_ex) FROM costs c WHERE NOT EXISTS(
    SELECT 1 FROM stopped t WHERE t.id::text=c.document_id)),0) actual
 ), codes(code,ord) AS (VALUES ('pay_equals_job_cost',1),('nobody_above_work_order',2),
  ('super_is_12_over_112',3),('no_paid_line_without_work_order',4),('nothing_lost',5),('crew_accepted',6)),
 checks AS (
  SELECT c.ord,jsonb_build_object('code',c.code,'pass',count(*) FILTER (WHERE o.failed AND NOT o.skipped)=0,
   'checked',count(o.invoice_id) FILTER (WHERE NOT o.skipped),
   'failed',count(DISTINCT o.invoice_id) FILTER (WHERE o.failed AND NOT o.skipped),
   'expected',sum(o.expected) FILTER (WHERE NOT o.skipped),'actual',sum(o.actual) FILTER (WHERE NOT o.skipped),
   'words',coalesce(string_agg(DISTINCT o.words COLLATE "C",' ' ORDER BY o.words COLLATE "C")
     FILTER (WHERE o.failed AND NOT o.skipped),'No difference found.'),
   'invoices',coalesce(jsonb_agg(jsonb_build_object('invoice_id',i.id,'invoice_number',i.invoice_number,
    'job_number',o.job_number,'detail',jsonb_build_object('expected',o.expected,'actual',o.actual))
     ORDER BY i.id,o.job_number COLLATE "C") FILTER (WHERE o.failed AND NOT o.skipped),'[]'::jsonb),
   'skipped',count(o.invoice_id) FILTER (WHERE o.skipped),
   'skipped_why',string_agg(DISTINCT o.skipped_why COLLATE "C",'; ' ORDER BY o.skipped_why COLLATE "C") FILTER (WHERE o.skipped)) answer
  FROM codes c LEFT JOIN observations o ON o.code=c.code LEFT JOIN inv i ON i.id=o.invoice_id GROUP BY c.code,c.ord
 )
 SELECT jsonb_build_object('rule','pay-run-standing-v1','stage',p_stage,
  'checks',(SELECT jsonb_agg(answer ORDER BY ord) FROM checks),
  'stopped_invoices',coalesce((SELECT jsonb_agg(jsonb_build_object('invoice_id',id,'invoice_number',invoice_number,'stops',stops) ORDER BY id) FROM stopped),'[]'::jsonb),
  'run_blocked',p_stage='after_xero' AND round(t.expected,2)<>round(t.actual,2),
  'run_blocked_words',CASE WHEN p_stage='after_xero' AND round(t.expected,2)<>round(t.actual,2)
   THEN 'Pay and job cost differ by '||abs(round(t.expected-t.actual,2))::text||' across this pay run and no single invoice explains it. Nobody is paid until they match.' END)
 INTO v_result FROM clean_cost t;
 RETURN v_result;
END;
$fn$;
REVOKE ALL ON FUNCTION public.trade_pay_run_standing_checks(uuid,uuid[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trade_pay_run_standing_checks(uuid,uuid[],text) TO service_role;
