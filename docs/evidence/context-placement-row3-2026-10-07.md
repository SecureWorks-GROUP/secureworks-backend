# Row 3, placement: what production holds, and what each script would change (7 Oct 2026)

Production reads only (`BEGIN READ ONLY ... ROLLBACK`, 04:30 to 06:20Z), ids
and counts only. Ladder L1g live, attribution lane on, flag
`context_unlinked_rules_v1` on since 02:32Z on 7 Oct (rows captured since are
placed by the rules-on ladder at capture; no older bucket row has been
re-decided since: 0 of the older admin_bucket rows re-checked). Every
measurement below calls the rules-on body explicitly. Migration
`20261007070000` was not applied, so its plan, sampler and re-run were emulated
inline with the same SQL. No script was run.

## The scorecard's row 3 today

| Lane | Value | Status |
|---|---|---|
| customer_facing | 4,675 of 6,135 customer messages in 30 days on a job (76.2%) | red |
| xero_and_quotes | 1,204 of 1,300 (92.6%) | amber |
| review_queue | 1,004 of 3,739 unplaced items with a candidate job (26.9%) | red |
| known_misfiles | 70 mismatched, 0 the repair can move | red |
| right_job_accuracy | not measurable yet: no graded sample stored | red |

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
the GHL contact of its conversation (38 customers), while 52 of the 70 have no
`contact_id`.

Re-decided by the rules-on ladder in preview, as each would read once repaired
(the payload's GHL contact, no job, `capture_mode` relink, the payload's job set
aside):

| Plan | Ladder answer | Rows | Customers | Note |
|---|---|---|---|---|
| move | single_open on the job the payload names | 40 | 24 | 24 jobs; 34 rows land on jobs live today |
| review | review_several | 29 | 13 | 2 to 23 live jobs at the message time |
| review | review_recent_other_job | 1 | 1 | its one live job is not the job named; 6 candidates |
| leave | | 0 | | |

`scripts/context-placement-misfile-repair.sql` applies exactly that: known
misfiles 70 to 0, the review queue gains 30 rows each with a candidate (11 in
its window), 34 rows become unread history on live jobs until read.

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
pending_luna or review): 3,737 rows (2,727 admin_bucket, 656 pending_luna, 365
unplaced). Run through `resolve_context_attribution(row, preview, rules on)`
with the 50 bindings emulated as retired:

| | Rows |
|---|---|
| placed | 605: site_address 285, single_open 163, direct_ref 84, identity_email 37, internal_ref 26, thread 10 |
| of those on a job live today | 471 |
| on a holding job | 0 |
| left off a job | 3,132, of which 1,330 with a candidate (before: 1,003 of 3,737) |
| status after | admin_bucket 1,802, unplaced 1,073, pending_luna 257 (was 656), content_ref 285, single_open 200, direct 110, thread 10 |
| errors | 0 |
| the 8 rows on a holding-job thread | 2 placed, 6 rest |
| the 220 rows whose payload names a job (all text-cache guesses) | 7 placed, every one on that job: 0 new misfiles |

The review queue's candidate share would move from 26.9% to about 42.5%; it
stays red (green 95, amber 50). Not measured: how many of the 605 are
customer-facing once their party roles are re-stamped on the new job.

## All 1,038 rows on the placeholder (a follow-up, not scripted here)

Re-decided read-only the same way as the misfiles: 349 placed (single_open
134, site_address 104, identity_email 70, direct_ref 41), 140 to review with
candidates, 549 with no job at all (476 with no contact, 73 with no job of
their contact at the time). Releasing them is the next slice if the scorecard
counts rows on a holding job as known misfiles
(`context_placement_misfile_counts.on_holding_job`).

## The first sample, emulated

A draw as of 7 Oct 04:00Z, 120 of 4,673 placed customer messages: single_open
77 of 3,926, custody 11 of 326 (61 of the 326 are on the placeholder; 1 is
drawn), luna 8 of 163, thread 8 of 139, single_line 6 of 82, payload_job 5 of
26, other 5 of 11.
