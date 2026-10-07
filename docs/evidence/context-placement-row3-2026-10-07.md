# Row 3, placement: what production holds, and what each script would change (7 Oct 2026)

Production reads only (`BEGIN READ ONLY ... ROLLBACK`, 04:30 to 06:20Z, and
again 10:58 to 12:06Z after review), ids and counts only. Ladder L1g live,
attribution lane on, flag `context_unlinked_rules_v1` on since 02:32Z on 7 Oct
(rows captured since are placed by the rules-on ladder at capture; no older
bucket row has been re-decided since: 0 of the older admin_bucket rows
re-checked). Every measurement below calls the rules-on body explicitly.
Migration `20261007070000` was not applied, so its plan, copy check, sampler
and re-run were emulated inline with the same SQL. No script was run.

## The scorecard's row 3 today

| Lane | Value | Status |
|---|---|---|
| customer_facing | 4,675 of 6,135 customer messages in 30 days on a job (76.2%) | red |
| xero_and_quotes | 1,204 of 1,300 (92.6%) | amber |
| review_queue | 1,004 of 3,739 unplaced items with a candidate job (26.9%) | red |
| known_misfiles | 70 mismatched, 0 the repair can move | red |
| right_job_accuracy | not measurable yet: no graded sample stored | red |

## How right-job accuracy is read

Row 3 counts every item, so the graded share is read with the placed share:
`right_of_all` = least(right share, weighted right share) x placed share, one
for customer-facing items and one for Xero and quote items, each green only
with the whole draw graded, at least 100 drawn and `right_of_all` at least
0.95 (`docs/context/placement-grading.md`). Grading placed items alone would
read green at about 90.25% of all items on the right job. With the window to
04:00Z the placed shares are 76.2% (4,673 of 6,132) and 92.6% (1,204 of 1,300,
strata custody 856, no_words 291, other 57), so neither can be green yet. A
saved draw carries its own digest, and a load refuses a draw graded in part
(on the old load, a draw of 3 loaded with only its 2 right answers read 2
graded, 1.0000 right).

## The placeholder job

`SWF-PDF-BUCKET` (`f6814b2e`) is the only job with `metadata.do_not_schedule`:
archived, created 12 Aug 2026, no contact, purpose `pdf_unlock_bucket`. 1,038
rows sit on it, every one attributed between 14 and 23 Sep 2026 (step 1
custody, `direct_job_id`, except 5 placed by a thread): 672 monitor-inbox, 74
transcribe-call, 74 ghl_sms_cache_backfill, 65 ghl-proxy, 55
monitor-inbox-group, 53 monitor_inbox, 24 ops-api/backfill_ghl_conversations,
11 mcp_agent, 6 app/makesafe-intake, 3 monitor-ses-makesafes, 1
ghl_sms_coverage_backfill. 301 were captured in the scorecard's 30-day window,
and 61 of those are customer-facing: the customer_facing lane counts them as
on a job.

## The 70 known misfiles

All 70 rows of `context_payload_job_mismatch_rows()` sit on the placeholder:
69 from the text-cache backfill and 1 from its one-shot coverage backfill,
texts sent 8 May to 22 Sep 2026, status `direct`, step 1, `direct_job_id`, so
the classifier calls all 70 `not_contact_rule` and the reviewed repair moves
none. Each payload names the job that backfill guessed (39 jobs) and carries
the GHL contact of its conversation (38 customers) and its GHL message id,
while 52 of the 70 have no `contact_id`.

Most are copies. For 40 of the 70, the GHL history load already saved the same
text (same GHL message id, event type and words) under its `ghl:<id>` key,
because a row on the placeholder can never stand in for it. Moving the cache
copy onto the job would have made two live copies: on a disposable database
the old repair took one job's story rows for such a text from 1 to 2, and left
a text already waiting for review queued twice.

Re-decided by the rules-on ladder in preview, as each would read once repaired
(the payload's GHL contact, no job, `capture_mode` relink, the payload's job set
aside), and checked for a twin (`context_placement_message_twin`), 11:40Z:

| Plan | Twin | Ladder answer | Rows | Note |
|---|---|---|---|---|
| duplicate | keyed, single_open on the job named | single_open | 27 | follows its twin onto that job, marked; all 27 jobs live today |
| duplicate | keyed, placed by Luna on another job | review_several | 4 | follows its twin, marked, payload guess set aside |
| duplicate | keyed, waiting for Luna | review_several | 8 | no job, no queue status, marked; the twin is the queue's item |
| duplicate | keyed, in the bucket | single_open | 1 | as above |
| move | none | single_open on the job named | 12 | 6 onto jobs live today |
| review | none | review_several | 17 | 2 to 23 live jobs at the message time |
| review | none | review_recent_other_job | 1 | its one live job is not the job named |
| leave | | | 0 | |

