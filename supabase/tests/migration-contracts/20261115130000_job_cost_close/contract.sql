-- Contract for 20261115130000_job_cost_close.sql. Synthetic jobs, no customer data. Every fixture write is inside a
-- transaction that rolls back. The answer key is written from how each job was built, never read off the function.
--
--   CC-01  fencing, complete 10 Aug, costs 20 Aug, invoiced     final on 19 Sep (last cost + 30); settling the day before
--   CC-02  fencing, complete 10 Aug, costs 20 Jul               final on 9 Sep (finish + 30: the finish is the newer day)
--   CC-03  fencing, complete, labour only                       waiting on materials_not_linked
--   CC-04  fencing, complete, no cost at all                    waiting on no_cost_linked (unknown, never a final $0)
--   CC-05  fencing, scheduled, costs on it                      open
--   CC-06  fencing, rectification, completed, clean costs       open (reopened work is never finished)
--   CC-07  fencing, cancelled, no cost                          not_applicable
--   CC-08  fencing, cancelled, costs, no customer invoice       final (a missing invoice is not a cost reason)
--   CC-09  make-safe, processing, invoiced 25 Aug, labour       final on 24 Sep, finished by its first invoice
--   CC-10  make-safe, processing, labour, no invoice            open
--   CC-11  repair, processing, repair stage on_site, invoiced   open (an invoice does not finish a repair)
--   CC-12  repair, accepted, repair stage complete, invoiced    final, finished by its repair stage, no finish day
--   CC-13  fencing, archived, never marked complete             final, finished by status, no finish day
--   CC-14  fencing, complete 10 Aug, client signed off 14 Aug   finished on 14 Aug (the later day)
--   CC-15  the holding job, costs on it                         not_applicable
--   CC-16  fencing, complete, clean costs, a priced open order  waiting on open_purchase_orders
--   CC-17  fencing, completed 10 Aug 17:00 UTC                  finished on 11 Aug (the Perth day)
--   CC-18  make-safe carrying a repair stage (scheduled), invoiced   open (the repair stage decides, not the invoice)
--  A day on the job never finishes it by itself (second review, 15 Nov 2026):
--   CC-19  fencing, scheduled, an old office sign-off, clean costs   open (the sign-off is from before it went back to work)
--   CC-20  fencing, in_progress, a stale completed_at, clean costs   open
--   CC-21  make-safe, accepted, invoiced, on its second attendance   open (the invoice belongs to the attendance before)
--   CC-22  make-safe, processing, invoiced, reopened at cycle 1      open
--   CC-23  make-safe, archived, on its second attendance             final, finished by status, no finish day
--   CC-24  fencing, complete 10 Aug, signed 15 Aug, revoked 18 Aug   finished on 10 Aug (a revoked sign-off is no sign-off)
--   CC-25  fencing, complete 10 Aug, signed, revoked, signed 12 Aug  finished on 12 Aug (the sign-off that stands)
--   CC-26  fencing, cancelled, no cost, a priced open order          waiting on open_purchase_orders (a cost is still to come)
--   CC-27  make-safe, complete 10 Aug (a status move that day), first attendance, invoiced 25 Aug
--                                                                    finished on 10 Aug by work_done (the status finishes it)
--   CC-28  repair, archived, repair stage on_site                    final, finished by status (archived puts the card away)
--  Third review, 15 Nov 2026:
--   CC-29  repair, invoiced, repair stage on_site                    open (the stage, not the status, is where a repair stands)
--   CC-30  make-safe, in_progress, invoiced, first attendance        open (an invoice finishes a make-safe only at a resting status)
--   CC-31  restoration make-safe, processing, invoiced               open (restoration is invoiced before its works)
--   CC-32  fencing, complete 10 Aug, rectification 1 Oct, complete 20 Oct, completed_at still 10 Aug
--                                                                    settling, finished on 20 Oct by status, final on 19 Nov
--   CC-33  fencing, complete 10 Nov, an old sign-off from 1 Feb      settling, finished on 10 Nov, final on 10 Dec
--   CC-34  fencing, archived, no day and no status move on record, record last changed 1 Nov
--                                                                    settling, no finish day, final on 1 Dec
--   CC-35  fencing, archived on 25 Oct by a status move, no completed_at   settling, finished on 25 Oct by status, final on 24 Nov
--   CC-36  repair, processing, stage moved to complete 28 Oct        settling, finished on 28 Oct by repair_stage, final on 27 Nov
--   CC-37  make-safe, archived 1 Nov, invoiced 25 Aug, moved to processing 26 Aug naming no old status
--                                                                    settling, finished on 1 Nov by status, final on 1 Dec
--          (the invoice no longer stands: a move nobody logged may lie before the 26 Aug one; CC-67 names it)
--                                                                    (putting an invoiced make-safe away does not restart its count)
--  Fourth review, 15 Nov 2026: a job is never dated before it came to stand where it stands.
--   CC-38  make-safe, complete, completed_at 10 Aug, no status move on record, invoiced 25 Aug
--                                                                    final on 24 Sep, finished on 25 Aug by first_invoice
--   CC-39  make-safe, invoiced 25 Aug, sent back to in_progress 20 Oct, complete 1 Nov
--                                                                    settling, finished on 1 Nov by status, final on 1 Dec
--   CC-40  repair, stage complete 1 Aug, rectification 20 Oct, complete 5 Nov, stage left at complete
--                                                                    settling, finished on 5 Nov by status, final on 5 Dec
--   CC-41  make-safe, invoiced 25 Aug, in_progress 20 Oct, back to scheduled 1 Nov, still cycle 1
--                                                                    open (the invoice is from before it went back to work)
--   CC-42  fencing, in_progress 1 Aug, completed_at 10 Aug while still in_progress, complete 10 Nov
--                                                                    settling, finished on 10 Nov by status, final on 10 Dec
--   CC-43  repair, stage complete 1 Aug, status moved to processing 5 Aug   final on 19 Sep, finished on 1 Aug by repair_stage
--                                                                    (a move to a resting status is not a return to work)
--   CC-44  make-safe, processing, invoiced 25 Aug, in_progress earlier that same day
--                                                                    final on 24 Sep by first_invoice (the invoice has a day, no time)
--   CC-45  fencing, done 10 Aug, moved to in_progress and to complete at the same instant on 1 Nov
--                                                                    settling, finished on 1 Nov by status, final on 1 Dec
--   CC-46  make-safe, complete 10 Aug, reopened 1 Nov (a note, no status move), invoiced status 10 Nov
--                                                                    settling, finished on 10 Nov by status, final on 10 Dec
--   CC-47  make-safe with no details row, complete 10 Aug, invoiced 25 Aug, reopened 10 Nov, now accepted
--                                                                    open (the reopen is on record)
--   CC-48  repair, stage complete 1 Aug, status sent back to in_progress 20 Oct, stage left at complete
--                                                                    open (the stage no longer stands)
--   CC-49  repair, stage complete 1 Aug, rectification 20 Oct, scheduled 1 Nov, stage left at complete
--                                                                    open
--   CC-50  make-safe, processing, invoiced 25 Aug, re-attended 1 Nov, details still say cycle 1
--                                                                    open (the re-attend is on record)
--   CC-51  make-safe whose family is "restoration works", processing, invoiced       open
--   CC-52  make-safe, processing, invoiced 25 Aug, re-attended that same day         open
--   CC-53  make-safe, processing, re-attended 1 Aug, first invoice 25 Aug            final on 24 Sep by first_invoice
--   CC-54  fencing, complete, the move to complete on 10 Nov written with the key "status"
--                                                                    settling, finished on 10 Nov by status, final on 10 Dec
--   CC-55  repair, processing, stage complete with no stage move on record, in_progress 1 Aug on record
--                                                                    open (their order is not known)
--   CC-56  repair, invoiced, stage complete with no stage move on record, in_progress 1 Aug, invoiced 10 Aug
--                                                                    final on 19 Sep, finished on 10 Aug by status
-- Writers that change a job's status and log something other than a status move (round 6):
--   CC-57  fencing, complete 10 Aug, callback opened 1 Nov, resolved 10 Nov (no status move logged)
--                                                                    settling, finished on 10 Nov by status, final on 10 Dec
--   CC-58  fencing, invoiced 15 Aug, callback opened 10 Nov and not resolved          open
--   CC-59  restoration make-safe, complete 10 Aug, stage to works 1 Nov (status in_progress), to closed 10 Nov
--          (status complete), both logged only as restoration stage moves
--                                                                    settling, finished on 10 Nov by status, final on 10 Dec
--   CC-60  fencing, complete 10 Aug, a new quote accepted 1 Oct, invoiced 10 Nov
--                                                                    settling, finished on 10 Nov by status, final on 10 Dec
--   CC-61  restoration make-safe, invoiced 10 Aug, stage back to works 1 Nov, to invoiced 10 Nov
--                                                                    settling, finished on 10 Nov by status, final on 10 Dec
--   CC-62  fencing, complete 10 Aug, row last changed 1 Nov, status record began 1 Nov (a job that existed
--          before the record)                                       settling, finished on 10 Aug, final on 1 Dec
--          (the history floor: a move nobody logged could be as late as 1 Nov)
--   CC-63  make-safe, invoiced 25 Aug, complete 5 Aug then scheduled 1 Sep, the move to scheduled naming no old
--          status                                                    open (it left a finished status after the invoice)
--   CC-64  make-safe, complete 25 Aug 09:00 Perth, back to scheduled 14:00 the same day (the move names no old
--          status), invoiced 25 Aug                                  open (taken out of a finished status)
--   CC-65  make-safe, complete 5 Aug, in_progress 10 Aug, scheduled 12 Aug, invoiced 25 Aug, cycle 1
--                                                                    open (an invoice after a send-back finishes nothing)
--   CC-66  make-safe, scheduled 1 Aug, invoiced 25 Aug, moved to processing 1 Sep naming no old status
--                                                                    open (a complete nobody logged may lie between)
--   CC-67  make-safe, invoiced 25 Aug, moved scheduled to processing 1 Sep with the old status named
--                                                                    final on 24 Sep by first_invoice
--   CC-68  repair, processing, stage complete 1 Aug, stage moved to on_site 1 Oct, stage now complete with no
--          later stage move on record                                open
--   CC-69  fencing, invoiced, done 10 Aug, flagged as a callback with no callback event      open
--   CC-70  fencing, complete, done 10 Aug, a crew visit booked for 20 Nov                    open
--          (CC-01 carries a ghost visit that day and stays final)
--   CC-71  fencing, complete, done 10 Aug, a crew visit on 14 Nov marked complete
--                                                                    settling, finished on 10 Aug, final on 14 Dec
--          (the visit's labour bill has 30 days to arrive)
--   CC-72  fencing, complete, done 10 Aug, a confirmed booking from 10 to 20 Nov            open
--   CC-73  fencing, complete, done 10 Aug, a crew clocked on 1 Nov and not off              open
--   CC-74  fencing, complete, done 10 Aug, a crew allocated with no day                     open
--   CC-75  fencing, complete, done 10 Aug, a Dispatch supplier order sent 1 Aug, no bill linked
--                                                                    waiting on dispatch_order_not_billed
--   CC-76  restoration make-safe, complete 10 Aug, its quote sent to the builder and not decided   open
--   CC-77  repair, complete, stage complete 1 Aug, moved to on_site 1 Nov, complete again with no stage move
--          on record                                                 settling, finished on 1 Nov by status, final 1 Dec
--   CC-78  fencing, complete, done 10 Aug, a bill dated 20 Aug placed on it on 14 Nov
--                                                                    settling, final 14 Dec (counted from when it landed)
--   CC-79  fencing, complete, done 10 Aug, a variation with a cost estimate approved 10 Nov, no cost since
--                                                                    waiting on variation_cost_not_in
--   CC-80  fencing, complete, done 10 Aug, a variation waiting for the client's approval   open
--   CC-81  fencing, complete, done 10 Aug, a crew work order accepted at 800 of labour, 500 on the job
--                                                                    waiting on work_order_not_billed
--   CC-82  fencing, cancelled, holding cost, a crew visit booked for 20 Nov                open
--   CC-83  fencing, complete, done 10 Aug, a Dispatch order sent 5 Nov, matched only by an older bill (5 Aug)
--                                                                    waiting on dispatch_order_not_billed
--   CC-84  fencing, complete, done 10 Aug, a variation approved 1 Sep and its cost in on 5 Sep
--                                                                    final 5 Oct
-- And the record itself (section 4): a status change by anyone writes a job_status_moves row naming both
-- statuses, and a make-safe taken from complete back to accepted is open again.

\set ON_ERROR_STOP on

-- 1. Shape, grants and policy.
DO $$
DECLARE fn regprocedure := 'public.job_cost_close(uuid[],date)'::regprocedure;
        pol regprocedure := 'public.job_cost_close_policy()'::regprocedure;
        p jsonb := public.job_cost_close_policy();
BEGIN
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
     OR has_function_privilege('anon', pol, 'EXECUTE') OR has_function_privilege('authenticated', pol, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fn, 'EXECUTE') OR NOT has_function_privilege('service_role', pol, 'EXECUTE') THEN
    RAISE EXCEPTION 'job cost close contract: the two functions must be the service role''s only';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = fn) <> 's' OR (SELECT prosecdef FROM pg_proc WHERE oid = fn) THEN
    RAISE EXCEPTION 'job cost close contract: job_cost_close must be a stable, invoker-rights read';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = fn) ~* '\m(insert|update|delete|truncate)\M' THEN
    RAISE EXCEPTION 'job cost close contract: job_cost_close must write nothing';
  END IF;
  IF obj_description(fn, 'pg_proc') NOT LIKE 'Job cost close (20261115130000): %'
     OR obj_description(pol, 'pg_proc') NOT LIKE 'Job cost close (20261115130000): %' THEN
    RAISE EXCEPTION 'job cost close contract: the comments do not name the slice';
  END IF;
  IF p ->> 'version' <> 'cost-close-v1' OR (p ->> 'quiet_days')::int <> 30
     OR p -> 'invoice_marks_finished_types' <> '["makesafe"]'::jsonb
     OR p -> 'repair_finished_stages' <> '["complete"]'::jsonb
     OR p -> 'invoice_finish_statuses' <> '["accepted", "scheduled", "processing"]'::jsonb
     OR p -> 'invoice_never_finishes_subtypes' <> '["restoration"]'::jsonb
     OR p -> 'closed_statuses' <> '["archived"]'::jsonb
     OR p -> 'reopen_event_types' <> '["makesafe_reattend", "quote_accepted", "quote_run_declined", "callback_opened"]'::jsonb
     OR p ->> 'reopen_note_prefix' <> 'Job reopened'
     OR p ->> 'callback_opened_event' <> 'callback_opened' OR p ->> 'callback_resolved_event' <> 'callback_resolved'
     OR NOT (p -> 'status_events') ?& ARRAY['status_changed', 'status_change', 'restoration_stage_changed',
                                           'quote_accepted', 'quote_run_declined', 'callback_opened', 'callback_resolved']
     OR p -> 'reopened_statuses' <> '["rectification"]'::jsonb
     OR p -> 'did_not_go_ahead_statuses' <> '["cancelled", "lost"]'::jsonb
     OR NOT (p -> 'finished_statuses') @> '["complete", "invoiced", "archived"]'::jsonb
     OR NOT (p -> 'not_cost_reasons') @> '["missing_client_invoice", "variation_not_invoiced"]'::jsonb
     OR NOT (p -> 'pending_cost_reasons') @> '["open_purchase_orders", "ordered_not_billed", "installer_bill_unconfirmed"]'::jsonb
     OR (p -> 'pending_cost_reasons') @> '["no_cost_linked"]'::jsonb
     OR NOT (p -> 'pending_cost_reasons') @> '["dispatch_order_not_billed", "work_order_not_billed", "variation_cost_not_in"]'::jsonb
     OR p -> 'variation_open_statuses' <> '["pending_approval", "sent"]'::jsonb
     OR NOT (p -> 'variation_dead_statuses') @> '["declined", "cancelled", "rejected"]'::jsonb
     OR NOT (p -> 'work_order_dead_statuses') @> '["draft", "cancelled", "declined", "rejected"]'::jsonb
     OR (p -> 'work_order_dead_statuses') @> '["complete"]'::jsonb
     OR (p ->> 'work_order_tolerance_ex')::numeric IS DISTINCT FROM 1
     OR (p ->> 'variation_cost_cover_share')::numeric IS DISTINCT FROM 0.5
     OR (p -> 'draft_bill_statuses') IS DISTINCT FROM '["DRAFT", "SUBMITTED"]'::jsonb
     OR NOT (p -> 'pending_cost_reasons') @> '["draft_bill_on_job"]'::jsonb
     OR (p -> 'not_cost_reasons') @> '["draft_bill_on_job"]'::jsonb
     OR (p -> 'not_cost_reasons') @> '["work_order_not_billed"]'::jsonb
     OR (p -> 'not_cost_reasons') @> '["variation_cost_not_in"]'::jsonb
     OR p -> 'restoration_open_quote_statuses' <> '["draft", "sent"]'::jsonb
     OR (p -> 'finished_statuses') @> '["in_progress"]'::jsonb
     OR (p -> 'finished_statuses') @> '["scheduled"]'::jsonb
     OR (p -> 'finished_statuses') @> '["accepted"]'::jsonb
     OR (p -> 'finished_statuses') @> '["processing"]'::jsonb
     OR (p -> 'not_cost_reasons') @> '["no_cost_linked"]'::jsonb
     OR (p -> 'not_cost_reasons') @> '["materials_not_linked"]'::jsonb THEN
    RAISE EXCEPTION 'job cost close contract: the policy is not cost-close-v1 as written: %', p;
  END IF;
  -- The record of status moves: the service role reads it and nothing else reads or writes it; the trigger
  -- function runs with its owner's rights and nobody may call it.
  IF to_regclass('public.job_status_moves') IS NULL
     OR has_table_privilege('anon', 'public.job_status_moves', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_status_moves', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.job_status_moves', 'SELECT')
     OR has_table_privilege('service_role', 'public.job_status_moves', 'INSERT')
     OR has_table_privilege('service_role', 'public.job_status_moves', 'UPDATE')
     OR has_table_privilege('service_role', 'public.job_status_moves', 'DELETE')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_status_moves'::regclass) THEN
    RAISE EXCEPTION 'job cost close contract: job_status_moves must be readable by the service role only, with row security on';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.jobs_record_status_move()'::regprocedure)
     OR has_function_privilege('anon', 'public.jobs_record_status_move()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.jobs_record_status_move()'::regprocedure, 'EXECUTE')
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass
           AND tgname IN ('trg_jobs_record_status_created', 'trg_jobs_record_status_changed') AND tgenabled <> 'D') <> 2 THEN
    RAISE EXCEPTION 'job cost close contract: the status trigger is not in place as written';
  END IF;
  -- Every job that existed when the record began has a row.
  IF EXISTS (SELECT 1 FROM public.jobs j WHERE NOT EXISTS (SELECT 1 FROM public.job_status_moves m WHERE m.job_id = j.id)) THEN
    RAISE EXCEPTION 'job cost close contract: a job has no status record';
  END IF;
  -- Job Profit itself is not touched.
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '578270db501761330fad0b46412aac95' THEN
    RAISE EXCEPTION 'job cost close contract: v_job_profit is not the definition this was written beside (md5 %)',
      md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END $$;

