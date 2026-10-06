# Ladder L1g: the P4 preview's last five bad moves (6 Oct 2026)

Production reads only (`BEGIN READ ONLY ... ROLLBACK`), ids and counts only.
The rules flag `context_unlinked_rules_v1` stayed off throughout.

## What the preview said

`p4-preview.sql` (firstmate home, `data/cio-ctx-p4-fix/`) at 01:04Z and again
at 01:28Z, ladder L1f live: 1,230 to 1,245 rows judged, **5 bad moves**,
0 preview errors.

| Rows | Stored | Rules on (L1f) | Reason |
|---|---|---|---|
| `32db7e0b`, `e7b9a02d`, `963567b2`, `c790bf22` | `single_open` SWF-261501 | `pending_luna` (`review_several`) | leaves_job |
| `47a53cca` | `pending_luna`, no job | `direct` SWP-26040 (`direct_ref`) | not_live_job |

## Cause, rows 1 to 4: a draft that went live after the rows were placed

- The customer's first job SWF-261501 was created 1 Oct and quoted 2 Oct.
- 5 Oct, 05:54:20Z: a call (two rows: the call log and its transcript).
- 06:00:43Z: a second job card, SWF-261521, created as a **draft** at the same
  site; 06:05Z: two outbound texts; 07:29:05Z: SWF-261521 **quoted**.
- The four rows were recorded 06:03 to 06:18Z. At that time a draft beside a
  live job was not a candidate (`context_contact_job_timeline`: a draft counts
  only when no non-draft job does), so `single_open` on SWF-261501 was the
  rules' answer then. Whether the rows belong to SWF-261521 instead is not
  something the ladder can judge (the words decide it): P1b's reconsideration
  ran at the draft's insert (06:00:43Z) and reopened nothing for the same
  reason, and nothing reopens rows when a draft goes live (gap 1 below).
- A re-decision today reads SWF-261521 as quoted and, through its lead window
  (30 days before its creation), as a candidate for every message since 5 Sep:
  two live jobs, `review_several`, on both ladders.
- L1f's held placement holds a row only while no other job of the customer is
  live at the message time, so it let all four go. "Older than the newer job"
  would not be enough either: the two texts came 5 minutes after the draft was
  made.

Same shape across the whole population (every `single_open`, `single_line` and
`luna` row recorded in the last 30 days, 4,004 rows, read 01:50Z): L1f's
rules-on re-decision takes **191** off their job (145 `single_open`,
1 `single_line`, 45 placed by Luna). Eight customers show the draft-then-quoted
pattern; Luna is asked only when several jobs are live, so L1f could never
hold a Luna placement. The preview's sample (newest 100 contact-rule rows)
caught 4 of the 191; by 01:47Z those 4 had already left the sample.

## Cause, row 5: the preview reads today's status

`47a53cca` is a GHL history-load text of 2 Jun 2026 naming invoice INV-0482.
INV-0482 is SWP-26040's ACCREC invoice, paid that day. SWP-26040 was created
24 Mar, completed 3 Jun (the day after the text) and archived 10 Sep. The
customer also had three other jobs live on 2 Jun (hence `review_several`
without the reference). The rules-on placement is right; the preview's
`not_live_job` test counts it because it reads the job's status today.

- Every bucket row of the last 30 days (3,744, read 02:25Z): the rules-on
  ladder places 74 on jobs that are closed today; for 60 of them the job was
  live at the message time. Of the 14 whose job had finished before the
  message, 6 follow an email thread bound to the archived placeholder job
  SWF-PDF-BUCKET (a real defect, outside this change: a live thread binding
  to a placeholder job); the other 8 are exact references that belong where
  they land (6 internal crew texts naming SWF-261343 two minutes after it was
  archived, 2 emails about invoice INV-1205 of the finished make-safe
  SWMS-261174). None of the 14 is in the preview's current sample (all are
  older than its newest 600).
- Of 748 stored reference placements (`source_job_binding` `direct_reference`),
  313 sit on jobs archived after their message and 6 on jobs finished before
  it; all 6 are supplier material-order or clearance emails for that job.
- So "send a reference to a job that is not live to review" would be worse,
  not better: judged by today's status it rejects correct history; judged at
  the message time it still rejects invoice and material-order mail about
  finished work. L1g does not change references.

## L1g

Rules-on body only (`20261006035000`): the held placement also holds a row
whose job is itself one of the customer's own or contactless jobs live at the
message time, or one the review would offer (guard window, unpaid, aftercare
window), whatever other job is live then. P1b stays the one reopen path: it
moves contact-rule rows to review directly at a new job's insert, never
through the ladder (`context_reconsider_contact`, branch (d)), so a new
enquiry still reaches review.

