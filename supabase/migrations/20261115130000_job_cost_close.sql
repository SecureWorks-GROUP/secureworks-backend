-- Job cost close: is a job's cost final, and if not, what it is waiting on.
--
-- Job Profit says what a job cost so far. Nothing said whether that figure was finished, so every reader
-- inferred it from the job status. This adds one read, worked out from Job Profit's own row every time it is
-- asked. It stores nothing, writes nothing and changes no existing figure: v_job_profit is not touched.
--
--   job_cost_close_policy()            the numbers and lists the rule reads. Change only by migration.
--   job_cost_close(job ids, as of)     one row per job in v_job_profit (every job when the ids are null).
--
-- cost_state is one of:
--   not_applicable  the holding job, or a job that did not go ahead (cancelled, lost) with no cost on it.
--   open            the work is not finished, or the job is back in rectification.
--   waiting         the work is finished and something named in waiting_on stands between the job and a final
--                   cost (a bill not in, an order not billed, a bill a person has not confirmed, no cost at all).
--   settling        finished, nothing outstanding, but the newer of the finish day and the last cost is fewer
--                   than quiet_days Perth days ago. final_on is the day it turns final if nothing else lands.
--   final           finished, nothing outstanding, and quiet for quiet_days. final_on is the day it became final
--                   and closed_by names the rule. No person closes a job in this version.
--
-- The state is derived, so a cost that lands on a final job moves it back to settling by itself, and a new
-- reason on the job moves it to waiting. Measured on production before this was written (15 Nov 2026, 261
-- finished jobs with a finish day on or before 15 Aug): 22 took a cost more than 30 days after things went
-- quiet, 17 after 45 days, 16 after 60. Waiting longer barely helps, so quiet_days is 30, the same limit
-- Job Profit already uses for an order with no bill.
--
-- When is the work finished (finished_basis):
--   work_done        Job Profit's own day: the earlier of jobs.completed_at and the first client sign-off.
--   first_invoice    a make-safe is invoiced after the attendance and its job status is not its stage (measured:
--                    invoiced make-safes sit at accepted, scheduled and processing), so its first approved
--                    customer invoice marks the finish. Not used for a job that carries a repair stage.
--   repair_stage     a repair's stage is jobs.metadata.repair_stage, not its status: complete is finished. An
--                    invoice does not finish a repair (invoiced repairs were found still on site).
--   status           a finished status with no day on record.
--                    For repair_stage and status the quiet count runs from the last cost.
--   did_not_go_ahead cancelled or lost, with a cost on it. The quiet count runs from the last cost.
-- A job in rectification is never finished, whatever days it carries.
--
-- waiting_on is Job Profit's completeness list and cost flag, less the reasons that are not about cost
-- (not_cost_reasons). A reason Job Profit adds later holds a close until someone decides otherwise.
-- This read says the cost is complete. It does not say every line is evidenced in bookkeeping: that is
-- job_profit_line_evidence, unchanged.
--
-- Service role only, like v_job_profit. Read only. Rollback: supabase/rollbacks/20261115130000_job_cost_close_down.sql.

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.job_client_signoffs') IS NULL THEN
    RAISE EXCEPTION 'job cost close: v_job_profit or job_client_signoffs is missing';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.job_cost_close_policy()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $policy$
  SELECT jsonb_build_object(
    'version', 'cost-close-v1',
    'quiet_days', 30,
    'finished_statuses', jsonb_build_array('complete', 'invoiced', 'final_payment', 'get_review', 'archived'),
    'did_not_go_ahead_statuses', jsonb_build_array('cancelled', 'lost'),
    'reopened_statuses', jsonb_build_array('rectification'),
    'invoice_marks_finished_types', jsonb_build_array('makesafe'),
    'repair_finished_stages', jsonb_build_array('complete'),
    'not_cost_reasons', jsonb_build_array('missing_client_invoice', 'draft_revenue', 'holding_job',
                                          'variation_not_invoiced', 'variation_invoice_unchecked',
                                          'expected_cost_lane_missing', 'xero_project_linked_by_contact_only')
  );
