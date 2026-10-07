# Placement grading: is each message on the right job?

Done definition row 3 (5 Oct 2026) is green only when at least 95% of
customer-facing items are on the RIGHT job. The scorecard can count how many
items are on A job; only a grader can say whether it is the right one. This is
how a sample is drawn, graded by a fresh grader, stored and read. Database
objects: migration `20261007070000_context_placement_grades.sql`.

## The bar and where the scorecard reads it

`public.context_placement_grades_newest(as_of)` returns one row: the newest
sample (latest draw instant) stored by `as_of`, with `graded` (right + wrong +
unsure), `right_count`, `wrong_count`, `unsure_count`, `right_share` (right /
graded) and `weighted_right_share` (each stratum's share weighted by its size at
the draw), both rounded down to 4 decimals, and per-stratum counts. The bar is
the scorecard policy's, not this function's: at least 100 graded and at least
95% right. Read it as `graded >= 100 AND least(right_share, weighted_right_share) >= 0.95`.
An unsure verdict is never right.

## 1. Draw (the orchestrator)

Read only. One call draws 120 placed customer messages from the 30 days to the
instant given, stratified by how they were placed:

```sql
BEGIN READ ONLY;
SELECT * FROM public.context_placement_sample('2026-10-07 04:00:00+00');
ROLLBACK;
```

Save the output as the draw file: `sample_id, as_of, pos, event_id,
placed_job_id, stratum, stratum_rows, stratum_drawn, lane, captured_at`. Ids,
codes and counts only. The same `sample_id` always draws the same rows from the
same data, but placements change over time, so keep the saved file: it, not a
later re-draw, is what gets graded and loaded. Every stratum (luna,
single_open, single_line, thread, content_ref, party, reference, payload_job,
custody, no_words, other) gets up to 5 messages first, then the rest is shared
in proportion. On 7 Oct 2026 04:00Z (read-only emulation) that is single_open
77 of 3,926, custody 11 of 326, luna 8 of 163, thread 8 of 139, single_line 6
of 82, payload_job 5 of 26, other 5 of 11.

Give the grader only `pos`, `event_id` and `placed_job_id`. Never the stratum:
the grader judges the job, not the rule that chose it.

## 2. Grade (a fresh grader)

A fresh grader is an agent or person with no part in building or running the
placement system. Read only, always: every query inside `BEGIN READ ONLY; ...
ROLLBACK;`. Never message anyone, never change a row.

For each message, read its card:

```sql
BEGIN READ ONLY;
SELECT public.context_placement_grade_card('<event_id>', '<placed_job_id>');
ROLLBACK;
```

The card gives the message (when it was sent, lane, direction, sender and
recipient roles, the sender field, subject, the first 2,000 characters), the
customer (`contact_id`; `contact_basis` says whether it is the row's own
contact, the GHL contact its payload carries, or the one contact its own email
or phone names), the job it was placed on, the customer's jobs as they stood
at the message time (`live_at_message`,
`finished_before_message`, `created_after_message`, site address, type), the
jobs its words name, and up to three messages before and after it from the
same customer or thread. It says nothing about how the message was placed.

Judge the job as it stood when the message was sent, never by its status
today: a job archived since was still the right job if the message was about
it then.

| Verdict | When | reason | right_job_id |
|---|---|---|---|
| `right` | The placed job is the job the message is about. | empty | empty |
| `wrong` | Another of our jobs is the one it is about (it names that job, its site or its quote; it is about a different service or site the customer had a job for). | `other_job` | that job's id |
| `wrong` | It is about no job of ours: a wrong number, marketing, a supplier talking about stock, a new enquiry no job card exists for, or the placed job is a holding job (`placed.holding_job` true). | `no_job` | empty |
| `unsure` | Two or more of the customer's jobs fit equally and nothing in the words, the neighbours or the records decides. | `several_jobs` | empty |
| `unsure` | The message has too little in it and the records add nothing. | `not_enough_evidence` | empty |

Rules of thumb:

- One live job at the time and nothing pointing elsewhere: a short "Yes
  please" or "Thanks" on that job is `right`. Shortness alone is never
  `unsure`.
- A job number, quote number, invoice number or site address in the words
  decides it.
- Our own outbound message is judged the same way: is it about the placed job?
- A crew or staff text about a job belongs on that job.
- Use the neighbours: a reply usually belongs with the message it answers.
- Use `unsure` only when the records truly cannot decide. A wrong guess and a
  `right` given to be kind both make the measure lie.

## 3. Return (ids only)

One line per message, no words, no names, no addresses:

```
event_id,verdict,reason,right_job_id
```

## 4. Load (the orchestrator, with the owner's go)

Join the grader's file to the saved draw by `event_id`, add the grader's name
(`grader-1`, or `person:<user id>`) and when the grade was given, and load it
with `scripts/context-placement-grades-load.sql` (a guarded write: it ends in
ROLLBACK until the go, refuses any key that is not an id or a code, refuses a
second load of one sample, and prints the newest sample as the scorecard will
read it). `scripts/context-placement-grades-load-undo.sql` removes one sample
whole. The table takes each message once per sample; to correct a sample,
unload it and load it again.

## What else row 3 has

- Known misfiles: `context_placement_misfile_counts(as_of)` (cheap) and
  `context_placement_misfile_plan()` (one ladder decision per row, for
  scripts). The 70 rows on the placeholder job SWF-PDF-BUCKET are repaired by
  `scripts/context-placement-misfile-repair.sql` (owner's go).
- The 50 live thread bindings to that placeholder are retired by
  `scripts/context-holding-thread-retire.sql`, before any bucket re-run.
- The bucket re-run under the rules-on ladder is
  `scripts/context-bucket-rerun-l1g.sql`.
- Every script is proved end to end on a disposable database by
  `scripts/test-context-placement-row3.sh`. Measurements:
  `docs/evidence/context-placement-row3-2026-10-07.md`.
