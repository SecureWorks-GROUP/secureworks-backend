# F23 reporting-intake response contract — 2026-08-10

## Verdict

F23 is a backend response/write-boundary defect, not evidence that the reporting
route failed to start or that fourteen jobs disappeared. The earliest proven
divergence was inside `runMakesafeReportingIntakePass`: after the deterministic
scan had returned durable but degraded source-fate evidence, the runner still
entered `autoApproveCleanIntakeDrafts`, and the HTTP handler did not construct a
`Response` until that second live write phase finished.

The repair stops at that boundary. A degraded scan now returns a fixed-shape JSON
refusal before advancement. A healthy scan still performs the existing bounded
advancement sweep with its prior result semantics. Source-fate accounting,
health degradation, scan caps, authentication and exactly-once gates are
unchanged.

No production intake pass, stage action or write was run for this investigation.

## Exact response boundary and production timing

The read-only production edge record for the reported invocation contains:

- action start: `2026-08-10T06:49:20.615Z`
- edge completion: HTTP `200` at `2026-08-10T06:49:52.917Z`
- observed edge wall time: `32.302 s`

This falsifies an edge failure before dispatch and provides no evidence of a
platform timeout or HTTP 546 for that invocation. It does not prove that the
caller received or decoded a JSON body: the edge record exposes status and
timing, not response bytes.

The exact pre-repair backend boundary was the action return expression in
`supabase/functions/ops-api/index.ts`:

```text
json(await runMakesafeReportingIntakePass(client))
```

While the `await` was pending, no JSON `Response` existed. The runner performed,
in order:

1. one deterministic scan;
2. the durable source-fate accounting assertion;
3. an unconditional live `autoApproveCleanIntakeDrafts` sweep;
4. construction of the result later wrapped as JSON by the handler.

Therefore the earliest proven response/write divergence was between steps 2 and
3: `completion_status='completed_degraded'` and `write_failures>0` were accepted
past the scan boundary into a second write phase before a response was built.
PR 632 did not introduce this order; its `ops-api` change is confined to bounded,
idempotency-keyed Xero 429 retries.

The smallest counterfactual is to return a non-success JSON response immediately
after durable accounting when the scan is degraded. The diagnosis is falsified
if a deployed invocation still produces no caller-visible JSON while the edge is
shown to have returned the new fixed-size response bytes; that would put the
remaining loss after the backend response boundary.

## Repaired response contract

The handler now returns `makesafe-reporting-intake-pass.v2` with bounded scalar
counts rather than embedding the scan's variable-size failure arrays.

| Path | Second write sweep | HTTP | `error` | Measured body |
| --- | --- | ---: | --- | ---: |
| `write_failures > 0` | not started | 503 | `deterministic_write_failure` | 550 bytes |
| other degraded completion | not started | 503 | `deterministic_intake_degraded` | bounded by the same schema |
| completed scan | existing sweep retained | 200 | omitted | 501 bytes |
| thrown runner failure | not continued by this handler | 500 | `reporting_intake_pass_failed` | bounded fallback schema |

The body contains only the contract version, result/error, trigger and limits,
scan selection/totals, durable-accounting counts, and advancement counts. Fresh
tests prove that a deterministic write failure starts zero advancement calls and
that the healthy path still starts one. A healthy scan whose advancement result
contains `failed_count>0` retains the pre-F23 overall `ok:true`/HTTP 200 semantics;
F23 does not broaden into a new advancement ruling.

## Corrected intake-accounting denominator

The earlier provisional interpretation that `unaccounted=14` meant fourteen
genuine intake gaps is **disproved**.

The FirstMate-routed Board Agent durable reconciliation under
`corr=258355f55bec6e48` establishes the exact split:

- `0` genuinely unaccounted jobs;
- `13` canonically New jobs stale or blocked on `client_contact_required`;
- `1` job declared Allocated but hidden in New by canonical placement.

The intake queue is a capped 50-row window, not a total population. The legacy
health/reconcile aggregate is therefore not authority to turn those fourteen
rows into fourteen missing jobs. This session did not repeat Board Watch count
reconciliation and did not infer job truth from board columns.

## Intake-source residue

Targeted read-only verification found no incorrect live board-card client value.
For `MLB-26537`, live cards `SWMS-261049` and `SWMS-261058` remain correct; the
stale exception is source-authority residue from the earlier supervisor/client
misread. For `MLB-27227`, the client fill remains correct while the parsed `BOX`
identity and its reconciliation-only shadow remain historical residue.

The decisive ledger shape is source-level, not case-correction-only: the residue
probe reported `corrected_sources=2` and `case_correction_rows=0`. The old
gap-fill queue/apply boundary ignored the source correction and supersession
ledgers even though the canonical intake-exception projector applied them.