`scripts/context-placement-misfile-repair.sql` applies exactly that: known
misfiles 70 to 0, 70 rows off the placeholder (1,038 to 968 on it), the review
queue gains 18 rows each with a candidate, 12 rows become unread history on
their jobs until read, and the 40 copies are never read. Every review row and
every copy that does not sit on its payload job has that guessed payload job
set aside (kept in `placement_repaired`), so a reviewer who picks any candidate
places a row every reader reads; with the guess kept, any pick but the guess
was unreadable and a new known misfile.

## The 50 thread bindings

50 live `event_threads` rows point at the placeholder, all `bound_by` ladder
between 14 and 23 Sep 2026, each from a row on the placeholder. 55 rows on the
placeholder sit there through them (the 50 that bound them and 5 placed by
them) and 8 bucket rows carry one of their keys. Retired by re-keying
(`retired:holding_job:<key>`), a later email on those threads is decided by
the contact, reference, address and bucket rules instead of following the
placeholder; with the key kept, the rules-on ladder would send it to review
with the placeholder as its only candidate.

## The bucket re-run under the rules-on ladder

Every bucket row of the 30 days to 04:00Z (no job; admin_bucket, unplaced,
pending_luna or review): 3,737 rows (2,720 admin_bucket, 654 pending_luna, 363
unplaced). Run through `resolve_context_attribution(row, preview, rules on)`
with the 50 bindings emulated as retired, in 10 chunks, 11:45 to 12:05Z:

| | Rows |
|---|---|
| placed | 599: site_address 278, single_open 163, direct_ref 84, identity_email 37, internal_ref 26, thread 11 |
| of those on a job live today | 465 |
| of those captured live (stamped relink, history to the listener and the reader) | 572 |
| on a holding job, off their own payload job, errors | 0, 0, 0 |
| copies of a text already placed (marked, not placed again) | 130, every twin on a job live today |
| Luna-answered rows the rules would queue again (kept as Luna left them) | 129 |
| left off a job | 3,138, of which 1,312 with a candidate (before: 1,003 of 3,737) |
| status after | admin_bucket 1,811, unplaced 1,199, pending_luna 128, content_ref 278, single_open 200, direct 110, thread 11 |
| the 8 rows on a holding-job thread | 2 placed, 6 rest |

The model queue: 654 rows wait for Luna today; all 654 are history and leave
the queue unplaced, never asked; 128 rows become first asks (none already
answered), within the 300 attribution calls of the day's 1,000; the 129
already answered stay as Luna left them (before this review all 257 would have
gone to Luna, 129 of them a second time).

The Jarvis event listener (`src/automation/event-listener.ts` on main, last
polled 12:03Z) reads a customer text whose `attributed_at` lands in its window
as a new placement and cancels every pending proposal and nudge on the job,
unless the row is history (`capture_mode` backfill or relink). Without the
relink stamp the re-run would have placed 75 live customer texts; 10 of their
jobs held 60 pending proposals and 4 nudges at 12:00Z (at 06:40Z: 81 texts on
22 jobs, 89 proposals on 16 jobs and 8 nudges on 6 jobs). With the stamp none
is cancelled: the 85 target jobs that hold pending follow-ups keep all 401
proposals and 25 nudges. PART 2 refuses a batch in which any placed row would
read as news.

The review queue's candidate share would move from 26.8% to about 41.8%; it
stays red (green 95, amber 50). Not measured: how many of the 599 are
customer-facing once their party roles are re-stamped on the new job.

## All 1,038 rows on the placeholder (a follow-up, not scripted here)

Re-decided read-only the same way as the misfiles: 349 placed (single_open
134, site_address 104, identity_email 70, direct_ref 41), 140 to review with
candidates, 549 with no job at all (476 with no contact, 73 with no job of
their contact at the time). Releasing them is the next slice if the scorecard
counts rows on a holding job as known misfiles
(`context_placement_misfile_counts.on_holding_job`); copies among them were
not counted.

## The first sample, emulated

A draw as of 7 Oct 04:00Z, 120 of 4,673 placed customer messages: single_open
77 of 3,926, custody 11 of 326 (61 of the 326 are on the placeholder; 1 is
drawn), luna 8 of 163, thread 8 of 139, single_line 6 of 82, payload_job 5 of
26, other 5 of 11. A Xero and quotes draw of 120 of 1,204: custody 80, no_words
30, other 10.
