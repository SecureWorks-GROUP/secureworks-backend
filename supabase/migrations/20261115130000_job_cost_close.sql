-- Job cost close: is a job's cost final, and if not, what it is waiting on.
--
-- Job Profit says what a job cost so far. Nothing said whether that figure was finished, so every reader
-- inferred it from the job status. This adds one read, worked out from Job Profit's own row every time it is
-- asked. The read stores nothing and changes no existing figure: v_job_profit is not touched.
--
--   job_status_moves                   the database's own record of every job status move, kept by a trigger
--                                      on jobs from the moment this is applied. One row per move, never changed.
--   job_cost_close_policy()            the numbers and lists the rule reads. Change only by migration.
--   job_cost_close(job ids, as of)     one row per job in v_job_profit (every job when the ids are null).
--
-- Why the record. The rule dates a finish by the last time the job went back to work, so it is only as good as
-- the record of status moves. The application's own events (job_events) are not that record: some writers
-- change jobs.status and log something else, or nothing (measured on production, 15 Nov 2026: a restoration
-- stage move, a quote accepted on a finished job, a declined quote run, a callback, a booking moving accepted
-- to processing, an archive sweep; 29 finished jobs whose last logged move does not explain their status).
-- Naming each writer does not close that: the next writer is not on the list. So two things that no writer
-- can get around, both kept by the database:
--   from now on, every status change writes a row to job_status_moves (trigger on jobs, whoever makes the
--     change). A row is written when a job is created, and each job that already exists gets one baseline row
--     saying where it stood when the record began;
--   for the time before the record began, jobs.updated_at (set by trigger on every update of the row) bounds
--     any move nobody logged: none can be later than it. A finished job's cost is never final until quiet_days
--     after the earlier of that day and the day its record began (the history floor). A job untouched for 30
--     days loses nothing by it; one touched in the last 30 days waits out the difference, once.
-- The application events are still read (they are the only history there is), with the events that carry a
-- status under another name added (status_events).
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
--     and an invoice does not finish it. The stage stands while no working status move is on record after it
--     reached complete; one sent back to work with its stage left at complete is finished again only by a
--     finished status. Archived (closed_statuses) also finishes it: the card was put away;
--   never while a callback is open on it (jobs.is_callback, or a callback_opened event with no
--     callback_resolved after it): the work is being redone, whatever the status says;
--   never while a crew visit is booked on or after as_of (a live job_assignments row: scheduled or confirmed,
--     not a ghost or an observer): labour is still to come;
--   an approved customer invoice, for a make-safe that has no repair stage, has never been taken out of a
--     finished status (once one has, only a finished status finishes it again), is not restoration work, is still on
--     its first attendance (makesafe_job_details.cycle_number 1 and no reopen_reason) and sits at one of the
--     statuses an invoiced make-safe rests at (invoice_finish_statuses; measured: accepted, scheduled,
--     processing). A make-safe is invoiced after the attendance and its status is not its stage. One reopened,
--     sent back for another attendance, in progress, or restoration work (invoiced before its works) is finished
--     only by its status;
--   cancelled or lost, with a cost on it or one still to come.
-- A job in rectification is never finished, whatever else it carries.
--
-- finished_on is the day the quiet count starts from. It is the later of two days, so a job finished a second
-- time is never dated by its first finish, and a job is never dated before it came to stand where it stands:
--   the work day: the later of jobs.completed_at and the newest client sign-off that stands (a sign-off revoked
--     later is no sign-off);
--   the day the job came to stand where it stands: for a repair finished by its stage, the day its stage last
--     moved to complete (repair_stage_changed); for a make-safe, its first approved customer invoice; otherwise
--     the first move into a finished status after the last move out of one (job_events status_changed).
-- A day stands only while the status has not moved to a working one after it. A working move is a move to any
-- status that is not finished; for a make-safe or a job with a repair stage, whose status is not its stage,
-- a move to a resting status (invoice_finish_statuses) is not one, unless it is a move out of a finished status
-- (the record names the status it left): that is a return to work wherever it lands. An invoice is stricter:
-- it stands only while no move to a status that is not finished comes on a later Perth day, except a move from
-- one resting status to another whose old status is named (the record, or the event, names it; an old status
-- inferred from the previous logged move does not count, because a move nobody logged may lie between).
-- A repair's stage stands only while no stage move to another stage is on record after it last reached complete. Reopening or re-attending
-- a make-safe, a quote accepted or a quote run declined, and a callback opened each put a job back to work and
-- may log no status move; each leaves its own job_events row (reopen_event_types, reopen_note_prefix) and each
-- counts as a working move. A stage day or an invoice day that does not stand gives way to the first move into
-- a finished status after the last move out of one, and a stage or an invoice that does not stand finishes
-- nothing.
-- The quiet count starts from the newest of the finish day, the last cost and the history floor.
-- With no finish day on record at all, the quiet count runs from the newer of the last cost and the day the job
-- record last changed (jobs.updated_at), so a job put away today is not final today.
-- finished_basis names what dated it: work_done (completed_at or a sign-off), first_invoice, repair_stage,
-- status (a status move, or no day), did_not_go_ahead.
-- Known limit: an invoiced make-safe at a resting status is taken as attended. Nothing here reads an attendance
-- record. An invoiced make-safe nobody attended holds no labour, so Job Profit's own reasons keep it waiting.
--
-- waiting_on is Job Profit's completeness list and cost flag, less the reasons that are not about cost
-- (not_cost_reasons). Any cost flag other than ok holds a close, text_matched_lines included, and a reason Job
-- Profit adds later holds a close until someone decides otherwise.
-- as_of moves only the day the quiet count is measured to. The costs, the status and Job Profit's reasons are
-- always today's: this is not a read of how the job stood on an earlier day.
-- This read says the cost is complete. It does not say every line is evidenced in bookkeeping: that is
-- job_profit_line_evidence, unchanged.
--
-- Service role only, like v_job_profit. The two functions are read only. The trigger adds one small insert to a
-- job status change and can never fail one: an error in it is caught and logged as a warning, the way the
-- existing status trigger on jobs (jobs_open_job_work_order) does.
-- Rollback: supabase/rollbacks/20261115130000_job_cost_close_down.sql (drops the trigger and the record with it).

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.v_job_profit') IS NULL OR to_regclass('public.job_client_signoffs') IS NULL
     OR to_regclass('public.makesafe_job_details') IS NULL OR to_regclass('public.job_events') IS NULL
     OR to_regclass('public.job_assignments') IS NULL THEN
    RAISE EXCEPTION 'job cost close: v_job_profit, job_client_signoffs, makesafe_job_details, job_events or job_assignments is missing';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.jobs'::regclass AND NOT a.attisdropped AND a.attname = 'is_callback') <> 1
     OR (SELECT count(*) FROM pg_attribute a
          WHERE a.attrelid = 'public.job_assignments'::regclass AND NOT a.attisdropped
            AND a.attname IN ('job_id', 'status', 'scheduled_date', 'is_ghost', 'role')) <> 5 THEN
    RAISE EXCEPTION 'job cost close: jobs.is_callback or a job_assignments column the read needs is missing';
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
     OR NOT has_table_privilege('service_role', 'public.job_assignments', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.v_job_profit', 'SELECT') THEN
    RAISE EXCEPTION 'job cost close: the service role cannot read a table this reads';
  END IF;
END
$guard$;

-- The record of status moves. source: created (the job row was inserted), changed (its status changed),
-- baseline (where a job that already existed stood when the record began; not a move).
CREATE TABLE IF NOT EXISTS public.job_status_moves (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.jobs (id) ON DELETE CASCADE,
  from_status text,
  to_status text,
  source text NOT NULL CHECK (source IN ('created', 'changed', 'baseline')),
  moved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_status_moves_job_moved_idx ON public.job_status_moves (job_id, moved_at);

COMMENT ON TABLE public.job_status_moves IS
  'Job cost close (20261115130000): the database''s own record of job status moves. One row each time a job row is created (source created) or its status changes (source changed, from_status and to_status), written by trigger on jobs whoever makes the change. One baseline row per job that existed when the record began: where it stood then, not a move. Rows are never changed. Read by job_cost_close. Service role reads only; nothing else reads or writes it.';

ALTER TABLE public.job_status_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.job_status_moves FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.job_status_moves TO service_role;

-- Runs with its owner's rights so a status change made by any role is recorded. It can never fail the change:
-- an error here is caught and logged.
CREATE OR REPLACE FUNCTION public.jobs_record_status_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $move$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.job_status_moves (job_id, from_status, to_status, source)
      VALUES (NEW.id, NULL, NEW.status, 'created');
    ELSE
      INSERT INTO public.job_status_moves (job_id, from_status, to_status, source)
      VALUES (NEW.id, OLD.status, NEW.status, 'changed');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'job status move not recorded for job %: SQLSTATE %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END;
$move$;

COMMENT ON FUNCTION public.jobs_record_status_move() IS
  'Job cost close (20261115130000): trigger on jobs. Writes one job_status_moves row when a job is created and one each time its status changes. Never fails the change it records.';

REVOKE ALL ON FUNCTION public.jobs_record_status_move() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_jobs_record_status_created ON public.jobs;
CREATE TRIGGER trg_jobs_record_status_created
  AFTER INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_record_status_move();

DROP TRIGGER IF EXISTS trg_jobs_record_status_changed ON public.jobs;
CREATE TRIGGER trg_jobs_record_status_changed
  AFTER UPDATE ON public.jobs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.jobs_record_status_move();

-- Where every existing job stands as the record begins. The triggers above are already in place inside this
-- transaction and hold the table against writers until it commits, so no move falls between the two. A job
-- that already has a row (a second apply) gets no second baseline.
INSERT INTO public.job_status_moves (job_id, from_status, to_status, source)
SELECT j.id, NULL, j.status, 'baseline'
  FROM public.jobs j
 WHERE NOT EXISTS (SELECT 1 FROM public.job_status_moves m WHERE m.job_id = j.id);

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
    'status_events', jsonb_build_object('status_changed', NULL, 'status_change', NULL,
                                        'restoration_stage_changed', NULL, 'quote_accepted', 'accepted',
                                        'quote_run_declined', 'partially_accepted',
                                        'callback_opened', 'in_progress', 'callback_resolved', 'complete'),
    'reopen_event_types', jsonb_build_array('makesafe_reattend', 'quote_accepted', 'quote_run_declined',
                                            'callback_opened'),
    'reopen_note_prefix', 'Job reopened',
    'callback_opened_event', 'callback_opened',
    'callback_resolved_event', 'callback_resolved',
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
  'Job cost close (20261115130000): the numbers and lists job_cost_close reads. quiet_days: Perth days with no new cost, after the newer of the finish day and the last cost, before a finished job''s cost is final. finished_statuses: the statuses that finish a job with no repair stage; a day on the job never does by itself. did_not_go_ahead_statuses: cancelled or lost. reopened_statuses: never finished while here. invoice_marks_finished_types: work types whose first approved customer invoice marks the finish, only at a status in invoice_finish_statuses, never for a subtype in invoice_never_finishes_subtypes or a job with a restoration stage, never a job with a repair stage, never one reopened or past its first attendance. repair_finished_stages: values of jobs.metadata.repair_stage that mean the repair is finished. closed_statuses: statuses that finish a job carrying a repair stage whatever its stage. status_events: the job_events types that carry or imply a status move, each with the status it implies when the event names none (a restoration stage move names it job_status; a quote accepted, a quote run declined and a callback each set one). reopen_event_types and reopen_note_prefix: the job_events rows that put a job back to work whatever status they name (a re-attend, a quote accepted, a quote run declined, a callback opened, and a reopen note whose text starts with the prefix); each counts as a working move. callback_opened_event and callback_resolved_event: a job with a callback opened and none resolved after it is not finished. not_cost_reasons: Job Profit reasons that are not about cost and never hold a close. pending_cost_reasons: reasons that say a cost is still to come, so a cancelled or lost job carrying one is waiting, not out of scope. Change only by migration. Service role only.';

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
           p.pol -> 'status_events' AS status_events,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'reopen_event_types')) AS reopen_event_types,
           p.pol ->> 'reopen_note_prefix' AS reopen_note_prefix,
           p.pol ->> 'callback_opened_event' AS callback_opened_event,
           p.pol ->> 'callback_resolved_event' AS callback_resolved_event,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'not_cost_reasons')) AS not_cost_reasons,
           ARRAY(SELECT jsonb_array_elements_text(p.pol -> 'pending_cost_reasons')) AS pending_cost_reasons,
           COALESCE(p_as_of, (now() AT TIME ZONE 'Australia/Perth')::date) AS as_of
      FROM (SELECT public.job_cost_close_policy() AS pol) p
  ), moves AS (
    -- Every sign on record that a job's status moved, each marked: to a finished status or not, to a resting
    -- status or not, a return to work or not, out of a finished status or not. Read once, never per job.
    -- The application's events: those that carry or imply a status move (status_events). The writers name the
    -- new status new_status, to, status or job_status, and the old one old_status, from or prior_job_status;
    -- most name no old one, and then it is the status the last logged move set.
    -- An event in reopen_event_types, and a reopen note, is a return to work whatever status it names.
    SELECT e.job_id, e.created_at,
           NOT k.reopen AND COALESCE(st.to_status = ANY (pr.finished_statuses), false) AS to_finished,
           NOT k.reopen AND COALESCE(st.to_status = ANY (pr.invoice_finish_statuses), false) AS to_resting,
           k.reopen,
           COALESCE(st.from_status = ANY (pr.finished_statuses), false) AS from_finished,
           st.from_named AND COALESCE(st.from_status = ANY (pr.invoice_finish_statuses), false) AS from_resting_named
      FROM public.job_events e CROSS JOIN params pr
     CROSS JOIN LATERAL (
       SELECT COALESCE(e.event_type = ANY (pr.reopen_event_types), false)
              OR COALESCE(e.event_type = 'note'
                          AND left(e.detail_json ->> 'note', length(pr.reopen_note_prefix)) = pr.reopen_note_prefix,
                          false) AS reopen) k
     CROSS JOIN LATERAL (
       SELECT COALESCE(e.detail_json ->> 'new_status', e.detail_json ->> 'to', e.detail_json ->> 'status',
                       e.detail_json ->> 'job_status', pr.status_events ->> e.event_type) AS to_status,
              COALESCE(e.detail_json ->> 'old_status', e.detail_json ->> 'from',
                       e.detail_json ->> 'prior_job_status',
                       -- An event that names no old status left the status the last logged move set.
                       (SELECT COALESCE(p.detail_json ->> 'new_status', p.detail_json ->> 'to',
                                        p.detail_json ->> 'status', p.detail_json ->> 'job_status')
                          FROM public.job_events p
                         WHERE p.job_id = e.job_id AND p.created_at < e.created_at
                           AND p.event_type IN ('status_changed', 'status_change', 'restoration_stage_changed')
                         ORDER BY p.created_at DESC LIMIT 1)) AS from_status,
              COALESCE(e.detail_json ->> 'old_status', e.detail_json ->> 'from',
                       e.detail_json ->> 'prior_job_status') IS NOT NULL AS from_named) st
     WHERE (k.reopen OR (pr.status_events ? e.event_type AND st.to_status IS NOT NULL))
       AND (p_job_ids IS NULL OR e.job_id = ANY (p_job_ids))
    UNION ALL
    -- The database's own record, complete from the day it began. A baseline row is where a job stood that
    -- day and a created row where it stood when it was made: neither is a move.
    SELECT m.job_id, m.moved_at,
           COALESCE(m.to_status = ANY (pr.finished_statuses), false),
           COALESCE(m.to_status = ANY (pr.invoice_finish_statuses), false),
           false,
           COALESCE(m.from_status = ANY (pr.finished_statuses), false),
           COALESCE(m.from_status = ANY (pr.invoice_finish_statuses), false)
      FROM public.job_status_moves m CROSS JOIN params pr
     WHERE m.source = 'changed' AND m.to_status IS NOT NULL
       AND (p_job_ids IS NULL OR m.job_id = ANY (p_job_ids))
  ), worked AS (
    -- The last time the job's status moved to one that is not finished; the last working move for a job whose
    -- status is not its stage (a move to a status that is neither finished nor resting, a move out of a
    -- finished status wherever it lands, a reopen or a re-attend); and the last reopen or re-attend.
    SELECT m.job_id, max(m.created_at) AS back_to_work_at,
           max(m.created_at) FILTER (WHERE NOT m.to_resting OR m.from_finished) AS active_at,
           max(m.created_at) FILTER (WHERE m.reopen) AS reopened_at,
           max(m.created_at) FILTER (WHERE m.from_finished) AS left_finished_at,
           max(m.created_at) FILTER (WHERE NOT (m.to_resting AND m.from_resting_named)) AS unsettled_at
      FROM moves m WHERE NOT m.to_finished GROUP BY m.job_id
  ), refinished AS (
    -- The first move into a finished status at or after the last move to any status that is not finished.
    -- Two moves stamped the same instant have no order on record, so the finished one counts: where the
    -- job stands now decides whether it is finished at all, and this only dates it.
    SELECT m.job_id, min(m.created_at) AS refinished_at
      FROM moves m LEFT JOIN worked w ON w.job_id = m.job_id
     WHERE m.to_finished AND (w.back_to_work_at IS NULL OR m.created_at >= w.back_to_work_at)
     GROUP BY m.job_id
  ), callbacks AS (
    SELECT e.job_id,
           max(e.created_at) FILTER (WHERE e.event_type = pr.callback_opened_event) AS opened_at,
           max(e.created_at) FILTER (WHERE e.event_type = pr.callback_resolved_event) AS resolved_at
      FROM public.job_events e CROSS JOIN params pr
     WHERE e.event_type IN (pr.callback_opened_event, pr.callback_resolved_event)
       AND (p_job_ids IS NULL OR e.job_id = ANY (p_job_ids))
     GROUP BY e.job_id
  ), recorded AS (
    -- The day each job's status record began: its baseline row, or the row written when it was created.
    SELECT m.job_id, min(m.moved_at) AS recorded_from
      FROM public.job_status_moves m
     WHERE p_job_ids IS NULL OR m.job_id = ANY (p_job_ids)
     GROUP BY m.job_id
  ), staged AS (
    -- The last stage move to complete, and the last stage move to any other stage.
    SELECT e.job_id,
           max(e.created_at) FILTER (WHERE e.detail_json ->> 'to_stage' = ANY (pr.repair_finished_stages)) AS stage_done_at,
           max(e.created_at) FILTER (WHERE NOT COALESCE(e.detail_json ->> 'to_stage' = ANY (pr.repair_finished_stages), false)) AS stage_left_at
      FROM public.job_events e CROSS JOIN params pr
     WHERE e.event_type = 'repair_stage_changed'
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
           -- The history floor: no status move nobody recorded can be later than the day the job row last
           -- changed, or than the day its status record began. LEAST skips a null, so a job with no record at
           -- all is held to the day its row last changed.
           LEAST((j.updated_at AT TIME ZONE 'Australia/Perth')::date,
                 (rc.recorded_from AT TIME ZONE 'Australia/Perth')::date) AS history_floor_on,
           COALESCE(j.is_callback, false)
             OR COALESCE(cb.opened_at IS NOT NULL AND (cb.resolved_at IS NULL OR cb.resolved_at < cb.opened_at), false) AS callback_open,
           -- The latest day the records give: completed_at, or the newest sign-off not revoked since.
           -- GREATEST skips a null.
           GREATEST(j.completed_at,
                    (SELECT max(s.created_at)
                       FROM public.job_client_signoffs s
                      WHERE s.job_id = jp.job_id AND s.method <> 'revoked'
                        AND NOT EXISTS (SELECT 1 FROM public.job_client_signoffs r
                                         WHERE r.job_id = jp.job_id AND r.method = 'revoked'
                                           AND r.created_at >= s.created_at))) AS done_at,
           w.back_to_work_at, w.active_at, w.reopened_at, w.left_finished_at, w.unsettled_at,
           rf.refinished_at, sg.stage_done_at, sg.stage_left_at
      FROM public.v_job_profit jp
      JOIN public.jobs j ON j.id = jp.job_id
      LEFT JOIN public.makesafe_job_details d ON d.job_id = jp.job_id
      LEFT JOIN worked w ON w.job_id = jp.job_id
      LEFT JOIN refinished rf ON rf.job_id = jp.job_id
      LEFT JOIN staged sg ON sg.job_id = jp.job_id
      LEFT JOIN callbacks cb ON cb.job_id = jp.job_id
      LEFT JOIN recorded rc ON rc.job_id = jp.job_id
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
           iv.invoice_finish_on,
           -- A recorded day stands only while the status has not moved to a working one after it. The invoice
           -- carries a day and no time, so a working move on the invoice day itself leaves it standing (a
           -- make-safe is attended and invoiced on one day); a reopen or a re-attend on that day does not.
           s.done_at IS NOT NULL AND (wk.work_at IS NULL OR wk.work_at <= s.done_at) AS done_ok,
           -- The stage stands when no working move is on record, or the stage moved to complete at or after
           -- the last one. A complete stage with no stage move on record and a working move on record does
           -- not stand: their order is not known.
           COALESCE(s.repair_stage = ANY (pr.repair_finished_stages), false)
             AND (wk.work_at IS NULL OR (s.stage_done_at IS NOT NULL AND wk.work_at <= s.stage_done_at))
             AND (s.stage_left_at IS NULL OR (s.stage_done_at IS NOT NULL AND s.stage_left_at < s.stage_done_at)) AS stage_stands,
           -- A crew visit still to come: labour not yet worked.
           EXISTS (SELECT 1 FROM public.job_assignments a
                    WHERE a.job_id = s.job_id AND a.status IN ('scheduled', 'confirmed')
                      AND NOT COALESCE(a.is_ghost, false) AND COALESCE(a.role, '') <> 'observer'
                      AND a.scheduled_date >= pr.as_of) AS crew_due,
           iv.invoice_finish_on IS NOT NULL
             AND s.left_finished_at IS NULL
             AND (s.unsettled_at IS NULL OR (s.unsettled_at AT TIME ZONE 'Australia/Perth')::date <= iv.invoice_finish_on)
             AND (wk.work_at IS NULL OR (wk.work_at AT TIME ZONE 'Australia/Perth')::date <= iv.invoice_finish_on)
             AND (s.reopened_at IS NULL OR (s.reopened_at AT TIME ZONE 'Australia/Perth')::date < iv.invoice_finish_on) AS inv_ok,
           pr.pending_cost_reasons,
           ARRAY(SELECT u.r
                   FROM unnest(s.completeness || CASE WHEN s.cost_flag <> 'ok' THEN ARRAY[s.cost_flag] ELSE ARRAY[]::text[] END)
                        WITH ORDINALITY AS u(r, o)
                  WHERE u.r IS NOT NULL AND u.r <> ALL (pr.not_cost_reasons)
                  GROUP BY u.r
                  ORDER BY min(u.o)) AS cost_reasons
      FROM src s CROSS JOIN params pr
     -- The last working move. A make-safe or a job with a repair stage rests at accepted, scheduled or
     -- processing while it is finished (its status is not its stage), so a move there is not a return to work.
     -- For every other job any status that is not finished is.
     CROSS JOIN LATERAL (
       SELECT CASE WHEN s.work_type = ANY (pr.invoice_types) OR s.repair_stage IS NOT NULL
                   THEN s.active_at ELSE s.back_to_work_at END AS work_at) wk
     CROSS JOIN LATERAL (
       SELECT CASE WHEN s.work_type = ANY (pr.invoice_types) AND s.repair_stage IS NULL AND s.invoiced_ex > 0
                        AND s.first_attendance AND NOT s.has_restoration_stage
                        AND NOT EXISTS (SELECT 1 FROM unnest(pr.invoice_never_subtypes) n(sub)
                                         WHERE strpos(lower(COALESCE(s.work_subtype, '')), n.sub) > 0)
                   THEN s.first_invoice_date END AS invoice_finish_on) iv
  ), marked AS (
    SELECT r.*, r.cost_reasons && r.pending_cost_reasons AS cost_pending
      FROM reasoned r
  ), judged AS (
    -- Where the job stands now decides. A finish day alone finishes nothing. A repair is finished by its
    -- stage while the stage stands; one sent back to work after its stage reached complete is finished again
    -- only by a finished status. A job with a callback open, or a crew visit still to come, is not finished. An answer that cannot be worked
    -- out is not finished.
    SELECT m.*,
           COALESCE(CASE WHEN m.reopened OR m.callback_open OR m.crew_due THEN false
                         WHEN m.did_not_go_ahead THEN m.actual_cost_events > 0 OR m.cost_pending
                         WHEN m.has_stage THEN m.closed_status OR m.stage_stands
                                               OR (m.stage_finished AND m.finished_status)
                         ELSE m.finished_status OR (m.inv_ok AND m.invoice_status)
                    END, false) AS finished
      FROM marked m
  ), evidenced AS (
    -- Two days per finished job, each null when the records do not give it.
    --   done_on: the work day (completed_at or a sign-off), when it stands.
    --   base_on: the day the job came to stand where it stands.
    --     A repair whose stage stands: the day the stage moved to complete, when that move is on record; else
    --     the first move into a finished status after the last move out of one.
    --     A job at a finished status: that first move into a finished status, or for a make-safe whose invoice
    --     stands the invoice day when it is earlier (it has stood finished since the invoice, and putting the
    --     card away later does not restart the count).
    --     A make-safe finished by its invoice alone: the invoice day.
    SELECT j.*,
           CASE WHEN j.done_ok THEN (j.done_at AT TIME ZONE 'Australia/Perth')::date END AS done_on,
           CASE WHEN j.has_stage AND j.stage_stands AND j.stage_done_at IS NOT NULL
                  THEN (j.stage_done_at AT TIME ZONE 'Australia/Perth')::date
                WHEN j.has_stage OR NOT j.inv_ok THEN j.refinished_on
                WHEN j.finished_status THEN LEAST(j.invoice_finish_on, j.refinished_on)
                ELSE j.invoice_finish_on END AS base_on,
           CASE WHEN j.has_stage AND j.stage_stands AND (j.stage_done_at IS NOT NULL OR j.refinished_on IS NULL)
                  THEN 'repair_stage'
                WHEN j.has_stage OR NOT j.inv_ok THEN 'status'
                WHEN j.finished_status AND j.refinished_on < j.invoice_finish_on THEN 'status'
                ELSE 'first_invoice' END AS base_basis
      FROM (SELECT g.*, (g.refinished_at AT TIME ZONE 'Australia/Perth')::date AS refinished_on FROM judged g) j
  ), dated AS (
    -- The finish day is the later of the two, so a job is never dated before it came to stand where it stands.
    -- GREATEST skips a null; with neither day the job has no finish day.
    SELECT g.*,
           CASE WHEN NOT g.finished OR g.did_not_go_ahead THEN NULL::date
                ELSE GREATEST(g.done_on, g.base_on) END AS finished_on
      FROM evidenced g
  ), based AS (
    SELECT d.*,
           CASE WHEN NOT d.finished THEN NULL
                WHEN d.did_not_go_ahead THEN 'did_not_go_ahead'
                WHEN d.done_on IS NOT NULL AND (d.base_on IS NULL OR d.done_on >= d.base_on) THEN 'work_done'
                ELSE d.base_basis
           END AS finished_basis,
           -- The quiet count starts from the newest of the finish day, the last cost and the history floor.
           -- No finish day on record: count from the newer of the last cost and the day the record last changed.
           -- Without that day either, there is nothing to count from and the job waits.
           CASE WHEN d.finished_on IS NOT NULL THEN GREATEST(d.finished_on, d.last_cost_date, d.history_floor_on)
                WHEN d.last_cost_date IS NOT NULL AND d.record_changed_on IS NOT NULL
                  THEN GREATEST(d.last_cost_date, d.record_changed_on)
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
         CASE WHEN t.cost_state = 'waiting' AND cardinality(t.cost_reasons) = 0
                THEN ARRAY[CASE WHEN t.last_cost_date IS NULL THEN 'no_cost_date' ELSE 'no_finish_day' END]
              WHEN t.cost_state IN ('open', 'waiting') THEN t.cost_reasons
              ELSE ARRAY[]::text[] END AS waiting_on,
         t.actual_cost_ex,
         t.costs_verified_paid AS all_costs_paid,
         t.quiet_days, t.as_of, t.rule
    FROM stated t;
$fn$;

COMMENT ON FUNCTION public.job_cost_close(uuid[], date) IS
  'Job cost close (20261115130000): per job in v_job_profit, whether its cost is final. cost_state: not_applicable (holding job, or cancelled or lost with no cost and none still to come), open (work not finished, or in rectification), waiting (finished; waiting_on names what stands in the way), settling (finished, nothing outstanding, quiet for fewer than quiet_days; final_on is the day it turns final), final (final_on is the day it became final, closed_by the rule). Finished is where the job stands now (a finished status; for a job with a repair stage, stage complete or archived; or an approved invoice on a make-safe that is at a resting status, on its first attendance and not restoration work), never a day on the job alone. finished_on is the later of the work day (completed_at or a standing sign-off) and the day the job came to stand where it stands (the stage moving to complete, the make-safe''s first invoice, or the first move into a finished status after the last move out of one); a day stands only while the status has not moved to a working one after it, and an invoice that does not stand finishes nothing; with no day, the quiet count runs from the newer of the last cost and the day the job record last changed. A job with a callback open (jobs.is_callback or an unresolved callback_opened) or a crew visit booked on or after as_of is not finished. A make-safe once taken out of a finished status is finished again only by a finished status. Status moves are read from job_status_moves (the database''s own record, complete from the day it began) and from the application''s events before that; for the time before the record began, final_on is never earlier than quiet_days after the earlier of the day the job row last changed and the day its record began. Derived on every read from Job Profit''s row: a later cost or reason reopens it. waiting_on is Job Profit''s completeness and cost flag less the reasons that are not about cost; any cost flag other than ok holds a close. Says the cost is complete, not that every line is evidenced (job_profit_line_evidence). Null ids: every job. Null as_of: today in Perth; as_of moves only the day the quiet count is measured to, the costs, status and reasons are always today''s. Read only. Service role only.';

REVOKE ALL ON FUNCTION public.job_cost_close_policy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.job_cost_close(uuid[], date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_close_policy() TO service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_close(uuid[], date) TO service_role;
