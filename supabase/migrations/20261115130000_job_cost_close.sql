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
--   not_applicable  the holding job, or a job that did not go ahead (cancelled, lost) with no cost on it and
--                   no cost still to come (pending_cost_reasons: an order or a bill still out).
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
-- When is the work finished. A day on the job never finishes it by itself: a job sent back to work keeps its old
-- completed_at and its old sign-off (measured: jobs at in_progress, awaiting_supplier and partially_accepted
-- carry one). What finishes a job is where it stands now:
--   a finished status (finished_statuses), for a job with no repair stage;
--   a repair stage of complete (jobs.metadata.repair_stage), for a job that carries a repair stage. Its stage,
--     not its status, is where a repair stands (measured: a repair at complete with its stage still on_site),
--     and an invoice does not finish it. Archived (closed_statuses) also finishes it: the card was put away;
--   an approved customer invoice, for a make-safe that has no repair stage, is not restoration work, is still on
--     its first attendance (makesafe_job_details.cycle_number 1 and no reopen_reason) and sits at one of the
--     statuses an invoiced make-safe rests at (invoice_finish_statuses; measured: accepted, scheduled,
--     processing). A make-safe is invoiced after the attendance and its status is not its stage. One reopened,
--     sent back for another attendance, in progress, or restoration work (invoiced before its works) is finished
--     only by its status;
--   cancelled or lost, with a cost on it or one still to come.
-- A job in rectification is never finished, whatever else it carries.
--
-- finished_on is the day the quiet count starts from, and it is the latest day the records give, never the
-- earliest, so a job finished a second time is not dated by its first finish:
--   the later of jobs.completed_at and the newest client sign-off that stands (a sign-off revoked later is no
--     sign-off). If the job's status went back to a working one after that day (job_events status_changed), the
--     day is stale and the finish is the first move into a finished status after it;
--   with no such day, the first move into a finished status after its last working status;
--   for a repair finished by its stage, also the day its stage last moved to complete (repair_stage_changed);
--   for a make-safe finished by its invoice, the first approved customer invoice.
-- With no finish day on record at all, the quiet count runs from the newer of the last cost and the day the job
-- record last changed (jobs.updated_at), so a job put away today is not final today.
-- finished_basis names what dated it: work_done (completed_at or a sign-off), first_invoice, repair_stage,
-- status (a status move, or no day), did_not_go_ahead.
--
-- waiting_on is Job Profit's completeness list and cost flag, less the reasons that are not about cost
-- (not_cost_reasons). Any cost flag other than ok holds a close, text_matched_lines included, and a reason Job
-- Profit adds later holds a close until someone decides otherwise.
-- as_of moves only the day the quiet count is measured to. The costs, the status and Job Profit's reasons are
-- always today's: this is not a read of how the job stood on an earlier day.
-- This read says the cost is complete. It does not say every line is evidenced in bookkeeping: that is
-- job_profit_line_evidence, unchanged.
--
-- Service role only, like v_job_profit. Read only. Rollback: supabase/rollbacks/20261115130000_job_cost_close_down.sql.

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.job_client_signoffs') IS NULL
     OR to_regclass('public.makesafe_job_details') IS NULL OR to_regclass('public.job_events') IS NULL THEN
    RAISE EXCEPTION 'job cost close: v_job_profit, job_client_signoffs, makesafe_job_details or job_events is missing';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.makesafe_job_details'::regclass AND NOT a.attisdropped
         AND a.attname IN ('cycle_number', 'reopen_reason')) <> 2 THEN
    RAISE EXCEPTION 'job cost close: makesafe_job_details.cycle_number or reopen_reason is missing';
  END IF;
  -- The read runs with the caller's rights, and its only caller is the service role.
  IF NOT has_table_privilege('service_role', 'public.makesafe_job_details', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.job_client_signoffs', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.job_events', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.jobs', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'job cost close: the service role cannot read a table this reads';
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
    'invoice_finish_statuses', jsonb_build_array('accepted', 'scheduled', 'processing'),
    'invoice_never_finishes_subtypes', jsonb_build_array('restoration'),
    'repair_finished_stages', jsonb_build_array('complete'),
    'closed_statuses', jsonb_build_array('archived'),
    'not_cost_reasons', jsonb_build_array('missing_client_invoice', 'draft_revenue', 'holding_job',
                                          'variation_not_invoiced', 'variation_invoice_unchecked',
                                          'expected_cost_lane_missing', 'xero_project_linked_by_contact_only'),
    'pending_cost_reasons', jsonb_build_array('open_purchase_orders', 'ordered_not_billed',
                                              'ordered_not_billed_over_30_days', 'po_no_bill_overdue',
                                              'invoice_emailed_bill_not_placed', 'installer_bill_unconfirmed',
                                              'unapproved_trade_charges')
  );
