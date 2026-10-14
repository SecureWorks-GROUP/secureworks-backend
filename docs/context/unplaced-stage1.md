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
| `builder_ref` | no reference of ours, and a builder claim names exactly one job, or one purchase order of that claim picks it (`context_builder_ref_jobs`; whole digit runs). The claim is read from make-safe details and from a repair or fence job's own `mlb_ref`, `external_ref` or `builder_claim_ref`, so a claim shared by a make-safe and its repair places neither. A purchase order alone never places; purchase order evidence that conflicts places nothing | `direct` |
| identity | our own outbound row reads its recipient (`payload.to`) in `context_event_identity`: one customer email, or with no email recipient one phone | then the usual rules |
| `ranked_open` | a contact review (several jobs, or one job beside a recently finished one) only: jobs that cannot be a customer's job (no number: a hidden old-system record; a test job; a holding job) leave the set, and quotes already dead at the message time (cancelled, lost, archived with nothing delivered) leave the recently-finished set (`context_rank_contact_set`). Exactly one job left and no finished work beside it places there. Status now and creation date never choose: finished work, aftercare and a job live at the message time that closed later stay competitors | `single_open` |
| `only_open_job` | a known customer with no candidate at the message time whose only job, of any status, is live now and was created after the message and within 60 days of it | `single_open` |
| `job_party` | no CRM contact, and a live `job_contacts` party carries the row's email or phone on exactly one job that fits the message time (created by then or within its lead window; not a quote dead before it; not finished over 90 days before it), with the email and phone, when both match, naming the same parties (`context_party_key_jobs`). A disagreement is marked `party_key_conflict` and places nothing | `single_open` |

Never ranked, review as before: a text naming 2 to 5 of our jobs (`multi_ref`),
an exact address matching 2 to 3 jobs (`site_address_several`), an identity
conflict, aftercare, and a customer whose jobs are all closed.

A ranked placement is `single_open`, so it never makes a thread binding (only
proof may, X25). `metadata.placement_ranked_from` names the review rule it
replaced and `placement_ranked_below` the jobs it passed over.

## Re-decision on new evidence

`context_redecide_one(id, reason, detail)` re-runs the ladder on one row with
no job that rests `admin_bucket` or `unplaced`, and writes only a placement, a
review case, or a machine or empty row taken out (`automated` or `empty`, no
job), with `metadata.placement_redecided`. Anything else is left as it was;
a locked row is skipped. Callers:

- `context_redecide_events(ids, reason, detail)`, at most 200 rows and 2
  seconds a call, for the evidence triggers:
  - `event_threads` AFTER INSERT: a new live binding re-decides that
    thread's resting rows (`thread_bound`).
  - `xero_invoices` AFTER INSERT or UPDATE OF `job_id`, `invoice_number`: an
    ACCREC invoice newly on a job re-decides resting rows of that job's
    customer, or naming the job as a candidate, whose words carry the number
    (`invoice_linked`).
- `context_redecide_resting(status, before_at, before_id)`, the hand run
  (`hand_run`), below.

`jobs` AFTER UPDATE OF `ghl_contact_id`: a job that gets its contact after its
insert (the patio path) calls `context_reconsider_contact(..., 'job_contact_linked', job)`,
which reads from the job's lead window to the moment of the link.

## Relink: one rule, by the message's own time

Every stored-row re-decision this stage adds (the ladder's stage-1 placements
of a stored row, the two evidence triggers, the hand run, and the late
contact link) goes through `context_redecided_metadata`: a message whose own
time (`event_at`, else `occurred_at`; never the capture time) is within 48
hours (`context_unplaced_policy().fresh_message_hours`) is placed as live, so
a customer's fresh reply still cancels follow-ups. An older one is stamped
`capture_mode='relink'` with the prior mode in `capture_mode_before`, so the
event listener never reads it as fresh news, also when it goes to review and
the model places it later (the live Luna functions keep metadata).
`backfill` and `relink` rows keep their mode. Machine rows taken out are not
placements and are not stamped.

Not covered here: P1b's `job_created` first bind keeps its mode as before;
the daily re-check (`rerun_context_attribution`) stamps relink on every
decision once PR 1040 (`20261014034549`) is merged, and moves to this 48-hour
rule in a follow-up. The re-check re-decides bucket rows only, so after deploy
the stage-1 rules reach bucket rows at its pace; unplaced rows are reached
only by the evidence triggers or the hand run.

## Hand run (not run by the migration)

With the owner's go, newest first by message time, 200 rows or 20 seconds a
call, each call starting after the last row the previous one looked at, so
rows that stay unchanged never hide older ones:

```sql
SELECT public.context_redecide_resting('unplaced');
-- then, while the answer says "finished": false, pass its next cursor:
SELECT public.context_redecide_resting('unplaced', '<next.before_at>', '<next.before_id>');
```

Stop when an answer says `"finished": true`. If any call counted
`skipped_busy`, run one more pass from the start. Rows that stay are left
exactly as they were. The 154 make-safe reconcile rows come out as
`taken_out` (automated, no job).

## Monitor

`context_pipeline_status().bucket` (`context_bucket_status`, was the F1b stub):
unplaced and bucket rows by lane (`context_unplaced_lane`: `machine`,
`not_customer`, `customer`), the customer lane split into history and live and
counted for the last 24 hours. Alarms at `context_unplaced_policy()`:
`unplaced_customer_over_threshold` (customer unplaced above 1,100) and
`unplaced_customer_inflow` (above 30 customer rows unplaced in 24 hours).
Lower the first once the hand run has been done.