BEGIN;
SET LOCAL TimeZone = 'UTC';

-- updated_at is fixed at 1 Jul, before every cost, so a job with no finish day counts from its last cost
-- unless its case says otherwise (CC-34).
INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at, updated_at, completed_at)
SELECT ('cc000000-0000-4000-8000-0000000000' || lpad(v.n::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000001',
       v.status, v.type, 'CC-' || lpad(v.n::text, 2, '0'), false, v.meta::jsonb, '{}',
       CASE WHEN v.type = 'fencing'
            THEN '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}'::jsonb END,
       timestamptz '2026-07-01T00:00:00Z',
       CASE WHEN v.n IN (34, 62) THEN timestamptz '2026-11-01T02:00:00Z' ELSE timestamptz '2026-07-01T00:00:00Z' END,
       v.completed::timestamptz
FROM (VALUES
  (1,  'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (2,  'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (3,  'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (4,  'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (5,  'scheduled',     'fencing',  '{}', NULL),
  (6,  'rectification', 'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (7,  'cancelled',     'fencing',  '{}', NULL),
  (8,  'cancelled',     'fencing',  '{}', NULL),
  (9,  'processing',    'makesafe', '{}', NULL),
  (10, 'processing',    'makesafe', '{}', NULL),
  (11, 'processing',    'repair',   '{"repair_stage": "on_site"}', NULL),
  (12, 'accepted',      'repair',   '{"repair_stage": "complete"}', NULL),
  (13, 'archived',      'fencing',  '{}', NULL),
  (14, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (15, 'complete',      'fencing',  '{"do_not_schedule": "true"}', '2026-08-10T02:00:00Z'),
  (16, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (17, 'complete',      'fencing',  '{}', '2026-08-10T17:00:00Z'),
  (18, 'scheduled',     'makesafe', '{"repair_stage": "scheduled"}', NULL),
  (19, 'scheduled',     'fencing',  '{}', NULL),
  (20, 'in_progress',   'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (21, 'accepted',      'makesafe', '{}', NULL),
  (22, 'processing',    'makesafe', '{}', NULL),
  (23, 'archived',      'makesafe', '{}', NULL),
  (24, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (25, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (26, 'cancelled',     'fencing',  '{}', NULL),
  (27, 'complete',      'makesafe', '{}', '2026-08-10T02:00:00Z'),
  (28, 'archived',      'repair',   '{"repair_stage": "on_site"}', NULL),
  (29, 'invoiced',      'repair',   '{"repair_stage": "on_site"}', NULL),
  (30, 'in_progress',   'makesafe', '{}', NULL),
  (31, 'processing',    'makesafe', '{"ses_family": "restoration"}', NULL),
  (32, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (33, 'complete',      'fencing',  '{}', '2026-11-10T02:00:00Z'),
  (34, 'archived',      'fencing',  '{}', NULL),
  (35, 'archived',      'fencing',  '{}', NULL),
  (36, 'processing',    'repair',   '{"repair_stage": "complete"}', NULL),
  (37, 'archived',      'makesafe', '{}', NULL),
  (38, 'complete',      'makesafe', '{}', '2026-08-10T02:00:00Z'),
  (39, 'complete',      'makesafe', '{}', NULL),
  (40, 'complete',      'repair',   '{"repair_stage": "complete"}', NULL),
  (41, 'scheduled',     'makesafe', '{}', NULL),
  (42, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (43, 'processing',    'repair',   '{"repair_stage": "complete"}', NULL),
  (44, 'processing',    'makesafe', '{}', NULL),
  (45, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (46, 'invoiced',      'makesafe', '{}', NULL),
  (47, 'accepted',      'makesafe', '{}', NULL),
  (48, 'in_progress',   'repair',   '{"repair_stage": "complete"}', NULL),
  (49, 'scheduled',     'repair',   '{"repair_stage": "complete"}', NULL),
  (50, 'processing',    'makesafe', '{}', NULL),
  (51, 'processing',    'makesafe', '{"ses_family": "restoration works"}', NULL),
  (52, 'processing',    'makesafe', '{}', NULL),
  (53, 'processing',    'makesafe', '{}', NULL),
  (54, 'complete',      'fencing',  '{}', NULL),
  (55, 'processing',    'repair',   '{"repair_stage": "complete"}', NULL),
  (56, 'invoiced',      'repair',   '{"repair_stage": "complete"}', NULL),
  (57, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (58, 'invoiced',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (59, 'complete',      'makesafe', '{"ses_family": "restoration", "restoration_stage": {"stage": "closed"}}', '2026-08-10T02:00:00Z'),
  (60, 'invoiced',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (61, 'invoiced',      'makesafe', '{"ses_family": "restoration", "restoration_stage": {"stage": "invoiced"}}', NULL),
  (62, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (63, 'scheduled',     'makesafe', '{}', NULL),
  (64, 'scheduled',     'makesafe', '{}', NULL),
  (65, 'scheduled',     'makesafe', '{}', NULL),
  (66, 'processing',    'makesafe', '{}', NULL),
  (67, 'processing',    'makesafe', '{}', NULL),
  (68, 'processing',    'repair',   '{"repair_stage": "complete"}', NULL),
  (69, 'invoiced',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (70, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (71, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (72, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (73, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (74, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (75, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (76, 'complete',      'makesafe', '{"ses_family": "restoration", "restoration": {"mode": "assess_and_quote", "quotes": [{"revision": 1, "status": "sent"}]}}', '2026-08-10T02:00:00Z'),
  (77, 'complete',      'repair',   '{"repair_stage": "complete"}', NULL),
  (78, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (79, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (80, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (81, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (82, 'cancelled',     'fencing',  '{}', NULL),
  (83, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z'),
  (84, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z')
) AS v(n, status, type, meta, completed);
UPDATE public.jobs SET is_callback = true WHERE job_number = 'CC-69';
INSERT INTO public.job_assignments (job_id, status, scheduled_date, role, is_ghost) VALUES
  ('cc000000-0000-4000-8000-000000000070', 'scheduled', date '2026-11-20', 'lead', false),
  ('cc000000-0000-4000-8000-000000000001', 'scheduled', date '2026-11-20', 'observer', true),
  ('cc000000-0000-4000-8000-000000000071', 'complete',  date '2026-11-14', 'lead', false),
  ('cc000000-0000-4000-8000-000000000072', 'confirmed', date '2026-11-10', 'lead', false),
  ('cc000000-0000-4000-8000-000000000074', 'scheduled', NULL,              'lead', false);
UPDATE public.job_assignments SET scheduled_end = date '2026-11-20' WHERE job_id = 'cc000000-0000-4000-8000-000000000072';
INSERT INTO public.job_assignments (job_id, status, scheduled_date, role, is_ghost, clocked_on_at) VALUES
  ('cc000000-0000-4000-8000-000000000073', 'scheduled', date '2026-11-01', 'lead', false, timestamptz '2026-11-01T00:00:00Z');
INSERT INTO public.dispatch_supplier_order_emails (org_id, job_id, supplier_id, supplier_name, status, subject, sent_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'cc000000-0000-4000-8000-000000000075', gen_random_uuid(), 'CC Posts',
        'sent', 'Order for CC-75', timestamptz '2026-08-01T02:00:00Z');
INSERT INTO public.job_assignments (job_id, status, scheduled_date, role, is_ghost) VALUES
  ('cc000000-0000-4000-8000-000000000082', 'scheduled', date '2026-11-20', 'lead', false);
INSERT INTO public.job_variations (job_id, variation_number, description, amount, cost_estimate, status, accepted_at, approved_at) VALUES
  ('cc000000-0000-4000-8000-000000000079', 1, 'Extra gate', 1000, 600, 'approved',
   timestamptz '2026-11-10T02:00:00Z', timestamptz '2026-11-10T03:00:00Z'),
  ('cc000000-0000-4000-8000-000000000080', 1, 'Extra gate', 1000, 600, 'pending_approval', NULL, NULL),
  ('cc000000-0000-4000-8000-000000000084', 1, 'Extra panel', 400, 300, 'approved',
   timestamptz '2026-09-01T02:00:00Z', timestamptz '2026-09-01T03:00:00Z');
-- CC-81: a crew's work order accepted at 800 of labour (a job's own work order is approved by its own path).
INSERT INTO public.work_orders (org_id, job_id, status, kind, wo_number, agreed_labour_ex, scope_items, created_at, accepted_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'cc000000-0000-4000-8000-000000000081', 'accepted', 'crew', 'WO-CC-81', 800,
        '[]', timestamptz '2026-08-01T02:00:00Z', timestamptz '2026-08-02T02:00:00Z');
-- CC-83: a bill from August in Xero, its reference naming the job, and a replacement order sent from Dispatch on 5 Nov.
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, reference, created_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'CC-OLD-83', 'BO-CC-83', 'ACCPAY', 'PAID', 'CC Posts', 600, 660, date '2026-08-05',
        jsonb_build_array(jsonb_build_object('Description', 'Posts', 'AccountCode', '310', 'LineAmount', 600, 'TaxAmount', 60)),
        '{"LineAmountTypes": "Exclusive"}'::jsonb, 'CC-83', timestamptz '2026-08-06T02:00:00Z');
INSERT INTO public.dispatch_supplier_order_emails (org_id, job_id, supplier_id, supplier_name, status, subject, sent_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'cc000000-0000-4000-8000-000000000083', gen_random_uuid(), 'CC Posts',
        'sent', 'Order for CC-83', timestamptz '2026-11-05T02:00:00Z');

-- The trigger wrote a 'created' row for each job just now. A real job's row is written when it is created, so
-- date each one to its job's creation. CC-62 stands for a job that existed before the record began: its row is
-- the baseline written the day the record began.
UPDATE public.job_status_moves m SET moved_at = j.created_at
  FROM public.jobs j WHERE j.id = m.job_id AND j.job_number LIKE 'CC-%';
UPDATE public.job_status_moves SET source = 'baseline', moved_at = timestamptz '2026-11-01T02:00:00Z'
 WHERE job_id = 'cc000000-0000-4000-8000-000000000062';

-- Status and stage moves on record. Most jobs have none, as most of production's older jobs have none.
INSERT INTO public.job_events (job_id, event_type, detail_json, created_at) VALUES
  ('cc000000-0000-4000-8000-000000000032', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000032', 'status_changed', '{"new_status": "rectification"}', timestamptz '2026-10-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000032', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-10-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000032', 'status_changed', '{"new_status": "invoiced"}',      timestamptz '2026-10-22T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000033', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000033', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000035', 'status_change',  '{"from": "scheduled", "to": "archived"}', timestamptz '2026-10-25T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000036', 'repair_stage_changed', '{"from_stage": "on_site", "to_stage": "complete"}', timestamptz '2026-10-28T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000037', 'status_changed', '{"new_status": "processing"}',    timestamptz '2026-08-26T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000037', 'status_changed', '{"new_status": "archived"}',      timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000027', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000039', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-10-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000039', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000040', 'repair_stage_changed', '{"from_stage": "on_site", "to_stage": "complete"}', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000040', 'status_changed', '{"new_status": "rectification"}', timestamptz '2026-10-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000040', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-11-05T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000041', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-10-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000041', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000042', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000042', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000043', 'repair_stage_changed', '{"from_stage": "on_site", "to_stage": "complete"}', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000043', 'status_changed', '{"new_status": "processing"}',    timestamptz '2026-08-05T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000044', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-08-25T00:30:00Z'),
  ('cc000000-0000-4000-8000-000000000044', 'status_changed', '{"new_status": "processing"}',    timestamptz '2026-08-25T06:00:00Z'),
  ('cc000000-0000-4000-8000-000000000045', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000045', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-11-01T02:00:00Z'),
  -- A reopen and a re-attend put the job back to accepted and write no status move: a note and an event of their own.
  ('cc000000-0000-4000-8000-000000000046', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000046', 'note', '{"note": "Job reopened: builder asked us back", "cycle": 2, "reopened_by": "ops_dashboard", "draft_id": null}', timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000046', 'status_changed', '{"new_status": "invoiced"}',      timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000047', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000047', 'note', '{"note": "Job reopened: builder asked us back", "cycle": 2, "reopened_by": "ops_dashboard", "draft_id": null}', timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000048', 'repair_stage_changed', '{"from_stage": "on_site", "to_stage": "complete"}', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000048', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-10-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000049', 'repair_stage_changed', '{"from_stage": "on_site", "to_stage": "complete"}', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000049', 'status_changed', '{"new_status": "rectification"}', timestamptz '2026-10-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000049', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000050', 'makesafe_reattend', '{"reason": "Builder asked us back", "cycle_number": 2, "previous_status": "processing"}', timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000052', 'makesafe_reattend', '{"reason": "Builder asked us back", "cycle_number": 2, "previous_status": "processing"}', timestamptz '2026-08-25T00:30:00Z'),
  ('cc000000-0000-4000-8000-000000000053', 'makesafe_reattend', '{"reason": "Builder asked us back", "cycle_number": 2, "previous_status": "processing"}', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000054', 'status_change',  '{"status": "complete", "source": "trade_report"}', timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000055', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000056', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000056', 'status_changed', '{"new_status": "invoiced"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000057', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-07-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000057', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000057', 'callback_opened', '{"issue_description": "gate drags"}', timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000057', 'callback_resolved', '{"resolution_notes": "rehung"}',  timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000058', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000058', 'status_changed', '{"new_status": "invoiced"}',      timestamptz '2026-08-15T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000058', 'callback_opened', '{"issue_description": "post leaning"}', timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000059', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000059', 'restoration_stage_changed', '{"from_stage": "closed", "to_stage": "works", "job_status": "in_progress", "prior_job_status": "complete"}', timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000059', 'restoration_stage_changed', '{"from_stage": "works", "to_stage": "closed", "job_status": "complete", "prior_job_status": "in_progress"}', timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000060', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-07-20T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000060', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000060', 'quote_accepted', '{"document_id": null, "accepted_via": "share_link", "new_status": "accepted"}', timestamptz '2026-10-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000060', 'status_changed', '{"new_status": "invoiced"}',      timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000061', 'status_changed', '{"new_status": "invoiced"}',      timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000061', 'restoration_stage_changed', '{"from_stage": "invoiced", "to_stage": "works", "job_status": "in_progress"}', timestamptz '2026-11-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000061', 'restoration_stage_changed', '{"from_stage": "works", "to_stage": "invoiced", "job_status": "invoiced"}', timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000063', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-05T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000063', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-09-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000064', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-25T01:00:00Z'),
  ('cc000000-0000-4000-8000-000000000064', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-08-25T06:00:00Z'),
  ('cc000000-0000-4000-8000-000000000065', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-05T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000065', 'status_changed', '{"new_status": "in_progress"}',   timestamptz '2026-08-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000065', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-08-12T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000066', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000066', 'status_changed', '{"new_status": "processing"}',    timestamptz '2026-09-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000067', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000067', 'status_changed', '{"new_status": "processing", "old_status": "scheduled"}', timestamptz '2026-09-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000068', 'repair_stage_changed', '{"from_stage": "on_site", "to_stage": "complete"}', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000068', 'repair_stage_changed', '{"from_stage": "complete", "to_stage": "on_site"}', timestamptz '2026-10-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000077', 'repair_stage_changed', '{"from_stage": "on_site", "to_stage": "complete"}', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000077', 'repair_stage_changed', '{"from_stage": "complete", "to_stage": "on_site"}', timestamptz '2026-11-01T02:00:00Z'),
  -- A normal run through the finished statuses does not move the finish day: CC-01 was invoiced, then archived.
  ('cc000000-0000-4000-8000-000000000001', 'status_changed', '{"new_status": "scheduled"}',     timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000001', 'status_changed', '{"new_status": "complete"}',      timestamptz '2026-08-10T02:00:01Z'),
  ('cc000000-0000-4000-8000-000000000001', 'status_changed', '{"new_status": "invoiced"}',      timestamptz '2026-08-25T02:00:00Z');

-- Where each make-safe stands on its attendances. CC-09, CC-10 and CC-18 have no details row at all: that reads
-- as a first attendance.
INSERT INTO public.makesafe_job_details (job_id, cycle_number, reopen_reason) VALUES
  ('cc000000-0000-4000-8000-000000000021', 2, NULL),
  ('cc000000-0000-4000-8000-000000000022', 1, 'Builder asked us back'),
  ('cc000000-0000-4000-8000-000000000023', 2, NULL),
  ('cc000000-0000-4000-8000-000000000027', 1, NULL),
  ('cc000000-0000-4000-8000-000000000046', 2, 'Builder asked us back'),
  ('cc000000-0000-4000-8000-000000000050', 1, NULL);

-- Approved customer invoices, dated 25 Aug: every job (4 has no cost and is still invoiced) but 7, 8, 10 and 26.
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id)
SELECT '00000000-0000-0000-0000-000000000001', 'CC-S-' || right(j.job_number, 2), 'INV-CC-' || right(j.job_number, 2), 'ACCREC', 'AUTHORISED', 'CC Customer',
       2000, 2200, date '2026-08-25',
       jsonb_build_array(jsonb_build_object('Description', 'Work', 'AccountCode', '200', 'LineAmount', 2000, 'TaxAmount', 200)),
       '{"LineAmountTypes": "Exclusive"}'::jsonb, j.id
FROM public.jobs j WHERE j.job_number LIKE 'CC-%' AND j.job_number NOT IN ('CC-07', 'CC-08', 'CC-10', 'CC-26');

-- Costs a person placed. Labour 500 on every job with a cost; materials 600 on the fencing jobs but CC-03.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
SELECT j.id, 'CC-L-' || right(j.job_number, 2), 'BL-CC-' || right(j.job_number, 2), 'CC Installer', 'labour', 'actual', 500, 'high',
       CASE WHEN j.job_number = 'CC-02' THEN date '2026-07-20' ELSE date '2026-08-20' END, 'manual_queue'
FROM public.jobs j WHERE j.job_number LIKE 'CC-%' AND j.job_number NOT IN ('CC-04', 'CC-07', 'CC-26')
UNION ALL
SELECT j.id, 'CC-M-' || right(j.job_number, 2), 'BM-CC-' || right(j.job_number, 2), 'CC Steel', 'materials', 'actual', 600, 'high',
       CASE WHEN j.job_number = 'CC-02' THEN date '2026-07-20' ELSE date '2026-08-20' END, 'manual_queue'
FROM public.jobs j WHERE j.job_number LIKE 'CC-%' AND j.type = 'fencing' AND j.job_number NOT IN ('CC-03', 'CC-04', 'CC-07', 'CC-26');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source) VALUES
  ('cc000000-0000-4000-8000-000000000078', 'CC-LATE-78', 'BLT-CC-78', 'CC Steel', 'materials', 'actual', 900, 'high', date '2026-08-20', 'manual_queue'),
  ('cc000000-0000-4000-8000-000000000084', 'CC-VAR-84', 'BV-CC-84', 'CC Steel', 'materials', 'actual', 300, 'high', date '2026-09-05', 'manual_queue');
-- Each placement was made on the day of its cost: the cost reached its job that day. CC-78's August bill was
-- placed on 14 Nov.
UPDATE public.job_materials_facts SET created_at = fact_date::timestamptz + interval '2 hours' WHERE xero_invoice_id LIKE 'CC-%';
UPDATE public.job_materials_facts SET created_at = timestamptz '2026-11-14T02:00:00Z' WHERE xero_invoice_id = 'CC-LATE-78';

INSERT INTO public.job_client_signoffs (job_id, method, waiver_reason, captured_by_actor, created_at) VALUES
  ('cc000000-0000-4000-8000-000000000014', 'office_waiver', 'Customer away, office signed', 'contract@test', timestamptz '2026-08-14T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000033', 'office_waiver', 'Customer away, office signed', 'contract@test', timestamptz '2026-02-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000019', 'office_waiver', 'Customer away, office signed', 'contract@test', timestamptz '2026-08-03T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000024', 'office_waiver', 'Customer away, office signed', 'contract@test', timestamptz '2026-08-15T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000024', 'revoked',       NULL,                           'contract@test', timestamptz '2026-08-18T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000025', 'office_waiver', 'Customer away, office signed', 'contract@test', timestamptz '2026-08-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000025', 'revoked',       NULL,                           'contract@test', timestamptz '2026-08-03T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000025', 'office_waiver', 'Customer back, office signed', 'contract@test', timestamptz '2026-08-12T02:00:00Z');

-- CC-16 and CC-26: a priced order sent, delivery 10 days ago, no bill. Not overdue, still open.
INSERT INTO public.purchase_orders (id, org_id, job_id, po_number, supplier_name, source, status, subtotal, total, delivery_date, created_at, last_sent_at, invoice_received_at) VALUES
  ('cc100000-0000-4000-8000-000000000016', '00000000-0000-0000-0000-000000000001', 'cc000000-0000-4000-8000-000000000016', 'PO-CC-16', 'CC Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 10), now() - interval '12 days', now() - interval '12 days', NULL),
  ('cc100000-0000-4000-8000-000000000026', '00000000-0000-0000-0000-000000000001', 'cc000000-0000-4000-8000-000000000026', 'PO-CC-26', 'CC Timber', NULL, 'sent', 100, 110,
   ((now() AT TIME ZONE 'Australia/Perth')::date - 10), now() - interval '12 days', now() - interval '12 days', NULL);

-- 2. The answer key, as of 15 Nov 2026.
CREATE TEMP TABLE cc_key (job_number text, state text, final_on date, finished boolean, finished_on date, basis text, waits text) ON COMMIT DROP;
INSERT INTO cc_key VALUES
  ('CC-01', 'final',          '2026-09-19', true,  '2026-08-10', 'work_done',        NULL),
  ('CC-02', 'final',          '2026-09-09', true,  '2026-08-10', 'work_done',        NULL),
  ('CC-03', 'waiting',        NULL,         true,  '2026-08-10', 'work_done',        'materials_not_linked'),
  ('CC-04', 'waiting',        NULL,         true,  '2026-08-10', 'work_done',        'no_cost_linked'),
  ('CC-05', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-06', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-07', 'not_applicable', NULL,         false, NULL,         NULL,               NULL),
  ('CC-08', 'final',          '2026-09-19', true,  NULL,         'did_not_go_ahead', NULL),
  ('CC-09', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-10', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-11', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-12', 'final',          '2026-09-19', true,  NULL,         'repair_stage',     NULL),
  ('CC-13', 'final',          '2026-09-19', true,  NULL,         'status',           NULL),
  ('CC-14', 'final',          '2026-09-19', true,  '2026-08-14', 'work_done',        NULL),
  ('CC-15', 'not_applicable', NULL,         false, NULL,         NULL,               NULL),
  ('CC-16', 'waiting',        NULL,         true,  '2026-08-10', 'work_done',        'open_purchase_orders'),
  ('CC-17', 'final',          '2026-09-19', true,  '2026-08-11', 'work_done',        NULL),
  ('CC-18', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-19', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-20', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-21', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-22', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-23', 'final',          '2026-09-19', true,  NULL,         'status',           NULL),
  ('CC-24', 'final',          '2026-09-19', true,  '2026-08-10', 'work_done',        NULL),
  ('CC-25', 'final',          '2026-09-19', true,  '2026-08-12', 'work_done',        NULL),
  ('CC-26', 'waiting',        NULL,         true,  NULL,         'did_not_go_ahead', 'open_purchase_orders'),
  ('CC-27', 'final',          '2026-09-19', true,  '2026-08-10', 'work_done',        NULL),
  ('CC-28', 'final',          '2026-09-19', true,  NULL,         'status',           NULL),
  ('CC-29', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-30', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-31', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-32', 'settling',       '2026-11-19', true,  '2026-10-20', 'status',           NULL),
  ('CC-33', 'settling',       '2026-12-10', true,  '2026-11-10', 'work_done',        NULL),
  ('CC-34', 'settling',       '2026-12-01', true,  NULL,         'status',           NULL),
  ('CC-35', 'settling',       '2026-11-24', true,  '2026-10-25', 'status',           NULL),
  ('CC-36', 'settling',       '2026-11-27', true,  '2026-10-28', 'repair_stage',     NULL),
  ('CC-37', 'settling',       '2026-12-01', true,  '2026-11-01', 'status',           NULL),
  ('CC-38', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-39', 'settling',       '2026-12-01', true,  '2026-11-01', 'status',           NULL),
  ('CC-40', 'settling',       '2026-12-05', true,  '2026-11-05', 'status',           NULL),
  ('CC-41', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-42', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-43', 'final',          '2026-09-19', true,  '2026-08-01', 'repair_stage',     NULL),
  ('CC-44', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-45', 'settling',       '2026-12-01', true,  '2026-11-01', 'status',           NULL),
  ('CC-46', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-47', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-48', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-49', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-50', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-51', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-52', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-53', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-54', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-55', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-56', 'final',          '2026-09-19', true,  '2026-08-10', 'status',           NULL),
  ('CC-57', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-58', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-59', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-60', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-61', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-62', 'settling',       '2026-12-01', true,  '2026-08-10', 'work_done',        NULL),
  ('CC-63', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-64', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-65', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-66', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-67', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-68', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-69', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-70', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-71', 'settling',       '2026-12-14', true,  '2026-08-10', 'work_done',        NULL),
  ('CC-72', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-73', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-74', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-75', 'waiting',        NULL,         true,  '2026-08-10', 'work_done',        'dispatch_order_not_billed'),
  ('CC-76', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-77', 'settling',       '2026-12-01', true,  '2026-11-01', 'status',           NULL),
  ('CC-78', 'settling',       '2026-12-14', true,  '2026-08-10', 'work_done',        NULL),
  ('CC-79', 'waiting',        NULL,         true,  '2026-08-10', 'work_done',        'variation_cost_not_in'),
  ('CC-80', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-81', 'waiting',        NULL,         true,  '2026-08-10', 'work_done',        'work_order_not_billed'),
  ('CC-82', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-83', 'waiting',        NULL,         true,  '2026-08-10', 'work_done',        'dispatch_order_not_billed'),
  ('CC-84', 'final',          '2026-10-05', true,  '2026-08-10', 'work_done',        NULL);

DO $$
DECLARE r record; out text := ''; ids uuid[];
BEGIN
  SELECT array_agg(id) INTO ids FROM public.jobs WHERE job_number LIKE 'CC-%';
  FOR r IN
    SELECT k.*, c.cost_state, c.cost_final, c.final_on AS got_final_on, c.closed_by, c.finished AS got_finished,
           c.finished_on AS got_finished_on, c.finished_basis, c.waiting_on, c.last_cost_on, c.quiet_days, c.as_of, c.rule,
           c.actual_cost_ex, c.job_id
      FROM cc_key k LEFT JOIN public.job_cost_close(ids, date '2026-11-15') c ON c.job_number = k.job_number
     ORDER BY k.job_number
  LOOP
    IF r.job_id IS NULL THEN out := out || format('%s has no row; ', r.job_number); CONTINUE; END IF;
    IF r.cost_state IS DISTINCT FROM r.state THEN
      out := out || format('%s state %s, expected %s (waiting on %s); ', r.job_number, r.cost_state, r.state, r.waiting_on);
    END IF;
    IF r.cost_final IS DISTINCT FROM (r.state = 'final') THEN out := out || format('%s cost_final %s; ', r.job_number, r.cost_final); END IF;
    IF r.got_final_on IS DISTINCT FROM r.final_on THEN out := out || format('%s final_on %s, expected %s; ', r.job_number, r.got_final_on, r.final_on); END IF;
    IF r.closed_by IS DISTINCT FROM (CASE WHEN r.state = 'final' THEN 'rule:cost-close-v1' END) THEN
      out := out || format('%s closed_by %s; ', r.job_number, r.closed_by);
    END IF;
    IF r.got_finished IS DISTINCT FROM r.finished THEN out := out || format('%s finished %s; ', r.job_number, r.got_finished); END IF;
    IF r.got_finished_on IS DISTINCT FROM r.finished_on THEN out := out || format('%s finished_on %s, expected %s; ', r.job_number, r.got_finished_on, r.finished_on); END IF;
    IF r.finished_basis IS DISTINCT FROM r.basis THEN out := out || format('%s finished_basis %s, expected %s; ', r.job_number, r.finished_basis, r.basis); END IF;
    IF r.waits IS NOT NULL AND NOT (r.waits = ANY (r.waiting_on)) THEN
      out := out || format('%s waiting_on %s lacks %s; ', r.job_number, r.waiting_on, r.waits);
    END IF;
    IF r.state IN ('final', 'settling', 'not_applicable') AND cardinality(r.waiting_on) <> 0 THEN
      out := out || format('%s is %s yet waits on %s; ', r.job_number, r.state, r.waiting_on);
    END IF;
    IF r.state = 'waiting' AND cardinality(r.waiting_on) = 0 THEN out := out || format('%s waits on nothing named; ', r.job_number); END IF;
    IF 'missing_client_invoice' = ANY (r.waiting_on) OR 'holding_job' = ANY (r.waiting_on) THEN
      out := out || format('%s waits on a reason that is not about cost: %s; ', r.job_number, r.waiting_on);
    END IF;
    IF r.quiet_days <> 30 OR r.as_of <> date '2026-11-15' OR r.rule <> 'cost-close-v1' THEN
      out := out || format('%s quiet_days %s as_of %s rule %s; ', r.job_number, r.quiet_days, r.as_of, r.rule);
    END IF;
  END LOOP;
  IF out <> '' THEN RAISE EXCEPTION 'job cost close contract: %', out; END IF;

  -- The figure is Job Profit's own, and a job with no cost is never a final $0.
  IF (SELECT c.actual_cost_ex FROM public.job_cost_close(ids, date '2026-11-15') c WHERE c.job_number = 'CC-01')
     IS DISTINCT FROM (SELECT p.actual_cost_ex FROM public.v_job_profit p WHERE p.job_number = 'CC-01') THEN
    RAISE EXCEPTION 'job cost close contract: CC-01 actual cost is not Job Profit''s figure';
  END IF;
  IF (SELECT c.cost_final FROM public.job_cost_close(ids, date '2035-01-01') c WHERE c.job_number = 'CC-04') THEN
    RAISE EXCEPTION 'job cost close contract: CC-04 (no cost linked) became final with time';
  END IF;
END $$;

-- 3. The quiet count: settling until the 30th Perth day after the newer of finish and last cost, then final.
DO $$
DECLARE r record; one uuid[] := ARRAY['cc000000-0000-4000-8000-000000000001'::uuid];
BEGIN
  SELECT * INTO r FROM public.job_cost_close(one, date '2026-09-18');
  IF r.cost_state IS DISTINCT FROM 'settling' OR r.cost_final OR r.final_on IS DISTINCT FROM date '2026-09-19' OR r.closed_by IS NOT NULL THEN
    RAISE EXCEPTION 'job cost close contract: CC-01 on 18 Sep: % final_on % closed_by %', r.cost_state, r.final_on, r.closed_by;
  END IF;
  SELECT * INTO r FROM public.job_cost_close(one, date '2026-09-19');
  IF r.cost_state IS DISTINCT FROM 'final' OR NOT r.cost_final OR r.final_on IS DISTINCT FROM date '2026-09-19' THEN
    RAISE EXCEPTION 'job cost close contract: CC-01 on 19 Sep: % final_on %', r.cost_state, r.final_on;
  END IF;
  -- Only the job asked for comes back; null ids means every job; null as_of is today in Perth.
  IF (SELECT count(*) FROM public.job_cost_close(one, date '2026-09-19')) <> 1 THEN
    RAISE EXCEPTION 'job cost close contract: asked for one job, got another count';
  END IF;
  IF (SELECT count(*) FROM public.job_cost_close(NULL, date '2026-11-15') WHERE job_number LIKE 'CC-%') <> 84 THEN
    RAISE EXCEPTION 'job cost close contract: null ids did not return every job';
  END IF;
  IF (SELECT count(*) FROM public.job_cost_close()) <> (SELECT count(*) FROM public.v_job_profit) THEN
    RAISE EXCEPTION 'job cost close contract: the default read is not one row per Job Profit job';
  END IF;
  -- No job goes from open to final in a day: CC-42 only reached a finished status on 10 Nov.
  IF (SELECT cost_state FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000042'::uuid], date '2026-12-09')) IS DISTINCT FROM 'settling'
     OR (SELECT cost_state FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000042'::uuid], date '2026-12-10')) IS DISTINCT FROM 'final' THEN
    RAISE EXCEPTION 'job cost close contract: CC-42 does not settle for 30 days from the day it reached a finished status';
  END IF;
  IF (SELECT as_of FROM public.job_cost_close(one)) IS DISTINCT FROM (now() AT TIME ZONE 'Australia/Perth')::date THEN
    RAISE EXCEPTION 'job cost close contract: the default as_of is not today in Perth';
  END IF;
END $$;

-- 4. Derived, never stored: a cost that lands later reopens a final job, a new reason holds it, and a job
--    sent back to work opens again whatever days it still carries.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source)
VALUES ('cc000000-0000-4000-8000-000000000001', 'CC-M2-01', 'BM2-CC-01', 'CC Steel', 'materials', 'actual', 50, 'high', date '2026-11-01', 'manual_queue');
UPDATE public.job_materials_facts SET created_at = timestamptz '2026-11-01T02:00:00Z' WHERE xero_invoice_id = 'CC-M2-01';
UPDATE public.jobs SET status = 'rectification' WHERE job_number = 'CC-13';
UPDATE public.jobs SET status = 'in_progress' WHERE job_number = 'CC-02';
UPDATE public.makesafe_job_details SET cycle_number = 2 WHERE job_id = 'cc000000-0000-4000-8000-000000000027';
-- CC-44 was final by its first invoice. Taken to complete and then back to accepted by a writer that logs nothing,
-- as the service role (ops-api's role).
SET LOCAL ROLE service_role;
UPDATE public.jobs SET status = 'complete' WHERE job_number = 'CC-44';
UPDATE public.jobs SET status = 'accepted' WHERE job_number = 'CC-44';
UPDATE public.jobs SET client_name = client_name WHERE job_number = 'CC-44';
-- CC-43 was final by its stage. Its stage moved back to on_site by a writer that logs nothing, then complete again.
UPDATE public.jobs SET metadata = jsonb_set(metadata, '{repair_stage}', '"on_site"') WHERE job_number = 'CC-43';
UPDATE public.jobs SET metadata = jsonb_set(metadata, '{repair_stage}', '"complete"') WHERE job_number = 'CC-43';
RESET ROLE;
INSERT INTO public.makesafe_job_details (job_id, cycle_number, reopen_reason)
VALUES ('cc000000-0000-4000-8000-000000000009', 1, 'Builder asked us back');
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000001'::uuid], date '2026-11-15');
  IF r.cost_state IS DISTINCT FROM 'settling' OR r.final_on IS DISTINCT FROM date '2026-12-01' OR r.last_cost_on IS DISTINCT FROM date '2026-11-01'
     OR r.actual_cost_ex IS DISTINCT FROM 1150::numeric THEN
    RAISE EXCEPTION 'job cost close contract: CC-01 after a late cost: % final_on % last cost % cost %', r.cost_state, r.final_on, r.last_cost_on, r.actual_cost_ex;
  END IF;
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000013'::uuid], date '2026-11-15');
  IF r.cost_state IS DISTINCT FROM 'open' OR r.finished THEN
    RAISE EXCEPTION 'job cost close contract: CC-13 moved to rectification: % finished %', r.cost_state, r.finished;
  END IF;
  -- CC-02 was final on its completed_at. Back at in_progress it is open, and the old day finishes nothing.
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000002'::uuid], date '2026-11-15');
  IF r.cost_state IS DISTINCT FROM 'open' OR r.finished OR r.finished_on IS NOT NULL OR r.final_on IS NOT NULL THEN
    RAISE EXCEPTION 'job cost close contract: CC-02 sent back to in_progress: % finished % on %', r.cost_state, r.finished, r.finished_on;
  END IF;
  -- CC-09 was final by its first invoice. Reopened, the invoice no longer finishes it.
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000009'::uuid], date '2026-11-15');
  IF r.cost_state IS DISTINCT FROM 'open' OR r.finished THEN
    RAISE EXCEPTION 'job cost close contract: CC-09 reopened: % finished %', r.cost_state, r.finished;
  END IF;
  -- The record: a created row and two changed rows for CC-44, each naming both statuses; an update that left
  -- the status alone wrote nothing.
  IF (SELECT string_agg(source || ':' || COALESCE(from_status, '-') || '>' || to_status, ',' ORDER BY id)
        FROM public.job_status_moves WHERE job_id = 'cc000000-0000-4000-8000-000000000044')
     IS DISTINCT FROM 'created:->processing,changed:processing>complete,changed:complete>accepted' THEN
    RAISE EXCEPTION 'job cost close contract: CC-44''s status record is %',
      (SELECT string_agg(source || ':' || COALESCE(from_status, '-') || '>' || to_status, ',' ORDER BY id)
         FROM public.job_status_moves WHERE job_id = 'cc000000-0000-4000-8000-000000000044');
  END IF;
  -- CC-43: two stage rows in the record. Its stage left complete after it last reached complete on record (the
  -- record stamps both moves the same instant, and the move back to complete comes after it only in the record's
  -- order), so the stage no longer stands and its status, processing, does not finish it.
  IF (SELECT string_agg(COALESCE(from_status, '-') || '>' || to_status, ',' ORDER BY id)
        FROM public.job_status_moves WHERE job_id = 'cc000000-0000-4000-8000-000000000043' AND source = 'repair_stage')
     IS DISTINCT FROM 'complete>on_site,on_site>complete' THEN
    RAISE EXCEPTION 'job cost close contract: CC-43''s stage record is wrong';
  END IF;
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000043'::uuid], date '2026-11-15');
  IF r.cost_state = 'final' THEN
    RAISE EXCEPTION 'job cost close contract: CC-43 reads final after its stage moved back with no event';
  END IF;
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000044'::uuid], date '2026-11-15');
  IF r.cost_state IS DISTINCT FROM 'open' OR r.finished THEN
    RAISE EXCEPTION 'job cost close contract: CC-44 back at accepted from complete: % finished %', r.cost_state, r.finished;
  END IF;
  -- CC-27 is at complete: a second attendance does not open it, its status still finishes it.
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000027'::uuid], date '2026-11-15');
  IF r.cost_state IS DISTINCT FROM 'final' OR r.finished_basis IS DISTINCT FROM 'work_done' THEN
    RAISE EXCEPTION 'job cost close contract: CC-27 at complete on a second attendance: % by %', r.cost_state, r.finished_basis;
  END IF;
END $$;

-- 4b. Ninth review: CC-85 to CC-91.
--   CC-85  a crew work order agreed at 2000, 500 of labour counted, and a 1500 installer bill on the job that a
--          person marked not job related (Job Profit does not count it): waiting on the work order
--   CC-86  the same without that bill (control)
--   CC-87  a costed variation (600) agreed hours after a small late bill landed the same Perth day, no cost since
--   CC-88  the same, agreed the next day (control)
--   CC-89  cancelled after a crew attended on 10 Nov, no bill yet: its labour bill has 30 days to arrive
--   CC-90  a costed variation agreed 10 Nov and only an unrelated 5 placed since: not its cost
--   CC-91  a staff variation auto-approved 14 Nov (no accepted or approved time) with a cost estimate, no cost
INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at, updated_at, completed_at)
SELECT ('cc000000-0000-4000-8000-0000000000' || lpad(v.n::text, 2, '0'))::uuid, '00000000-0000-0000-0000-000000000001',
       v.status, 'fencing', 'CC-' || lpad(v.n::text, 2, '0'), false, '{}'::jsonb, '{}',
       '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}'::jsonb,
       timestamptz '2026-07-01T00:00:00Z', timestamptz '2026-07-01T00:00:00Z', v.completed::timestamptz
FROM (VALUES
  (85, 'complete',  '2026-08-10T02:00:00Z'),   -- WO 2000 agreed, 500 labour actual, 1500 installer bill marked not job related
  (86, 'complete',  '2026-08-10T02:00:00Z'),   -- control: same without the not-job-related bill
  (87, 'complete',  '2026-08-10T02:00:00Z'),   -- costed variation agreed the same Perth day the last cost landed
  (88, 'complete',  '2026-08-10T02:00:00Z'),   -- control: agreed the next day
  (89, 'cancelled', NULL),                     -- cancelled after a crew attended on 10 Nov, no bill yet
  (90, 'complete',  '2026-08-10T02:00:00Z'),   -- costed variation agreed 10 Nov, an unrelated small cost lands 12 Nov
  (91, 'complete',  '2026-08-10T02:00:00Z')    -- a staff variation auto approved 14 Nov with a cost estimate, no cost
) AS v(n, status, completed);
UPDATE public.job_status_moves m SET moved_at = j.created_at FROM public.jobs j
 WHERE j.id = m.job_id AND j.job_number IN ('CC-85','CC-86','CC-87','CC-88','CC-89','CC-90','CC-91');

-- Customer invoices on the jobs that went ahead.
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, created_at)
SELECT '00000000-0000-0000-0000-000000000001', 'CC9-S-' || right(j.job_number, 2), 'INV-CC9-' || right(j.job_number, 2), 'ACCREC', 'AUTHORISED', 'CC Customer',
       3000, 3300, date '2026-08-25',
       jsonb_build_array(jsonb_build_object('Description', 'Work', 'AccountCode', '200', 'LineAmount', 3000, 'TaxAmount', 300)),
       '{"LineAmountTypes": "Exclusive"}'::jsonb, j.id, timestamptz '2026-08-25T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-85','CC-86','CC-87','CC-88','CC-89','CC-90','CC-91') AND j.status <> 'cancelled';

-- Labour 500 and materials 600 placed on 20 Aug on every job that went ahead.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source, created_at)
SELECT j.id, 'CC9-L-' || right(j.job_number, 2), 'BL-CC9-' || right(j.job_number, 2), 'CC Installer', 'labour', 'actual', 500, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-08-20T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-85','CC-86','CC-87','CC-88','CC-89','CC-90','CC-91') AND j.status <> 'cancelled'
UNION ALL
SELECT j.id, 'CC9-M-' || right(j.job_number, 2), 'BM-CC9-' || right(j.job_number, 2), 'CC Steel', 'materials', 'actual', 600, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-08-20T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-85','CC-86','CC-87','CC-88','CC-89','CC-90','CC-91') AND j.status <> 'cancelled';

-- CC-85 / CC-86: a crew work order accepted at 2000 of labour; 500 of labour is on each job.
INSERT INTO public.work_orders (org_id, job_id, status, kind, wo_number, agreed_labour_ex, scope_items, created_at, accepted_at)
SELECT '00000000-0000-0000-0000-000000000001', j.id, 'accepted', 'crew', 'WO-' || j.job_number, 2000, '[]',
       timestamptz '2026-08-01T02:00:00Z', timestamptz '2026-08-02T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-85', 'CC-86');
-- CC-85 only: an installer bill (account 306) linked to the job in Xero, which a person marked not job related.
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, created_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'CC9-NJR-01', 'BI-CC-85', 'ACCPAY', 'AUTHORISED', 'Other Installer', 1500, 1650, date '2026-08-20',
        jsonb_build_array(jsonb_build_object('LineItemID', 'li-1', 'Description', 'Install labour', 'AccountCode', '306', 'LineAmount', 1500, 'TaxAmount', 150)),
        '{"LineAmountTypes": "Exclusive"}'::jsonb, 'cc000000-0000-4000-8000-000000000085', timestamptz '2026-08-20T02:00:00Z');
INSERT INTO public.materials_reconciliation_queue (xero_invoice_id, invoice_number, sub_total, status, closed_reason)
VALUES ('CC9-NJR-01', 'BI-CC-85', 1500, 'not_job_related', 'not ours');

-- CC-87: a late bill placed on 10 Nov 02:00 UTC (10 Nov Perth), a costed variation approved 10 Nov 06:00 UTC.
-- CC-88: the same, the variation approved 11 Nov.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source, created_at) VALUES
  ('cc000000-0000-4000-8000-000000000087', 'CC9-LATE-03', 'BLT-CC-87', 'CC Steel', 'materials', 'actual', 90, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-11-10T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000088', 'CC9-LATE-04', 'BLT-CC-88', 'CC Steel', 'materials', 'actual', 90, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-11-10T02:00:00Z');
INSERT INTO public.job_variations (job_id, variation_number, description, amount, cost_estimate, status, accepted_at, approved_at) VALUES
  ('cc000000-0000-4000-8000-000000000087', 1, 'Extra gate', 1000, 600, 'approved', timestamptz '2026-11-10T05:00:00Z', timestamptz '2026-11-10T06:00:00Z'),
  ('cc000000-0000-4000-8000-000000000088', 1, 'Extra gate', 1000, 600, 'approved', timestamptz '2026-11-11T05:00:00Z', timestamptz '2026-11-11T06:00:00Z'),
  ('cc000000-0000-4000-8000-000000000090', 1, 'Extra gate', 1000, 600, 'approved', timestamptz '2026-11-10T05:00:00Z', timestamptz '2026-11-10T06:00:00Z');
INSERT INTO public.job_variations (job_id, variation_number, description, amount, cost_estimate, status, created_at) VALUES
  ('cc000000-0000-4000-8000-000000000091', 1, 'Extra post', 180, 120, 'auto_approved', timestamptz '2026-11-14T02:00:00Z');
-- CC-90: a small negative materials adjustment (a refund) placed on 12 Nov, after the variation; no variation cost.
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source, created_at) VALUES
  ('cc000000-0000-4000-8000-000000000090', 'CC9-REF-06', 'BR-CC-90', 'CC Steel', 'materials', 'actual', 5, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-11-12T02:00:00Z');

-- CC-89: a crew attended on 10 Nov (clocked on and off, visit complete), then the job was cancelled. No bill yet.
INSERT INTO public.job_assignments (job_id, status, scheduled_date, role, is_ghost, clocked_on_at, clocked_off_at) VALUES
  ('cc000000-0000-4000-8000-000000000089', 'complete', date '2026-11-10', 'lead', false,
   timestamptz '2026-11-10T00:00:00Z', timestamptz '2026-11-10T08:00:00Z');


DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT e.n, e.st15, e.st16, e.why, c15.cost_state AS got15, c16.cost_state AS got16, c15.waiting_on AS w15
      FROM (VALUES ('CC-85', 'waiting', 'waiting', 'work_order_not_billed'),
                   ('CC-86', 'waiting', 'waiting', 'work_order_not_billed'),
                   ('CC-87', 'waiting', 'waiting', 'variation_cost_not_in'),
                   ('CC-88', 'waiting', 'waiting', 'variation_cost_not_in'),
                   ('CC-89', 'open',    'not_applicable', NULL),
                   ('CC-90', 'waiting', 'waiting', 'variation_cost_not_in'),
                   ('CC-91', 'waiting', 'waiting', 'variation_cost_not_in')) AS e(n, st15, st16, why)
      JOIN public.jobs j ON j.job_number = e.n
      CROSS JOIN LATERAL public.job_cost_close(ARRAY[j.id], date '2026-11-15') c15
      CROSS JOIN LATERAL public.job_cost_close(ARRAY[j.id], date '2026-12-16') c16
  LOOP
    IF r.got15 IS DISTINCT FROM r.st15 OR r.got16 IS DISTINCT FROM r.st16
       OR (r.why IS NOT NULL AND NOT (r.why = ANY (r.w15))) THEN
      RAISE EXCEPTION '% state % on 15 Nov and % on 16 Dec, expected % and %, waiting on % (expected %)',
        r.n, r.got15, r.got16, r.st15, r.st16, r.w15, r.why;
    END IF;
  END LOOP;
END $$;

-- 4c. Tenth review: CC-92 to CC-97.
--   CC-92  a supplier bill still at DRAFT in Xero, linked to the job since 25 Aug: waiting on it
--   CC-93  a DRAFT bill linked to no job whose line names the job's number (SWF-299093): waiting on it
--   CC-94  a bill linked since 25 Aug that Xero last changed on 10 Nov (approved then): settling from 10 Nov
--   CC-95  two costed variations (1000 each) agreed 1 Oct and 600 of cost since: one cost covers one variation
--   CC-96  a costed variation agreed 1 Oct with 600 since, another agreed 1 Nov with 600 since: each covered
--   CC-97  a DRAFT bill of nothing (total 0) linked to the job: no reason (control)
INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at, updated_at, completed_at)
SELECT ('cc000000-0000-4000-8000-0000000000' || v.n::text)::uuid, '00000000-0000-0000-0000-000000000001',
       'complete', 'fencing', v.num, false, '{}'::jsonb, '{}',
       '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}'::jsonb,
       timestamptz '2026-07-01T00:00:00Z', timestamptz '2026-07-01T00:00:00Z', timestamptz '2026-08-10T02:00:00Z'
FROM (VALUES (92, 'CC-92'), (93, 'SWF-299093'), (94, 'CC-94'), (95, 'CC-95'), (96, 'CC-96'), (97, 'CC-97')) AS v(n, num);
UPDATE public.job_status_moves m SET moved_at = j.created_at FROM public.jobs j
 WHERE j.id = m.job_id AND j.job_number IN ('CC-92','SWF-299093','CC-94','CC-95','CC-96','CC-97');

INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, created_at)
SELECT '00000000-0000-0000-0000-000000000001', 'CC10-S-' || right(j.id::text, 2), 'INV-CC10-' || right(j.id::text, 2), 'ACCREC', 'AUTHORISED', 'CC Customer',
       3000, 3300, date '2026-08-25',
       jsonb_build_array(jsonb_build_object('Description', 'Work', 'AccountCode', '200', 'LineAmount', 3000, 'TaxAmount', 300)),
       '{"LineAmountTypes": "Exclusive"}'::jsonb, j.id, timestamptz '2026-08-25T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-92','SWF-299093','CC-94','CC-95','CC-96','CC-97');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source, created_at)
SELECT j.id, 'CC10-L-' || right(j.id::text, 2), 'BL-CC10-' || right(j.id::text, 2), 'CC Installer', 'labour', 'actual', 500, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-08-20T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-92','SWF-299093','CC-94','CC-95','CC-96','CC-97')
UNION ALL
SELECT j.id, 'CC10-M-' || right(j.id::text, 2), 'BM-CC10-' || right(j.id::text, 2), 'CC Steel', 'materials', 'actual', 600, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-08-20T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-92','SWF-299093','CC-94','CC-95','CC-96','CC-97');

-- Supplier bills. The link stamp is set as xero-sync left it on 25 Aug, so the stamping trigger is held off.
ALTER TABLE public.xero_invoices DISABLE TRIGGER xero_invoices_job_linked_at;
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, reference, created_at, job_linked_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'CC10-DRAFT-92', 'BD-CC-92', 'ACCPAY', 'DRAFT', 'CC Steel', 2000, 2200, date '2026-08-24',
   jsonb_build_array(jsonb_build_object('LineItemID', 'li-92', 'Description', 'Steel', 'AccountCode', '310', 'LineAmount', 2000, 'TaxAmount', 200)),
   '{"LineAmountTypes": "Exclusive"}'::jsonb, 'cc000000-0000-4000-8000-000000000092', 'CC-92',
   timestamptz '2026-08-25T02:00:00Z', timestamptz '2026-08-25T02:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'CC10-DRAFT-93', 'BD-CC-93', 'ACCPAY', 'DRAFT', 'CC Steel', 800, 880, date '2026-08-24',
   jsonb_build_array(jsonb_build_object('LineItemID', 'li-93', 'Description', 'Steel for SWF-299093', 'AccountCode', '310', 'LineAmount', 800, 'TaxAmount', 80)),
   '{"LineAmountTypes": "Exclusive"}'::jsonb, NULL, NULL, timestamptz '2026-08-25T02:00:00Z', NULL),
  ('00000000-0000-0000-0000-000000000001', 'CC10-AUTH-94', 'BA-CC-94', 'ACCPAY', 'AUTHORISED', 'CC Steel', 400, 440, date '2026-08-24',
   jsonb_build_array(jsonb_build_object('LineItemID', 'li-94', 'Description', 'Steel', 'AccountCode', '310', 'LineAmount', 400, 'TaxAmount', 40)),
   jsonb_build_object('LineAmountTypes', 'Exclusive',
                      'UpdatedDateUTC', '/Date(' || (extract(epoch FROM timestamptz '2026-11-10T02:00:00Z') * 1000)::bigint || '+0000)/'),
   'cc000000-0000-4000-8000-000000000094', 'CC-94', timestamptz '2026-08-25T02:00:00Z', timestamptz '2026-08-25T02:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'CC10-DRAFT-97', 'BD-CC-97', 'ACCPAY', 'DRAFT', 'CC Steel', 0, 0, date '2026-08-24',
   '[]'::jsonb, '{"LineAmountTypes": "Exclusive"}'::jsonb, 'cc000000-0000-4000-8000-000000000097', 'CC-97',
   timestamptz '2026-08-25T02:00:00Z', timestamptz '2026-08-25T02:00:00Z');
ALTER TABLE public.xero_invoices ENABLE TRIGGER xero_invoices_job_linked_at;

-- CC-95: two variations of 1000 estimate agreed 1 Oct, 600 placed 5 Oct. CC-96: 1000 agreed 1 Oct with 600
-- placed 5 Oct, then 1000 agreed 1 Nov with 600 placed 5 Nov.
INSERT INTO public.job_variations (job_id, variation_number, description, amount, cost_estimate, status, accepted_at, approved_at) VALUES
  ('cc000000-0000-4000-8000-000000000095', 1, 'Extra gate', 1500, 1000, 'approved', timestamptz '2026-10-01T02:00:00Z', timestamptz '2026-10-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000095', 2, 'Extra run', 1500, 1000, 'approved', timestamptz '2026-10-01T02:00:00Z', timestamptz '2026-10-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000096', 1, 'Extra gate', 1500, 1000, 'approved', timestamptz '2026-10-01T02:00:00Z', timestamptz '2026-10-01T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000096', 2, 'Extra run', 1500, 1000, 'approved', timestamptz '2026-11-01T02:00:00Z', timestamptz '2026-11-01T02:00:00Z');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source, created_at) VALUES
  ('cc000000-0000-4000-8000-000000000095', 'CC10-V-95', 'BV-CC-95', 'CC Steel', 'materials', 'actual', 600, 'high', date '2026-10-05', 'manual_queue', timestamptz '2026-10-05T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000096', 'CC10-V-96a', 'BV-CC-96a', 'CC Steel', 'materials', 'actual', 600, 'high', date '2026-10-05', 'manual_queue', timestamptz '2026-10-05T02:00:00Z'),
  ('cc000000-0000-4000-8000-000000000096', 'CC10-V-96b', 'BV-CC-96b', 'CC Steel', 'materials', 'actual', 600, 'high', date '2026-11-05', 'manual_queue', timestamptz '2026-11-05T02:00:00Z');

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT e.n, e.st15, e.st16, e.why, c15.cost_state AS got15, c16.cost_state AS got16, c15.waiting_on AS w15
      FROM (VALUES ('CC-92',      'waiting',  'waiting', 'draft_bill_on_job'),
                   ('SWF-299093', 'waiting',  'waiting', 'draft_bill_on_job'),
                   ('CC-94',      'settling', 'final',   NULL),
                   ('CC-95',      'waiting',  'waiting', 'variation_cost_not_in'),
                   ('CC-96',      'settling', 'final',   NULL),
                   ('CC-97',      'final',    'final',   NULL)) AS e(n, st15, st16, why)
      JOIN public.jobs j ON j.job_number = e.n
      CROSS JOIN LATERAL public.job_cost_close(ARRAY[j.id], date '2026-11-15') c15
      CROSS JOIN LATERAL public.job_cost_close(ARRAY[j.id], date '2026-12-16') c16
  LOOP
    IF r.got15 IS DISTINCT FROM r.st15 OR r.got16 IS DISTINCT FROM r.st16
       OR (r.why IS NOT NULL AND NOT (r.why = ANY (r.w15))) THEN
      RAISE EXCEPTION '% state % on 15 Nov and % on 16 Dec, expected % and %, waiting on % (expected %)',
        r.n, r.got15, r.got16, r.st15, r.st16, r.w15, r.why;
    END IF;
  END LOOP;
  IF (SELECT final_on FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000094'::uuid], date '2026-11-15'))
     IS DISTINCT FROM date '2026-12-10' THEN
    RAISE EXCEPTION 'CC-94: a bill Xero last changed on 10 Nov must count from 10 Nov';
  END IF;
END $$;

-- 4d. Eleventh review: CC-98 and CC-99.
--   CC-98  a costed variation (600) agreed 1 Oct whose cost never comes; the only bill is a base bill dated
--          20 Aug that Xero last changed on 20 Oct (paid): it reached the job late but covers nothing, waiting
--   CC-99  a DRAFT crew bill mirrored from a trade invoice, linked to the job: Job Profit counts that labour
--          through the trade invoice, so no draft reason (final, like CC-97)
INSERT INTO public.jobs (id, org_id, status, type, job_number, legacy, metadata, pricing_json, expected_costs, created_at, updated_at, completed_at)
SELECT ('cc000000-0000-4000-8000-0000000000' || v.n::text)::uuid, '00000000-0000-0000-0000-000000000001',
       'complete', 'fencing', v.num, false, '{}'::jsonb, '{}',
       '{"lanes": {"labour": {"amount_ex_gst": 500}, "materials": {"amount_ex_gst": 700}, "commission": {"amount_ex_gst": 0}}}'::jsonb,
       timestamptz '2026-07-01T00:00:00Z', timestamptz '2026-07-01T00:00:00Z', timestamptz '2026-08-10T02:00:00Z'
FROM (VALUES (98, 'CC-98'), (99, 'CC-99')) AS v(n, num);
UPDATE public.job_status_moves m SET moved_at = j.created_at FROM public.jobs j
 WHERE j.id = m.job_id AND j.job_number IN ('CC-98', 'CC-99');
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, created_at)
SELECT '00000000-0000-0000-0000-000000000001', 'CC11-S-' || right(j.id::text, 2), 'INV-CC11-' || right(j.id::text, 2), 'ACCREC', 'AUTHORISED', 'CC Customer',
       3000, 3300, date '2026-08-25',
       jsonb_build_array(jsonb_build_object('Description', 'Work', 'AccountCode', '200', 'LineAmount', 3000, 'TaxAmount', 300)),
       '{"LineAmountTypes": "Exclusive"}'::jsonb, j.id, timestamptz '2026-08-25T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-98', 'CC-99');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source, created_at)
SELECT j.id, 'CC11-L-' || right(j.id::text, 2), 'BL-CC11-' || right(j.id::text, 2), 'CC Installer', 'labour', 'actual', 500, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-08-20T02:00:00Z'
FROM public.jobs j WHERE j.job_number IN ('CC-98', 'CC-99');
INSERT INTO public.job_materials_facts (job_id, xero_invoice_id, invoice_number, contact_name, lane, kind, amount_ex_gst, confidence, fact_date, automation_source, created_at)
SELECT j.id, 'CC11-M-' || right(j.id::text, 2), 'BM-CC11-' || right(j.id::text, 2), 'CC Steel', 'materials', 'actual', 600, 'high', date '2026-08-20', 'manual_queue', timestamptz '2026-08-20T02:00:00Z'
FROM public.jobs j WHERE j.job_number = 'CC-99';
ALTER TABLE public.xero_invoices DISABLE TRIGGER xero_invoices_job_linked_at;
INSERT INTO public.xero_invoices (org_id, xero_invoice_id, invoice_number, invoice_type, status, contact_name, sub_total, total, invoice_date, line_items, raw_json, job_id, reference, created_at, job_linked_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'CC11-PAID-98', 'BP-CC-98', 'ACCPAY', 'PAID', 'CC Steel', 700, 770, date '2026-08-20',
   jsonb_build_array(jsonb_build_object('LineItemID', 'li-98', 'Description', 'Steel', 'AccountCode', '310', 'LineAmount', 700, 'TaxAmount', 70)),
   jsonb_build_object('LineAmountTypes', 'Exclusive',
                      'UpdatedDateUTC', '/Date(' || (extract(epoch FROM timestamptz '2026-10-20T02:00:00Z') * 1000)::bigint || '+0000)/'),
   'cc000000-0000-4000-8000-000000000098', NULL, timestamptz '2026-08-20T02:00:00Z', timestamptz '2026-08-20T02:00:00Z'),
  ('00000000-0000-0000-0000-000000000001', 'CC11-CREW-99', 'BC-CC-99', 'ACCPAY', 'DRAFT', 'CC Installer', 500, 550, date '2026-08-24',
   jsonb_build_array(jsonb_build_object('LineItemID', 'li-99', 'Description', 'Labour CC-99', 'AccountCode', '306', 'LineAmount', 500, 'TaxAmount', 50)),
   '{"LineAmountTypes": "Exclusive"}'::jsonb, 'cc000000-0000-4000-8000-000000000099', 'CC-99',
   timestamptz '2026-08-25T02:00:00Z', timestamptz '2026-08-25T02:00:00Z');
ALTER TABLE public.xero_invoices ENABLE TRIGGER xero_invoices_job_linked_at;
INSERT INTO public.trade_invoices (xero_bill_id, status, subtotal_ex, gst, total_inc, gst_on, super_rate, super_amount, gross_earned, net_pay, super_basis)
VALUES ('CC11-CREW-99', 'pushed_to_xero', 500, 0, 500, false, 0.12, 60, 500, 500, 'employer_12_v2');
INSERT INTO public.job_variations (job_id, variation_number, description, amount, cost_estimate, status, accepted_at, approved_at) VALUES
  ('cc000000-0000-4000-8000-000000000098', 1, 'Extra gate', 1000, 600, 'approved', timestamptz '2026-10-01T02:00:00Z', timestamptz '2026-10-01T02:00:00Z');

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT e.n, e.st15, e.st16, e.why, c15.cost_state AS got15, c16.cost_state AS got16, c15.waiting_on AS w15
      FROM (VALUES ('CC-98', 'waiting',  'waiting', 'variation_cost_not_in'),
                   ('CC-99', 'final',    'final',   NULL)) AS e(n, st15, st16, why)
      JOIN public.jobs j ON j.job_number = e.n
      CROSS JOIN LATERAL public.job_cost_close(ARRAY[j.id], date '2026-11-15') c15
      CROSS JOIN LATERAL public.job_cost_close(ARRAY[j.id], date '2026-12-16') c16
  LOOP
    IF r.got15 IS DISTINCT FROM r.st15 OR r.got16 IS DISTINCT FROM r.st16
       OR (r.why IS NOT NULL AND NOT (r.why = ANY (r.w15)))
       OR (r.why IS NULL AND 'draft_bill_on_job' = ANY (r.w15)) THEN
      RAISE EXCEPTION '% state % on 15 Nov and % on 16 Dec, expected % and %, waiting on % (expected %)',
        r.n, r.got15, r.got16, r.st15, r.st16, r.w15, r.why;
    END IF;
  END LOOP;
END $$;

-- 5. The service role can read it; nothing was stored by reading.
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT cost_state FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000012'::uuid], date '2026-11-15')) IS DISTINCT FROM 'final' THEN
    RAISE EXCEPTION 'job cost close contract: the service role does not read CC-12 as final';
  END IF;
END $$;
RESET ROLE;
ROLLBACK;
