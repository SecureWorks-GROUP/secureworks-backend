-- Break: the figure goes back to the earlier basis (each Job Profit row on its own date and division: a crew line on its
-- work date, a credit on its bill's date, employer super counted, no overhead rows). The contract must catch it.
DROP VIEW public.v_job_profit_division_months;
DROP VIEW public.v_job_profit_xero_basis_lines;
CREATE VIEW public.v_job_profit_xero_basis_lines AS
 SELECT 'cost'::text AS side, COALESCE(c.business_unit, public.job_profit_job_division(j.job_number, j.type)) AS division,
    c.event_date AS posted_on, c.amount_ex, true AS in_figure, NULL::text AS not_in_figure_reason, c.job_id, j.job_number,
    c.source AS kind, c.source_id, c.document_id, c.document_number, c.document_id AS xero_document_id,
    c.document_number AS xero_document_number, 'job_profit_date'::text AS date_basis, 'job'::text AS division_basis,
    c.event_date AS job_profit_date, public.job_profit_job_division(j.job_number, j.type) AS job_division, c.account_code
   FROM public.v_job_cost_events c JOIN public.jobs j ON j.id = c.job_id
  WHERE c.is_actual AND c.lane IN ('labour', 'materials', 'commission', 'other');
CREATE VIEW public.v_job_profit_division_months AS
 SELECT l.division, date_trunc('month', l.posted_on::timestamp)::date AS month, l.side, sum(l.amount_ex) AS amount_ex,
    sum(l.amount_ex) AS job_rows_ex, NULL::numeric AS overhead_rows_ex, count(*) AS lines, count(*) AS lines_division_from_job
   FROM public.v_job_profit_xero_basis_lines l GROUP BY 1, 2, 3;