$policy$;

COMMENT ON FUNCTION public.job_cost_close_policy() IS
  'Job cost close (20261115130000): the numbers and lists job_cost_close reads. quiet_days: Perth days with no new cost, after the newer of the finish day and the last cost, before a finished job''s cost is final. finished_statuses: the statuses that finish a job with no repair stage; a day on the job never does by itself. did_not_go_ahead_statuses: cancelled or lost. reopened_statuses: never finished while here. invoice_marks_finished_types: work types whose first approved customer invoice marks the finish, only at a status in invoice_finish_statuses, never for a subtype in invoice_never_finishes_subtypes or a job with a restoration stage, never a job with a repair stage, never one reopened or past its first attendance. repair_finished_stages: values of jobs.metadata.repair_stage that mean the repair is finished. closed_statuses: statuses that finish a job carrying a repair stage whatever its stage. not_cost_reasons: Job Profit reasons that are not about cost and never hold a close. pending_cost_reasons: reasons that say a cost is still to come, so a cancelled or lost job carrying one is waiting, not out of scope. Change only by migration. Service role only.';

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
-- The read is one large statement over a few thousand rows. Compiling it costs seconds and saves nothing
-- (measured locally: 5 s with, 0.2 s without). Production already runs with it off.
SET jit = off
AS $fn$
  WITH params AS (
    SELECT (p.pol ->> 'quiet_days')::integer AS quiet_days,
           p.pol ->> 'version' AS rule,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'finished_statuses')) AS finished_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'did_not_go_ahead_statuses')) AS dnga_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'reopened_statuses')) AS reopened_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'invoice_marks_finished_types')) AS invoice_types,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'invoice_finish_statuses')) AS invoice_finish_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'invoice_never_finishes_subtypes')) AS invoice_never_subtypes,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'repair_finished_stages')) AS repair_finished_stages,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'closed_statuses')) AS closed_statuses,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'not_cost_reasons')) AS not_cost_reasons,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'pending_cost_reasons')) AS pending_cost_reasons,
           COALESCE(p_as_of, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of
      FROM (SELECT public.job_cost_close_policy() AS pol) p
  ), moves AS (
    -- Status moves on record, each marked finished or not. Read once, by event type, never per job.
    SELECT e.job_id, e.created_at,
           COALESCE(e.detail_json ->> 'new_status', e.detail_json ->> 'to') = ANY (pr.finished_statuses) AS to_finished
      FROM public.job_events e CROSS JOIN params pr
     WHERE e.event_type IN ('status_changed', 'status_change')
       AND COALESCE(e.detail_json ->> 'new_status', e.detail_json ->> 'to') IS NOT NULL
       AND (p_job_ids IS NULL OR e.job_id = ANY (p_job_ids))
  ), worked AS (
    -- The last time the job's status moved to one that is not finished.
    SELECT m.job_id, max(m.created_at) AS back_to_work_at
      FROM moves m WHERE NOT m.to_finished GROUP BY m.job_id
  ), refinished AS (
    -- The first move into a finished status after that.
    SELECT m.job_id, min(m.created_at) AS refinished_at
      FROM moves m LEFT JOIN worked w ON w.job_id = m.job_id
     WHERE m.to_finished AND (w.back_to_work_at IS NULL OR m.created_at > w.back_to_work_at)
     GROUP BY m.job_id
  ), staged AS (
    SELECT e.job_id, max(e.created_at) AS stage_done_at
      FROM public.job_events e CROSS JOIN params pr
     WHERE e.event_type = 'repair_stage_changed'
       AND e.detail_json ->> 'to_stage' = ANY (pr.repair_finished_stages)
       AND (p_job_ids IS NULL OR e.job_id = ANY (p_job_ids))
     GROUP BY e.job_id
  ), src AS (
    SELECT jp.job_id, jp.org_id, jp.job_number, jp.status, jp.work_type, jp.work_subtype, jp.holding_job,
           jp.actual_cost_events, jp.actual_cost_ex, jp.last_cost_date, jp.first_invoice_date, jp.invoiced_ex,
           jp.cost_flag, jp.completeness, jp.costs_verified_paid,
           j.metadata ->> 'repair_stage' AS repair_stage,
           j.metadata ? 'restoration_stage' AS has_restoration_stage,
           COALESCE(d.cycle_number, 1) <= 1 AND d.reopen_reason IS NULL AS first_attendance,
           (j.updated_at AT TIME ZONE 'Australia/Perth')::date AS record_changed_on,
           -- The latest day the records give: completed_at, or the newest sign-off not revoked since.
           -- GREATEST skips a null.
           GREATEST(j.completed_at,
                    (SELECT max(s.created_at)
                       FROM public.job_client_signoffs s
                      WHERE s.job_id = jp.job_id AND s.method <> 'revoked'
                        AND NOT EXISTS (SELECT 1 FROM public.job_client_signoffs r
                                         WHERE r.job_id = jp.job_id AND r.method = 'revoked'
                                           AND r.created_at >= s.created_at))) AS done_at,
           w.back_to_work_at, rf.refinished_at, sg.stage_done_at
      FROM public.v_job_profit jp
      JOIN public.jobs j ON j.id = jp.job_id
      LEFT JOIN public.makesafe_job_details d ON d.job_id = jp.job_id
      LEFT JOIN worked w ON w.job_id = jp.job_id
      LEFT JOIN refinished rf ON rf.job_id = jp.job_id
      LEFT JOIN staged sg ON sg.job_id = jp.job_id
     WHERE p_job_ids IS NULL OR jp.job_id = ANY (p_job_ids)
  ), reasoned AS (
    SELECT s.*, pr.quiet_days, pr.rule, pr.as_of,
           s.status = ANY (pr.dnga_statuses) AS did_not_go_ahead,
           s.status = ANY (pr.reopened_statuses) AS reopened,
           s.status = ANY (pr.finished_statuses) AS finished_status,
           s.status = ANY (pr.closed_statuses) AS closed_status,
           s.status = ANY (pr.invoice_finish_statuses) AS invoice_status,
           s.repair_stage IS NOT NULL AS has_stage,
           COALESCE(s.repair_stage = ANY (pr.repair_finished_stages), false) AS stage_finished,
           CASE WHEN s.work_type = ANY (pr.invoice_types) AND s.repair_stage IS NULL AND s.invoiced_ex > 0
                     AND s.first_attendance AND NOT s.has_restoration_stage
                     AND COALESCE(s.work_subtype, '') <> ALL (pr.invoice_never_subtypes)
                THEN s.first_invoice_date END AS invoice_finish_on,
           -- The recorded day stands unless the status went back to a working one after it.
           s.done_at IS NOT NULL AND (s.back_to_work_at IS NULL OR s.back_to_work_at <= s.done_at) AS done_stands,
           pr.pending_cost_reasons,
           ARRAY(SELECT u.r
                   FROM unnest(s.completeness || CASE WHEN s.cost_flag <> 'ok' THEN ARRAY[s.cost_flag] ELSE ARRAY[]::text[] END)
                        WITH ORDINALITY AS u(r, o)
                  WHERE u.r IS NOT NULL AND u.r <> ALL (pr.not_cost_reasons)
                  GROUP BY u.r
                  ORDER BY min(u.o)) AS cost_reasons
      FROM src s CROSS JOIN params pr
  ), marked AS (
    SELECT r.*, r.cost_reasons && r.pending_cost_reasons AS cost_pending
      FROM reasoned r
  ), judged AS (
    -- Where the job stands now decides. A finish day alone finishes nothing.
    SELECT m.*,
           CASE WHEN m.reopened THEN false
                WHEN m.did_not_go_ahead THEN m.actual_cost_events > 0 OR m.cost_pending
                WHEN m.has_stage THEN m.stage_finished OR m.closed_status
                ELSE m.finished_status OR (m.invoice_finish_on IS NOT NULL AND m.invoice_status)
           END AS finished
      FROM marked m
  ), dated AS (
    SELECT g.*,
           CASE WHEN NOT g.finished OR g.did_not_go_ahead THEN NULL::date
                WHEN g.has_stage AND g.stage_finished
                  THEN (GREATEST(g.done_at, g.stage_done_at) AT TIME ZONE 'Australia/Perth')::date
                WHEN g.finished_status OR g.has_stage
                  THEN CASE WHEN g.done_stands THEN (g.done_at AT TIME ZONE 'Australia/Perth')::date
                            WHEN g.done_at IS NULL AND g.invoice_finish_on IS NOT NULL THEN g.invoice_finish_on
                            ELSE (g.refinished_at AT TIME ZONE 'Australia/Perth')::date END
                ELSE g.invoice_finish_on
           END AS finished_on
      FROM judged g
  ), based AS (
    SELECT d.*,
           CASE WHEN NOT d.finished THEN NULL
                WHEN d.did_not_go_ahead THEN 'did_not_go_ahead'
                WHEN d.has_stage AND d.stage_finished
                  THEN CASE WHEN d.done_at IS NOT NULL THEN 'work_done' ELSE 'repair_stage' END
                WHEN d.finished_status OR d.has_stage
                  THEN CASE WHEN d.done_stands THEN 'work_done'
                            WHEN d.done_at IS NULL AND d.invoice_finish_on IS NOT NULL THEN 'first_invoice'
                            ELSE 'status' END
                ELSE 'first_invoice'
           END AS finished_basis,
           -- No finish day on record: count from the newer of the last cost and the day the record last changed.
           CASE WHEN d.finished_on IS NOT NULL THEN GREATEST(d.finished_on, d.last_cost_date)
                WHEN d.last_cost_date IS NOT NULL THEN GREATEST(d.last_cost_date, d.record_changed_on)
           END AS quiet_from
      FROM dated d
  ), stated AS (
    SELECT b.*,
           CASE WHEN b.holding_job THEN 'not_applicable'
                WHEN b.did_not_go_ahead AND NOT b.finished THEN 'not_applicable'
                WHEN NOT b.finished THEN 'open'
                WHEN cardinality(b.cost_reasons) > 0 OR b.quiet_from IS NULL THEN 'waiting'
                WHEN b.as_of < b.quiet_from + b.quiet_days THEN 'settling'
                ELSE 'final'
           END AS cost_state
      FROM based b
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
  'Job cost close (20261115130000): per job in v_job_profit, whether its cost is final. cost_state: not_applicable (holding job, or cancelled or lost with no cost and none still to come), open (work not finished, or in rectification), waiting (finished; waiting_on names what stands in the way), settling (finished, nothing outstanding, quiet for fewer than quiet_days; final_on is the day it turns final), final (final_on is the day it became final, closed_by the rule). Finished is where the job stands now (a finished status; for a job with a repair stage, stage complete or archived; or an approved invoice on a make-safe that is at a resting status, on its first attendance and not restoration work), never a day on the job alone. finished_on is the latest finish day the records give (completed_at, a standing sign-off, or the move into a finished status after the last working one); with none, the quiet count runs from the newer of the last cost and the day the job record last changed. Derived on every read from Job Profit''s row: a later cost or reason reopens it. waiting_on is Job Profit''s completeness and cost flag less the reasons that are not about cost; any cost flag other than ok holds a close. Says the cost is complete, not that every line is evidenced (job_profit_line_evidence). Null ids: every job. Null as_of: today in Perth; as_of moves only the day the quiet count is measured to, the costs, status and reasons are always today''s. Read only. Service role only.';

REVOKE ALL ON FUNCTION public.job_cost_close_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_cost_close(uuid[], date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_close_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_close(uuid[], date) TO service_role;
