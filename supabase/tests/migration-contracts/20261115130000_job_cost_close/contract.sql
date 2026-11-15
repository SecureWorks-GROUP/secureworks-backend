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
--   CC-37  make-safe, archived 1 Nov, invoiced 25 Aug, moved to processing 26 Aug   final on 24 Sep by first_invoice
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
     OR p -> 'reopened_statuses' <> '["rectification"]'::jsonb
     OR p -> 'did_not_go_ahead_statuses' <> '["cancelled", "lost"]'::jsonb
     OR NOT (p -> 'finished_statuses') @> '["complete", "invoiced", "archived"]'::jsonb
     OR NOT (p -> 'not_cost_reasons') @> '["missing_client_invoice", "variation_not_invoiced"]'::jsonb
     OR NOT (p -> 'pending_cost_reasons') @> '["open_purchase_orders", "ordered_not_billed", "installer_bill_unconfirmed"]'::jsonb
     OR (p -> 'pending_cost_reasons') @> '["no_cost_linked"]'::jsonb
     OR (p -> 'finished_statuses') @> '["in_progress"]'::jsonb
     OR (p -> 'finished_statuses') @> '["scheduled"]'::jsonb
     OR (p -> 'finished_statuses') @> '["accepted"]'::jsonb
     OR (p -> 'finished_statuses') @> '["processing"]'::jsonb
     OR (p -> 'not_cost_reasons') @> '["no_cost_linked"]'::jsonb
     OR (p -> 'not_cost_reasons') @> '["materials_not_linked"]'::jsonb THEN
    RAISE EXCEPTION 'job cost close contract: the policy is not cost-close-v1 as written: %', p;
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
       CASE WHEN v.n = 34 THEN timestamptz '2026-11-01T02:00:00Z' ELSE timestamptz '2026-07-01T00:00:00Z' END,
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
  (45, 'complete',      'fencing',  '{}', '2026-08-10T02:00:00Z')
) AS v(n, status, type, meta, completed);

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
  ('cc000000-0000-4000-8000-000000000027', 1, NULL);

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
  ('CC-37', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-38', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-39', 'settling',       '2026-12-01', true,  '2026-11-01', 'status',           NULL),
  ('CC-40', 'settling',       '2026-12-05', true,  '2026-11-05', 'status',           NULL),
  ('CC-41', 'open',           NULL,         false, NULL,         NULL,               NULL),
  ('CC-42', 'settling',       '2026-12-10', true,  '2026-11-10', 'status',           NULL),
  ('CC-43', 'final',          '2026-09-19', true,  '2026-08-01', 'repair_stage',     NULL),
  ('CC-44', 'final',          '2026-09-24', true,  '2026-08-25', 'first_invoice',    NULL),
  ('CC-45', 'settling',       '2026-12-01', true,  '2026-11-01', 'status',           NULL);

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
  IF (SELECT count(*) FROM public.job_cost_close(NULL, date '2026-11-15') WHERE job_number LIKE 'CC-%') <> 45 THEN
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
UPDATE public.jobs SET status = 'rectification' WHERE job_number = 'CC-13';
UPDATE public.jobs SET status = 'in_progress' WHERE job_number = 'CC-02';
UPDATE public.makesafe_job_details SET cycle_number = 2 WHERE job_id = 'cc000000-0000-4000-8000-000000000027';
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
  -- CC-27 is at complete: a second attendance does not open it, its status still finishes it.
  SELECT * INTO r FROM public.job_cost_close(ARRAY['cc000000-0000-4000-8000-000000000027'::uuid], date '2026-11-15');
  IF r.cost_state IS DISTINCT FROM 'final' OR r.finished_basis IS DISTINCT FROM 'work_done' THEN
    RAISE EXCEPTION 'job cost close contract: CC-27 at complete on a second attendance: % by %', r.cost_state, r.finished_basis;
  END IF;
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
