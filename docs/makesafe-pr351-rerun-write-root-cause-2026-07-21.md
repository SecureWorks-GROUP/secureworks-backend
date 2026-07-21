# PR 351 persisted-rerun write root cause

## Conclusion

The `+2` artifacts and deterministic draft were **not created by a concurrent legacy intake pipeline**.

They were created by a second deterministic invocation initiated by the normal `makesafe-ses-poll` schedule after the authority switch. The first manual canary response was truthful for its own invocation, which completed at `10:02:55.124 UTC`. The subsequent scheduled invocation started at `10:03:01.602 UTC`, used a different sweep page, admitted three off-case client-name evidence candidates into the case-wide evidence map, and incorrectly treated the target as eligible for guarded job creation even though its canonical `client_name` remained null.

That deterministic job attempt committed two artifact rows and one draft before `approveIntakeDraft` rejected the null client. The exception prevented the runtime from incrementing its `drafts_created` counter and left the canonical case unchanged.

Production remains `legacy`. No code was changed and no fix is proposed in this diagnosis.

## Who created each row

The live tables do not have a generic `created_by` column for artifacts or drafts. Their source is nevertheless conclusive from their deterministic-only provenance fields and natural keys.

### Canonical case and sources, first manual invocation

- case created: `2026-07-21 10:02:54.899863 UTC`
- four source rows created: `10:02:54.995642` through `10:02:55.073921 UTC`
- case decision provenance: `deterministic`
- case decision actor: `makesafe-deterministic-intake@2026-07-21.v2`
- all source provenance values: `deterministic`
- state: `exception`
- reason: `adapter_parse_failure`
- client identity: absent
- parentless cycle-1 root: true

### Two artifacts, scheduled deterministic invocation

Artifact 1:

- ledger request: `2026-07-21 10:03:03.613 UTC`
- row created: `10:03:03.620410 UTC`
- completed: `10:03:03.608 UTC`

Artifact 2:

- ledger request: `2026-07-21 10:03:04.207 UTC`
- row created: `10:03:04.215619 UTC`
- completed: `10:03:04.201 UTC`

Both rows are:

- linked directly to the target canonical case
- `artifact_kind=pdf`
- `status=completed`
- stored under `makesafe-deterministic/...`
- stamped with recovery version `makesafe-deterministic-intake@2026-07-21.v2`
- keyed by deterministic content hashes

This row shape is emitted only by `stageAttachments()` in the deterministic runtime.

### Draft, scheduled deterministic invocation

- insert request: `2026-07-21 10:03:05.231 UTC`
- row created: `2026-07-21 10:03:05.319375 UTC`
- deterministic key exactly matches the canonical case recovery cursor
- graph marker begins `deterministic:`
- `extraction_json.deterministic_intake=true`
- deterministic version: `makesafe-deterministic-intake@2026-07-21.v2`
- status: `needs_review`
- `approved_by`: null
- approved job: absent
- client identity: absent
- site address: present

This row shape is emitted only by `ensureDraftAndJob()` in the deterministic runtime.

## Concurrent legacy hypothesis

**Result: rejected.**

The exact initiating chain was:

1. pg_cron job 90, `makesafe-ses-poll`, started at `10:03:00.055014 UTC` on its normal `1-59/2 * * * *` schedule.
2. `public.trigger_monitor_ses_makesafes()` enqueued the `monitor-ses-makesafes` edge function.
3. After the mailbox poll, that function tail-called `ops-api?action=scan_ses_makesafes`.
4. The tail call read `makesafe_cron_settings` at `10:03:01.624 UTC`.
5. Deterministic authority had been active since `10:02:45.697835 UTC`, 35.926 seconds before that settings read.
6. The invocation immediately executed deterministic-only reads: persisted source authority, canonical case/source reads, the deterministic scan cursor, artifact ledger and deterministic draft key.

