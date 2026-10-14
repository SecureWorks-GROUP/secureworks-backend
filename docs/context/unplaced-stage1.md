# Unplaced stage 1: messages on no job

Migration `20261014170000_context_unplaced_stage1.sql` (rollback in
`supabase/rollbacks/`). Stage 1 of the permanent fix for rows with no job:
the 14 Oct 2026 diagnosis's items 1, 2 and 3 plus candidate ranking. Property
(several-jobs) placement, opening notes from held rows and the staff tool are
not here; they wait on owner calls.

All rules are on the rules-on ladder only (`context_unlinked_rules_v1`, on in
production). The migration moves no data: rows change only when inserted or
re-decided.

## What the ladder now does

| Rule (`metadata.placement_rule`) | When | Status |
|---|---|---|
| automated | `makesafe.reconcile.*` rows are machine records, never messages | `automated` |
| `link_ref` | a quote or variation link token (`token=<uuid>`) names the job (`context_link_ref_jobs`); joins our own references | `direct` |
| `builder_ref` | no reference of ours, and a builder purchase order or claim names exactly one job (`context_builder_ref_jobs`: PO wins when it sits on the named claim; whole digit runs) | `direct` |
| identity | our own outbound row reads its recipient (`payload.to`) in `context_event_identity`: one customer email, or with no email recipient one phone | then the usual rules |
| `ranked_open` / `ranked_recent` | a contact review (several, recent other job, aftercare), a text naming 2 to 5 of our jobs, or an exact address matching 2 to 3 jobs: closed, numberless and test jobs leave the set (`context_job_live`; a job with no number is a hidden old-system record); one live left places there, none live places on the most recently created numbered one, two or more live stay for review (`context_pick_ranked`). Identity conflicts and loose address matches are never ranked | `single_open` |
| `only_open_job` | a known customer with no candidate at the message time whose only live job is X | `single_open` |
| `job_party` | no CRM contact, and a live `job_contacts` party carries the row's email or phone: their one job, or their one live job | `single_open` |

A ranked placement is `single_open`, so it never makes a thread binding (only
proof may, X25). `metadata.placement_ranked_from` names the review rule it
replaced and `placement_ranked_below` the jobs it passed over.

## Re-decision on new evidence

`context_redecide_events(ids, reason, detail)` re-runs the ladder on rows with
no job that rest `admin_bucket` or `unplaced`, and writes only a placement or a
review case (`metadata.placement_redecided`). At most 200 rows and 2 seconds a
call; locked rows are skipped and counted. Callers:

- `event_threads` AFTER INSERT: a new live binding re-decides that thread's
  resting rows (`thread_bound`).
- `xero_invoices` AFTER INSERT or UPDATE OF `job_id`, `invoice_number`: an
  ACCREC invoice newly on a job re-decides resting rows of that job's
  customer, or naming the job as a candidate, whose words carry the number
  (`invoice_linked`).
- A hand run (`hand_run`), below.

`jobs` AFTER UPDATE OF `ghl_contact_id`: a job that gets its contact after its
insert (the patio path) calls `context_reconsider_contact(..., 'job_contact_linked', job)`,
which reads from the job's lead window to the moment of the link.

## Relink

A stored row (captured over an hour ago) that a stage-1 rule places, or that a
re-decision binds or sends to review, gets `metadata.capture_mode='relink'`
with the prior mode in `capture_mode_before`, as the 7 Oct repair and the
daily re-check (`20261014034549`) do, so the event listener never reads it as
fresh news. A row captured within the hour is news and keeps its mode.

The daily re-check (`rerun_context_attribution`) re-decides bucket rows only,
so after deploy the stage-1 rules reach bucket rows over the following days
at its pace. Unplaced rows are reached only by the evidence triggers or a
hand run.

## Hand run (not run by the migration)

With the owner's go, in pages of 200, newest first:

```sql
SELECT public.context_redecide_events(ARRAY(
  SELECT id FROM public.business_events
  WHERE job_id IS NULL AND attribution_status = 'unplaced'
  ORDER BY occurred_at DESC, id LIMIT 200), 'hand_run');
```

Repeat until a call answers `placed` 0 and `to_review` 0. Rows that stay are
left exactly as they were.

## Monitor

`context_pipeline_status().bucket` (`context_bucket_status`, was the F1b stub):
unplaced and bucket rows by lane (`context_unplaced_lane`: `machine`,
`not_customer`, `customer`), the customer lane split into history and live and
counted for the last 24 hours. Alarms at `context_unplaced_policy()`:
`unplaced_customer_over_threshold` (customer unplaced above 1,100) and
`unplaced_customer_inflow` (above 30 customer rows unplaced in 24 hours).
Lower the first once the hand run has been done.