Measured by running the L1g body inline, read only, over production (a DO
block in `BEGIN READ ONLY`, preview mode, writes nothing; the same harness run
with L1f's body matches the live ladder row for row):

| | L1f | L1g |
|---|---|---|
| Preview sample 01:45Z, today's-status test | 1 (`47a53cca`) | 1 (`47a53cca`) |
| Same sample, at-message-time test | 0 | 0 |
| The 5 rows of the 01:04Z sample | 5 | 1 (`47a53cca`), 0 at message time |
| Contact-rule rows (30 days) taken off their job | 191 of 4,004 | 7 of 4,004 |

The 7 L1g still moves: 5 on a canary test job, a draft beside live jobs (one
of the five names another job in its words), 1 whose job now belongs to another
contact (`bfa54755`), 1 history row stored on a job created three weeks after
the message, outside its lead window (`8f625619`). All three are cases where
moving is the right answer.

The at-message-time preview is `context-l1g-p4-preview-at-message-time.sql`
beside this file: the desk's preview with one change (not_live_job judges the
job as it stood at the message time, using the timeline's terminal time) and
the old test still reported as `live_then_closed_since`. Run on production at
02:08Z with L1f live: 1,227 rows, bad_moves 0, preview_errors 0,
live_then_closed_since 1 (`47a53cca`).

The flag stays off. Turning it on needs Marnin's go after the preview reads 0.

## Review re-measure, 6 Oct 05:30 to 06:20Z (L1f live, flag off)

Method: a DO block inside `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`
runs the rules-on body inline twice per row, once with L1f's `held_ok` and
once with L1g's, plus the live `context_attribution_preview`, all on one
snapshot; results leave through a transaction-local setting; nothing is
written. The inline L1f pass equals the live preview on all 1,226 sampled rows
(0 differences); the inline L1g pass differs on 6. The same harness on the
contract fixtures, with L1g installed locally, equals the live preview with
its L1g pass.

The desk's preview, as written (05:30Z, L1f live): 1,226 rows, **bad_moves 7**,
0 preview errors:

| Rows | Stored | Rules on (L1f) | Reason |
|---|---|---|---|
| `078cab6e`, `35aaa727`, `4d3a99ea`, `aa5e3090`, `d6be8fbe`, `e3a32efe` | `single_open` SWF-261529 | review (`review_several`) | leaves_job |
| `47a53cca` | `pending_luna`, no job | `direct` SWP-26040 (`direct_ref`) | not_live_job |

The six SWF-261529 rows are the SWF-261501 shape again: the customer's second
job card SWF-261530 (another site) was made as a draft at 03:25:45Z on 6 Oct
and quoted at 03:38:43Z; four of the six were sent while it was a draft.

The same sample under L1g (05:43Z): **bad_moves 1** (`47a53cca`, not_live_job;
its job was live when the text was sent), **0 judged at the message time**,
0 preview errors, leaves_job 0. L1g holds the six SWF-261529 rows. Every row
whose job changes under L1g comes from the bucket (18 rows): 11 by site
address, 4 `single_open`, 1 `identity_email`, 2 by a job reference
(`8b8f0137`, and `47a53cca`). Re-run at 06:12Z over 1,206 rows: the same
result (L1f 7, L1g 1, 0 at the message time, the inline L1f pass equal to the
live preview on every row); 20 rows move, all from the bucket (one more by
site address, `c49ec090`, and one by a live thread, `44dd12a1`).

Every contact-rule row of the last 30 days (4,076 rows, 05:50 to 06:15Z):
L1f's rules-on re-decision takes **205** off their job, L1g **7** (the same 7
named above: 5 on SWF-CANARY-20260509, `bfa54755`, `8f625619`). The 198 rows
L1g newly holds have three shapes:

| Shape | Rows | Customers | Jobs (held on, other live job) |
|---|---|---|---|
| Luna chose among the live jobs | 45 | | 11 jobs, held where Luna put them |
| A second job card went from draft to live after the rows were filed | 102 | 9 | SWF-261501 and 261521 (32), 261506 and 261509 (16), 261529 and 261530 (14), 261517 and 261518 (11), 261519 and 261520 (11), 261472 and 261473 (9), 261431 and 261448 (7), 261421 and 261422 (1), 261457 and 261458 (1) |
| A job card with no contact shares the message's phone or email (the rules-off ladder reads only the own jobs' keys) | 51 | 3 | SWF-26838 and SWF-26760 (26), SWF-26545 and SWF-26544 (19), SWF-261439 and 21 make-safe jobs sharing the sender's key (6) |

Every bucket row of the last 30 days (3,785, 06:05Z): the rules place 596.
60 land on jobs closed today that were live at the message time; the only
one in the preview's window (its newest 600 bucket rows) is `47a53cca`, at
rank 550; the next are at ranks 832 and beyond. 14 land on jobs already
finished at the message time, all at rank 2,919 or beyond: 6 emails that
follow a thread bound to SWF-PDF-BUCKET, 6 crew texts naming SWF-261343,
2 invoice emails about SWMS-261174. 0 errors. Bucket rows arrive at about
193 a day.

### Expected preview after deploy

- The desk's preview as written: **bad_moves 1** (`47a53cca`, not_live_job),
  leaves_job 0, preview errors 0, while that row stays in the newest 600
  bucket rows; **0** once newer bucket rows push it out. It reads more than 1
  only if older rows whose job closed after the message (rank 832 and beyond)
  re-enter the window, which needs more bucket rows placed than arrive.
- Judged at the message time (`context-l1g-p4-preview-at-message-time.sql`):
  **0**.

### Two gaps this change does not close

1. **A draft that goes live reopens nothing.** P1b reconsiders at a job's
   insert only, and a draft beside a live job is not a candidate then. The
   102 rows above stay on the older job whether the flag is on or off; L1g
   only stops the preview counting them. Fixing it means a new P1b reason
   (a job leaving draft), which replaces P1b's body; whether that should
   reopen rows to review is a product call.
2. **50 live thread bindings point at the archived placeholder job
   SWF-PDF-BUCKET** (`do_not_schedule` true, 1,038 rows on it). Eight bucket
   rows follow those bindings; the 6 of the last 30 days were checked, and both
   ladders, rules on or off, place them on the placeholder on a re-decision
   (`9970c319`, `c60b9780`, `1dcee217`, `130b99ef`, `bcdcc2ef`, `e0d3933f`,
   never re-checked since they were recorded in September). Nothing re-runs
   bucket rows on a schedule, so they move only if someone runs the bucket
   re-run (for example when the flag is turned on). Retire those bindings, or
   teach the thread step to skip a `do_not_schedule` job, before that re-run.