Function execution logs close the remaining overlap possibility: the 10:01 monitor run started at `10:01:00.526`, tail-called the legacy scan at `10:01:01.829`, and fully completed at `10:01:08.479 UTC`, more than 97 seconds before deterministic activation. The creating 10:03 monitor run started at `10:03:00.517`, tail-called the scan at `10:03:01.602`, and completed at `10:03:05.581 UTC`. The target's four source email records were not modified during that mailbox poll; their `updated_at` values predate the window. The legacy scan observed at `10:05:11 UTC` began after the `10:03:51 UTC` rollback and accounts for the later one model call and health overwrite, not the artifact/draft writes.

## Earliest divergence from the proven local loop

The earliest divergence happened during planning of the scheduled rerun, before any artifact or draft write.

### First manual plan

- searched-source count: 251
- client evidence candidates: 0
- client manifest status: `missing`
- canonical client identity: absent
- result: `adapter_parse_failure` exception

### Scheduled rerun plan persisted in the draft

- searched-source count: 359
- client evidence candidates: 3
- all three candidate source rows exist
- all three are outside the target case's four canonical source rows
- client manifest status: `satisfied`
- canonical client identity: still absent

The runtime advances its sweep cursor immediately after each read. The second invocation therefore planned against a different production page. `buildEvidenceMap()` searches the whole correlated cluster, while `bestIdentity()` derives the case identity only from the selected instruction group. The three off-case candidates satisfied the cluster-wide `client_name` manifest requirement without populating the target instruction's `clientName`.

State selection tests the evidence-map status, not the canonical identity value. The rerun therefore no longer looked like the persisted exception. `rankCase()` classified the state mismatch as fresh, `wantsJob` became true, and the allowed exception-to-live transition entered `ensureDraftAndJob()`.

The local live-shaped loop cannot reproduce this shape:

- its input store is fixed and tiny (`maxSources=4`)
- its rerun sees no off-case client candidates from a moving 500-row mailbox page
- client evidence remains missing
- the case remains an exception and ranks as stuck
- no artifact or draft path executes

The local loop proved root-cycle and stable-key convergence, but not convergence under production cursor movement plus unrelated correlated evidence.

## Initiating trigger, masking condition, visible symptom

### Initiating trigger

The 10:03 scheduled `makesafe-ses-poll` tail call initiated the second deterministic scan 6.478 seconds after the controlled manual request had completed, while the authority switch intentionally remained deterministic for the convergence window.

### Masking conditions

1. The manual response was generated at `10:02:53.621 UTC`, before the scheduled invocation began. Its `drafts_created=0` was truthful for that first invocation.
2. `monitor-ses-makesafes` checks only the tail-call HTTP status and does not retain or surface the scan response body.
3. `ensureDraftAndJob()` commits artifacts and the draft before calling `approveIntakeDraft()`.
4. `approveIntakeDraft()` rejects the draft because `client_name` is actually null.
5. The runtime increments `report.totals.drafts_created` only after `ensureDraftAndJob()` returns. Because approval throws after the insert, the committed draft is never counted. The failure falls into the fixed `unclassified` write-failure bucket.
6. The draft's `missing_fields` is populated from `plan.blockedReasons`, not all missing identity/live fields. It is therefore empty even though `client_name` is null.
7. The post-rollback legacy scan later overwrote health with its own `usage_cap` state, obscuring the preceding deterministic write-failure reason while preserving the earlier degraded timestamp.

### Visible symptom

The first response showed a clean cycle-1 exception insert with zero drafts and zero write failures. Seconds later production held two deterministic artifacts and one unapproved deterministic draft, while the canonical case still showed its original `adapter_parse_failure` exception and no job.

This is not a false first-response count and not a legacy/deterministic race. It is a deterministic rerun planning divergence followed by pre-approval writes whose counters are updated too late to report them.

## Evidence

- `docs/evidence/makesafe-pr351-rerun-trigger-timeline-2026-07-21.json`
- `docs/evidence/makesafe-pr351-rerun-row-provenance-2026-07-21.json`
- `docs/evidence/makesafe-pr351-rerun-plan-divergence-2026-07-21.json`
- `docs/evidence/makesafe-pr351-canary-first-cron-2026-07-21.json`
- `docs/evidence/makesafe-pr351-canary-write-timeline-2026-07-21.json`
- `docs/evidence/makesafe-pr351-canary-post-rollback-state-2026-07-21.json`