The repair extracts that projector's pure source-authority resolver and reuses it
at both gap-fill boundaries. A case is omitted/refused only when it has stored
sources and **zero** of those stored sources still resolves effectively to that
case after correction plus supersession. If one stored source still resolves to
the case, the queue retains it and apply remains allowed. Duplicate correction,
legacy mismatch, supersession-target mismatch and prior-authority mismatch all
fail closed before a write. Reconciliation-only `po_box_reconciliation@v1`
backfill rows are also omitted/refused before a fill.

No case, job, stage, board card or production ledger row was changed.

## Fresh validation

The adversarial red run produced four expected failures against the first patch:
source-corrected legacy residue remained in queue/apply, non-write degradation
was mislabeled as a write failure, and healthy advancement failures changed the
pre-existing overall result semantics.

The final focused green run used the repository's existing Deno binary directly:

```text
/Users/marninstobbe/.deno/bin/deno test --allow-env --allow-net=deno.land \
  supabase/functions/ops-api/makesafe_reporting_intake_pass_test.ts \
  supabase/functions/ops-api/makesafe_gap_fill_test.ts \
  supabase/functions/ops-api/makesafe_intake_exception_cards_test.ts \
  supabase/functions/ops-api/makesafe_intake_accounting_integration_test.ts
```

Result: `44 passed, 0 failed` in `304 ms` test time. The suite covers the
deterministic-write refusal, other degraded classification, healthy JSON path,
preserved advancement semantics, source correction plus supersession, the
one-still-effective-source invariant, shared queue/apply refusal, and the
unchanged canonical exception projector. Malformed legacy/supersession authority
fails closed in both gap-fill surfaces. The suite also retains the established
five-source accounting integration when a legacy test fixture omits the newer
completion-status field.

The repository-wide checked command currently stops before execution on two
unrelated optional-string type errors in `cp1_drag_reschedule_test.ts` (lines 466
and 508). A `--no-check` diagnostic run executed `3,965` tests: `3,937` passed,
`27` failed and `1` was ignored. Those broader failures are outside F23 and were
not changed or represented as green.

### Exact 27-failure diagnostic ledger