$policy$;

COMMENT ON FUNCTION public.job_cost_close_policy() IS
  'Job cost close (20261115130000): the numbers and lists job_cost_close reads. quiet_days: Perth days with no new cost, after the newer of the finish day and the last cost, before a finished job''s cost is final. finished_statuses: finished without a day on record. did_not_go_ahead_statuses: cancelled or lost. reopened_statuses: never finished while here. invoice_marks_finished_types: work types whose first approved customer invoice marks the finish (never a job with a repair stage). repair_finished_stages: values of jobs.metadata.repair_stage that mean the repair is finished. not_cost_reasons: Job Profit reasons that are not about cost and never hold a close. Change only by migration. Service role only.';

CREATE OR REPLACE FUNCTION public.job_cost_close(p_job_ids uuid[] DEFAULT NULL, p_as_of date DEFAULT NULL)
RETURNS TABLE (
  job_id uuid,
  org_id uuid,
  job_number text,
  cost_state text,
  cost_final boolean,
  final_on date,
  closed_by text,
  finished boolean,
  finished_on date,
  finished_basis text,
  last_cost_on date,
  waiting_on text[],
  actual_cost_ex numeric,
  all_costs_paid boolean,
  quiet_days integer,
  as_of date,
  rule text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH params AS (
    SELECT (p.pol ->> 'quiet_days')::integer AS quiet_days,
           p.pol ->> 'version' AS rule,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'finished_statuses')) AS finished_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'did_not_go_ahead_statuses')) AS dnga_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'reopened_statuses')) AS reopened_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'invoice_marks_finished_types')) AS invoice_types,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'repair_finished_stages')) AS repair_finished_stages,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'not_cost_reasons')) AS not_cost_reasons,
           COALESCE(p_as_of, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of
      FROM (SELECT public.job_cost_close_policy() AS pol) p
  ), src AS (
    SELECT jp.job_id, jp.org_id, jp.job_number, jp.status, jp.work_type, jp.holding_job,
           jp.actual_cost_events, jp.actual_cost_ex, jp.last_cost_date, jp.first_invoice_date, jp.invoiced_ex,
           jp.cost_flag, jp.completeness, jp.costs_verified_paid,
           j.metadata ->> 'repair_stage' AS repair_stage,
           LEAST((j.completed_at AT TIME ZONE 'Australia/Perth')::date,
                 (SELECT (min(s.created_at) AT TIME ZONE 'Australia/Perth')::date
                    FROM public.job_client_signoffs s WHERE s.job_id = jp.job_id)) AS work_done_on
      FROM public.v_job_profit jp
      JOIN public.jobs j ON j.id = jp.job_id
     WHERE p_job_ids IS NULL OR jp.job_id = ANY (p_job_ids)
  ), marked AS (
    SELECT s.*, pr.quiet_days, pr.rule, pr.as_of,
           s.status = ANY (pr.dnga_statuses) AS did_not_go_ahead,
           s.status = ANY (pr.reopened_statuses) AS reopened,
           s.status = ANY (pr.finished_statuses) AS finished_status,
           COALESCE(s.repair_stage = ANY (pr.repair_finished_stages), false) AS stage_finished,
           CASE WHEN s.work_type = ANY (pr.invoice_types) AND s.repair_stage IS NULL AND s.invoiced_ex > 0
                THEN s.first_invoice_date END AS invoice_finish_on,
           ARRAY(SELECT u.r
                   FROM unnest(s.completeness || CASE WHEN s.cost_flag <> 'ok' THEN ARRAY[s.cost_flag] ELSE ARRAY[]::text[] END)
                        WITH ORDINALITY AS u(r, o)
                  WHERE u.r IS NOT NULL AND u.r <> ALL (pr.not_cost_reasons)
                  GROUP BY u.r
                  ORDER BY min(u.o)) AS cost_reasons
      FROM src s CROSS JOIN params pr
  ), dated AS (
    SELECT m.*,
           CASE WHEN m.did_not_go_ahead OR m.reopened THEN NULL::date
                ELSE COALESCE(m.work_done_on, m.invoice_finish_on) END AS finished_on
      FROM marked m
  ), judged AS (
    SELECT d.*,
           NOT d.reopened AND (
             (d.did_not_go_ahead AND d.actual_cost_events > 0)
             OR (NOT d.did_not_go_ahead AND (d.finished_on IS NOT NULL OR d.stage_finished OR d.finished_status))
           ) AS finished,
           CASE WHEN d.reopened THEN NULL
                WHEN d.did_not_go_ahead THEN CASE WHEN d.actual_cost_events > 0 THEN 'did_not_go_ahead' END
                WHEN d.work_done_on IS NOT NULL THEN 'work_done'
                WHEN d.invoice_finish_on IS NOT NULL THEN 'first_invoice'
                WHEN d.stage_finished THEN 'repair_stage'
                WHEN d.finished_status THEN 'status'
           END AS finished_basis,
           GREATEST(d.finished_on, d.last_cost_date) AS quiet_from
      FROM dated d
  ), stated AS (
    SELECT g.*,
           CASE WHEN g.holding_job THEN 'not_applicable'
                WHEN g.did_not_go_ahead AND g.actual_cost_events = 0 THEN 'not_applicable'
                WHEN NOT g.finished THEN 'open'
                WHEN cardinality(g.cost_reasons) > 0 OR g.quiet_from IS NULL THEN 'waiting'
                WHEN g.as_of < g.quiet_from + g.quiet_days THEN 'settling'
                ELSE 'final'
           END AS cost_state
      FROM judged g
  )
  SELECT t.job_id, t.org_id, t.job_number, t.cost_state,
         t.cost_state = 'final' AS cost_final,
         CASE WHEN t.cost_state IN ('settling', 'final') THEN t.quiet_from + t.quiet_days END AS final_on,
         CASE WHEN t.cost_state = 'final' THEN 'rule:' || t.rule END AS closed_by,
         t.finished AND t.cost_state <> 'not_applicable' AS finished,
         CASE WHEN t.finished AND t.cost_state <> 'not_applicable' THEN t.finished_on END AS finished_on,
         CASE WHEN t.finished AND t.cost_state <> 'not_applicable' THEN t.finished_basis END AS finished_basis,
         t.last_cost_date AS last_cost_on,
         CASE WHEN t.cost_state = 'waiting' AND cardinality(t.cost_reasons) = 0 THEN ARRAY['no_cost_date']
              WHEN t.cost_state IN ('open', 'waiting') THEN t.cost_reasons
              ELSE ARRAY[]::text[] END AS waiting_on,
         t.actual_cost_ex,
         t.costs_verified_paid AS all_costs_paid,
         t.quiet_days, t.as_of, t.rule
    FROM stated t;
$fn$;

COMMENT ON FUNCTION public.job_cost_close(uuid[], date) IS
  'Job cost close (20261115130000): per job in v_job_profit, whether its cost is final. cost_state: not_applicable (holding job, or cancelled or lost with no cost), open (work not finished, or in rectification), waiting (finished; waiting_on names what stands in the way), settling (finished, nothing outstanding, quiet for fewer than quiet_days; final_on is the day it turns final), final (final_on is the day it became final, closed_by the rule). Derived on every read from Job Profit''s row: a later cost or reason reopens it. waiting_on is Job Profit''s completeness and cost flag less the reasons that are not about cost. Says the cost is complete, not that every line is evidenced (job_profit_line_evidence). Null ids: every job. Null as_of: today in Perth. Read only. Service role only.';

REVOKE ALL ON FUNCTION public.job_cost_close_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_cost_close(uuid[], date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_close_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_close(uuid[], date) TO service_role;
