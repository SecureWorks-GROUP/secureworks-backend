# Make-safe deterministic intake zero-match diagnosis

**Diagnosis date:** 2026-07-21 AWST  
**Code baseline:** `d3377d1` plus filed gate evidence commit `171b421`  
**Production mode:** `legacy` throughout  
**PII handling:** client names, addresses, phones, email addresses, refs, subjects and source IDs are omitted. Job IDs are retained as permitted.

## Reproduction and write safety

The privileged `SW_API_KEY` was not available in this worker environment, so the documented production HTTP replay was not called again. Diagnosis used:

1. The filed dry-run response `makesafe-deterministic-intake-replay-2026-07-21-clean-window-14d.json`.
2. Authorized production `SELECT` queries for the identical bounded window, 2026-07-06T23:12:39.950Z through 2026-07-20T23:12:39.950Z.
3. The current-main pure deterministic planner over those selected rows. No production mutation API was called.

The local planner reproduced the filed response exactly: 260 sources, 128 cases, 223 exception source outcomes, 37 non-work source outcomes, zero confirmed outcomes, zero unaccounted sources, and identity floor 0/89.

The filed post-observe database proof records zero canonical cases, case sources, case events, deterministic artifacts, deterministic drafts and live-cursor movement. A fresh read-only check also found zero rows on those business surfaces, `intake_mode=legacy`, empty source and instruction allowlists, and a null live scan cursor. The replay implementation returns before all case, draft, job, storage and health business-write code. Its only permitted dry-run write is the separate observe cursor.

## Facts from the clean 14-day window

| Fact | Count |
|---|---:|
| SES mailbox sources | 260 |
| Own-domain outbound copies | 90 |
| Inbound sources | 170 |
| Identity-floor candidate cases in the filed planner | 89 |
| Candidate cases inbound-only | 49 |
| Candidate cases outbound-only | 35 |
| Candidate cases containing both directions | 5 |
| Candidate cases with a legacy draft | 44 |
| Candidate cases with a legacy job link | 22 |
| Candidate cases with an uploaded PDF | 63 |
| Candidate cases missing deterministic `client_name` | 89 |
| Candidate cases reasoned `below_identity_floor` | 72 |
| Candidate cases reasoned `conflicting_fields` | 17 |

After applying only the proven legacy inbound filter and HTML-to-text shaping during diagnosis, the same rows produced 51 known-builder candidate cases: 48 `below_identity_floor`, 3 `conflicting_fields`, and still 0 live-ready cases. Every one still lacked deterministic `client_name`. This proves composition and raw HTML amplified the result but were not the universal initiating cause.

## Trigger, masking conditions and visible symptom

### Initiating trigger

`identityFloorFacts()` treated only `confirmed_live_job` and `blocked_live_job` as an identity match. The core manifest simultaneously classified `client_name` and `site_address` as identity-blocking requirements. Recent MLB/AJ mail carries a canonical builder WO, PO or claim ref in deterministic text, but the client name is commonly available only to the legacy model from the attached image-font work-order PDF. The repository's PDF reader documents that current MLB PDFs decode as repeated locale noise and cannot yield that client name without vision.

The exact chain was:

1. `fieldCandidates()` could not produce `client_name` from the real email text.
2. `manifestFor()` marked `client_name` as `blocking: "identity"`.
3. `buildDeterministicIntakePlan()` put the field in `missingIdentity` and assigned `below_identity_floor`, even when `woPoIdentityKey` or `externalRefCanonical` existed.
4. `identityFloorFacts()` equated that non-live-ready state with no canonical identity.
5. All 89 denominator cases therefore reported as unmatched.

This conflated two different facts: canonical builder-instruction identity and readiness to create a new live job. Missing image-PDF client data is a real recovery blocker, but it is not evidence that a deterministic WO/PO/ref comparison failed.

### Additional code defects that masked the result

1. **Mail composition:** deterministic replay did not use the legacy own-domain filter. Thirty-five denominator cases were outbound-only copies. Empty source and instruction allowlists did not cause this: with no allowlist, `runDeterministicIntake()` deliberately plans the full read. The empty lists only prevent live business selection.
2. **Field shape:** deterministic runtime passed raw HTML to text regexes. The legacy path first calls `stripEmailHtmlForTrade()`. Raw newline-free HTML hid labels and let address regexes consume trailing reply markup, creating false field conflicts. HTML stripping reduced candidate conflicts from 17 to 3 but did not recover the image-PDF client names.
3. **Metric semantics:** work-order attachment and portal-capture readiness also influenced case state, so the old identity metric could count a canonical instruction as an identity miss solely because a later live artifact was pending.
4. **Replay completeness contract:** the filed response had `backlog_rows=250`, a non-null next cursor, and `cap_reached=false` because the implementation compared the overlapping backlog-plus-recent raw count with 500. An exact as-of production count confirms there were 260 rows and the historical planner happened to account for all 260, so this defect did not create the 0% denominator in this window. The response itself could not prove that fact and therefore was not valid clean evidence.
5. **Source identifier leak:** public aggregate `source_read` included internal tuple tie-breaker post IDs. The filed JSON had to redact them.

### Visible symptom