The first broad `--no-check` run is preserved exactly below. One failure (#7)
was caused by the first F23 patch and was repaired; one (#25) was a diagnostic
permission omission rather than a product assertion; the other 25 exercise
functions, fixtures or source contracts outside the two repaired boundaries.
After #7 was fixed, rerunning all named failing files produced `309 passed, 26
failed`; the remaining identities were unchanged.

| # | Exact test identity | File:line | Classification and observed reason |
| ---: | --- | --- | --- |
| 1 | `review approval isolates existing-job linking before duplicate/create paths` | `makesafe_aj_intake_reconciliation_test.ts:152` | Unrelated static ordering assertion: the current duplicate-guard marker is not before the create-call marker. F23 changes neither branch. |
| 2 | `2.2 an un-sent AUTHORISED job with a report stays below Docs Ready` | `makesafe_audit_test.ts:456` | Unrelated placement assertion: the fixture was not retained in `trade_report_in`. Board stage derivation is outside F23. |
| 3 | `makesafe_board serves the captain display ledger with a healthy multi-issue intake projection` | `makesafe_board_intake_exception_degrade_test.ts:457` | Unrelated placement assertion at line 479: current `canonical_stage` was `new`, expected `archive`. The intake projection itself was healthy. |
| 4 | `dry-run replay and exact dark observe take no business-write branch` | `makesafe_deterministic_intake_migration_test.ts:379` | Unrelated source invariant: the deterministic runtime currently contains a console call. No runtime scanner file changed here. |
| 5 | `ruling 5 terminal skill hook stays deterministic and non-privileged` | `makesafe_deterministic_intake_migration_test.ts:816` | Unrelated source/allowlist drift: the sliced routine allowlist did not contain `makesafe_deterministic_intake_dark_observe`. |
| 6 | `claimDraftPackForDrafting: failed packs are retryable only by privileged callers` | `makesafe_draft_pack_action_test.ts:1135` | Unrelated fixture drift: its fake client has no `upsert` for the current report-pack-cycle bind. |
| 7 | `reporting boundary proves five injected durable fates and exposes their U1 facts` | `makesafe_intake_accounting_integration_test.ts:85` | F23 compatibility regression in the first patch: an older fixture omitted `completion_status` and was treated as degraded. Repaired by refusing only an explicitly non-`completed` status; now green in the checked 44-test run. |
| 8 | `makesafePipeline keeps an AUTHORISED report job in trade_report_in` | `makesafe_lifecycle_test.ts:173` | Unrelated placement assertion: the expected card was absent from `trade_report_in`. |
| 9 | `makesafePipeline lets an invoiced job with both docs reach completed` | `makesafe_lifecycle_test.ts:216` | Unrelated placement assertion: the expected card was absent from `completed`. |
| 10 | `recheck queue: returns unverified report cards with portal links, shaped for capture` | `makesafe_portal_truth_test.ts:345` | Unrelated portal-queue assertion: current count was `2`, expected `1`. No portal query or link predicate changed. |
| 11 | `reconciliation approval flags remain explicitly privileged and opt-in` | `makesafe_reconcile_corrections_test.ts:393` | Unrelated source-string assertion: current `index.ts` lacks the expected `body?.report_unsubmitted === true` literal. |
| 12 | `reportIn wiring: re-attend cycle 2 with only a cycle-1 report -> refused` | `makesafe_report_in_guard_test.ts:117` | Unrelated report-cycle guard assertion: the fixture did not reject. No report-in/cycle guard changed. |
| 13 | `send_pack: happy path -> ONE authorise + ONE email + marker + close` | `makesafe_resume_phase1b_test.ts:339` | Unrelated pack fixture: attendance-cycle binding failed with `missing cycle identity` before the asserted path. |
| 14 | `send_pack: approved photos are normalised and sent as the immediate follow-up` | `makesafe_resume_phase1b_test.ts:379` | Same unrelated attendance-cycle fixture failure: `missing cycle identity`. |
| 15 | `send_pack: pack report_doc_id anchors the emailed report when duplicate reports exist` | `makesafe_resume_phase1b_test.ts:428` | Same unrelated attendance-cycle fixture failure: `missing cycle identity`. |
| 16 | `send_pack: legacy MLB rows use the vetted MLB report-recipient backstop` | `makesafe_resume_phase1b_test.ts:487` | Same unrelated attendance-cycle fixture failure: `missing cycle identity`. |
| 17 | `resume: authorised_not_sent re-call emails ONCE and does NOT re-authorise` | `makesafe_resume_phase1b_test.ts:538` | Same unrelated attendance-cycle fixture failure: `missing cycle identity`. |
| 18 | `D-d: email DISPATCH THROWS (timeout/network) -> status='sending', NOT authorised_not_sent` | `makesafe_resume_phase1b_test.ts:690` | Unrelated send-pack counter assertion: authorise count was `0`, expected `1`. F23 does not touch send/authorise. |
| 19 | `D-d: email returns 5xx (ambiguous) -> status='sending', NOT authorised_not_sent` | `makesafe_resume_phase1b_test.ts:730` | Unrelated send-pack counter assertion: authorise count was `0`, expected `1`. |
| 20 | `D-d: AMBIGUOUS 4xx (e.g. 408 timeout) -> 'sending', NOT authorised_not_sent` | `makesafe_resume_phase1b_test.ts:758` | Unrelated send-pack counter assertion: authorise count was `0`, expected `1`. |
| 21 | `D-d: a marker-step throw AFTER a successful send -> sent_marker_failed (NOT authorised_not_sent)` | `makesafe_resume_phase1b_test.ts:787` | Unrelated send-pack counter assertion: email count was `0`, expected `1`. |
| 22 | `D-d contrast: a CLEAN 4xx pre-dispatch reject -> authorised_not_sent (re-send is safe)` | `makesafe_resume_phase1b_test.ts:819` | Unrelated send-pack counter assertion: authorise count was `0`, expected `1`. |
| 23 | `photo follow-up action: in-flight photo pack blocks before any fetch/email` | `makesafe_stage1_send_parity_test.ts:572` | Unrelated pack fixture drift: got `pack cycle detail read failed (photo): missing detail`, not the expected in-flight-status refusal. |
| 24 | `default makesafe-board v1 includes the additive intake exception desk` | `makesafe_state_compare_test.ts:161` | Unrelated serialized board-shape drift: current output includes `decision_required`; the expected fixture does not. |
| 25 | `artifact byte hashing stays inside a constrained worker heap` | `ses_artifact_hash_budget_test.ts:36` | Diagnostic-command issue, not a product failure: the broad command omitted `--allow-run`, so the test could not spawn the absolute Deno binary. |
| 26 | `assessment hash evidence distinguishes stale versioning from content drift` | `ses_assembler_input_adapter_test.ts:3714` | Unrelated fixture-version drift: current family matrix was `2026-08-07.1`, expected `2026-08-04.1`. |
| 27 | `the drop migration owns the effective obligation and bind bodies` | `ses_readiness_precondition_drop_test.ts:119` | Unrelated migration-inventory drift: current selected migration was `20260804010000_ses_invoice_bound_docket_idempotent_adopt.sql`, expected the older `20260803010000` file. |

Production deployment and live route invocation were deliberately not tested.
