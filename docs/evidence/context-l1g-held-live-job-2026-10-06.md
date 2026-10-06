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
  only when no non-draft job does), so `single_open` on SWF-261501 was right.
  P1b's reconsideration ran at the draft's insert (06:00:43Z) and reopened
  nothing for the same reason, and nothing reopens rows when a draft goes live.
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

- Of the newest 1,800 bucket rows, the rules-on ladder places 20 on jobs that
  are closed today: all 20 were live at their message time, none finished
  before it.
- Of 748 stored reference placements (`source_job_binding` `direct_reference`),
  313 sit on jobs archived after their message and 6 on jobs finished before
  it; all 6 are supplier material-order or clearance emails for that job.
- So "send a reference to a job that is not live to review" would be worse,
  not better: judged by today's status it rejects correct history; judged at
  the message time it touches almost nothing and that is correct too. L1g does
  not change references.

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