The aggregate replay displayed identity floor 0/89 and gave the impression that no real builder email carried usable deterministic identity, while every candidate actually lacked the same job-material field and many retained a canonical builder WO/PO/ref.

## Five concrete legacy-success traces

The trace handles are one-way truncated hashes used only to distinguish rows in this diagnosis. No source ID or client PII is recorded.

| Trace | Legacy-linked job ID | Legacy result | Exact deterministic loss on current main |
|---|---|---|---|
| `1b6e5b88ed22` | `23bfb12b-270a-48d3-9776-67f4ca8fe0e0` | Approved; model path populated required job fields; draft ref equals job ref | MLB adapter found external ref, WO and PO. `fieldCandidates()` found no client label, so `manifestFor(client_name: identity)` fed `missingIdentity` and the `below_identity_floor` branch. |
| `99a4e08532b7` | `9ba9fb79-48cc-4f34-af05-17423e3f1308` | Approved; model path populated required job fields; draft ref equals job ref | Same rule and field as trace 1. Canonical WO/PO evidence was present; `client_name` alone caused the identity failure. |
| `da6afb3c14ef` | `81af9850-26b2-4afa-8eef-489d37383088` | Approved; model path populated required job fields; draft ref equals job ref | Same rule and field as traces 1 and 2. One uploaded PDF was available, but deterministic runtime read only attachment metadata. |
| `9df2bec3d53d` | `7dea664a-e0d7-4263-ab0c-bacea9e1d65d` | Approved; model path populated required job fields; draft ref equals job ref | Prime wrapper retained canonical ref/PO evidence. Raw HTML/thread values compared unequal for phone, email and address in `bestIdentity()`, so `Object.keys(conflicts).length` selected `conflicting_fields`; client name was also missing. |
| `05b85afc4672` | `90a238b4-986b-4fdd-83e0-464b00bde16a` | Approved AJ job; model path populated required job fields; draft ref equals job ref | AJS/AJBR adapter found the builder job/WO identity. Raw HTML-derived site-address candidates compared unequal in `bestIdentity()`, selecting `conflicting_fields`; client name was also absent. |

Sanitized equivalents of these three MLB, one Prime and one AJ structures are regression-tested in `makesafe_deterministic_intake_runtime_test.ts`. They contain no real source IDs, refs or client data.

## Disconfirming evidence checked

The leading explanation would be wrong if current-main replay also failed on rows with a deterministically available client name, or if body shaping alone restored the floor.

- Filed run 06 reached 96/223 cases (43.05%) in an older slice. That proves the adapter can reach live-ready state when older source composition supplies all required fields. It does not disprove the recent-format failure.
- Replaying the clean window with `body_preview` only remained 0%. Replaying with the exact legacy HTML stripper also remained 0%. The stripper reduced false conflicts but every candidate still lacked `client_name`.
- Removing own-domain-only traffic still left the inbound floor at 0%. Mail composition was not the universal cause.
- An exact production count was 260, matching the planner's 260 accounted sources. Cap ambiguity did not remove rows from this particular denominator.
- All five traced legacy drafts record a model call and all five deterministic cases have canonical builder evidence. The difference is consistent with the legacy model reading document content while the deterministic runtime reads body text and attachment metadata only.

Conclusion: this was several code defects, led by identity/readiness conflation, with outbound composition and raw HTML as secondary amplifiers. It was not a healthy matcher with only a bad denominator.

## Authorized fix scope

The fix:

1. Accounts own-domain copies as non-work before adapter identity classification, using the shared legacy direction helper.
2. Supplies regex adapters the same stripped-text body shape as legacy while extracting links from raw HTML.
3. Defines a reached identity as known company plus strong canonical WO/PO identity. Claim-only work remains below the floor and cannot enter confirmed-live state.
4. Keeps missing client/address/PDF/portal evidence loud as `adapter_parse_failure`; it does not pretend those cases are ready to create jobs.
5. Calculates the identity floor from canonical instruction identity rather than live-job readiness.
6. Removes tuple post IDs from aggregate responses.
7. Makes a full backlog/recent page or a partial sweep ineligible for clean evidence, and exposes bounded `max_sources` so an operator can obtain a true one-response sweep.

No AI call, mode flip, allowlist change, backfill, live-cursor movement, client communication or activation is included.

## Read-only post-fix projection

The fixed planner was run over the same 260 production rows through SELECT-only access. It returned 51 known-builder work candidates, 50 with strong canonical WO/PO identity, for 98.04%. AJ reached 8/8 and MLB reached 42/43. AI calls and unaccounted sources remained zero.

The one shortfall is a known-builder claim-only case with no deterministic builder WO or PO. It is intentionally unmatchable under the safety rule that claim-only evidence cannot enter confirmed-live state. Missing client data remains visible on all 51 candidates as job-readiness recovery, mostly `adapter_parse_failure`, rather than being mislabeled as 51 identity misses.

Evidence: `makesafe-deterministic-intake-replay-2026-07-21-post-fix-read-only-projection.json`.

This projection is not represented as a fresh production endpoint replay. Production still runs the pre-fix current-main function in `legacy` mode. The repository deploy rule permits `ops-api` deployment only from merged `main` in the release worktree, so the final fresh `max_sources=1000` dark replay must be filed after merge and authorized dark deployment.
