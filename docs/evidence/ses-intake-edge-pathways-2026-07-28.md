# SES intake edge pathways — production study

Date: 2026-07-28

Project: `kevgrhcjxspbxgovpmfl`

Mailbox: `ses@secureworkswa.com.au`

Change status: prepared for Captain review; not deployed or merged

## Safety and method

- Production access was read-only: Supabase `SELECT` queries and the repository's
  GET/HEAD-only `scripts/replay-makesafe-five-fates.ts` harness.
- No message was sent, no production row was changed, and no Edge Function was
  invoked through a write path.
- The sample covers 2026-05-29 through 2026-07-28. The live replay read 1,431
  persisted email sources and found all 36 independently catalogued shapes.
- The catalogue below uses a one-way structural source hash and UTC timestamp.
  It does not reproduce full bodies, names, addresses, phone numbers, or email
  local-parts.
- `emails`, `email_attachments`, `email_events_raw`,
  `email_classifier_exclusions`, `makesafe_intake_cases`,
  `makesafe_intake_case_sources`, and the operational-fact projection were
  compared. Current planner output was also compared with durable production
  fate.

## Finding: no persisted source is currently fate-less

At the study snapshot, every one of the 1,431 persisted email sources had one
planner fate and one durable fate. Durable missing count was zero. That closes
the literal "row exists but has no fate" crime for this window.

The risk is instead at two semantic boundaries:

1. **Operator-dark classifier exclusions.** The exclusion ledger contains 95
   source IDs since 2026-06-01, all with `reviewed=false`. Thirty-three came
   directly from builder-owned domains: `ajs.build` (18),
   `mlbuilders.com.au` (12), `westernbuild.com.au` (2), and
   `builderwest.com.au` (1). The exclusion is durable audit, but the message body
   is not persisted and the source never reaches deterministic case accounting
   or a Captain card.
2. **Wrong semantic fate.** Polite operational requests can contain `thanks` and
   be classified as non-work. The real urgent-report example at
   `2026-07-20T08:49:01Z` (`c2cb99ae6aefde65`) was the clearest instance.

Representative operator-dark sources:

| Source ID | Observed UTC | Domain | Baseline |
| --- | --- | --- | --- |
| `mailbox_f4e896189f11347b94730953c1d0454660986d1acbd6cb5f40e12e73ede73c63` | 2026-07-08 08:24:01 | `mlbuilders.com.au` | excluded, unreviewed |
| `mailbox_01c262dc7d8f1e331f947f71681123cc7f237875463de35e9c4883441e44a40e` | 2026-07-02 23:40:02 | `ajs.build` | excluded, unreviewed |
| `AAMk…AAAKGeBrAAA=` | 2026-06-15 06:57:58 | `builderwest.com.au` | excluded, unreviewed |
| `AAMk…AAAKGeDAAAA=` | 2026-06-15 06:47:04 | `westernbuild.com.au` | excluded, unreviewed |

## Complete observed-shape catalogue

`Baseline` is the current planner fate before this branch. `Pathway` states the
prepared behavior or the existing accountable path intentionally retained.

| Shape | Real example (UTC / source hash) | Baseline | Pathway |
| --- | --- | --- | --- |
| MLB named new WO + PDF | 2026-07-24 07:01:17 / `0f37be036aefde65` | live | Keep guarded live path. |
| Own completion/invoice pack | 2026-07-11 13:58:10 / `d0db98436aefde65` | non-work | Keep deterministic own-outbound accounting. |
| Own thread echo/twin | 2026-07-24 00:55:07 / `dfaaf4361ab66ea5` | non-work | Keep convergence and non-work accounting. |
| AJ Job No + PDF | 2026-07-24 02:07:26 / `3ab2c3eb6aefde65` | live | Keep guarded AJ live path. |
| Own photo evidence | 2026-07-06 06:44:59 / `f79251631ab66ea5` | non-work | Keep evidence-only accounting. |
| MLB “Our Ref” body-only | 2026-07-23 07:55:48 / `4ff95fbf6aefde65` | non-work | The sampled body says fencing is ready for collection; retain non-work. The old catalogue's `live_job` expectation is not supported by its own real example. |
| Prime portal notification | 2026-07-16 02:13:31 / `7070b7db1ab66ea5` | exception: conflicting fields | Keep visible exception; do not guess which embedded instruction owns the notification. |
| MLB unchanged-subject chase | 2026-07-24 00:47:54 / `1b32f2ec6aefde65` | exception: below identity floor | Recognise current-message “following up on” as a revision. Link as `revision_of` when the root is in evidence; otherwise remain a visible exception. |
| Own reply/forward | 2026-07-23 08:38:32 / `a804b4a76aefde65` | non-work | Keep own-domain accounting. |
| MLB portal-link-only new WO | 2026-07-22 02:37:45 / `2354646b1ab66ea5` | exception: parse failure | Keep visible; no auto-job without the required identity/evidence. |
| Own internal WO request | 2026-07-02 03:29:53 / `179916886aefde65` | non-work | Keep own-domain accounting. |
| Own site photos | 2026-06-21 15:42:38 / `216255c61ab66ea5` | non-work | Keep evidence-only accounting. |
| MLB urgent “Our Ref” | 2026-07-20 08:49:01 / `c2cb99ae6aefde65` | non-work | Move to reason-coded exception. “Please … report sent urgently. Thanks” is operational, but claim-only evidence cannot auto-mint. |
| MLB price request | 2026-07-24 07:48:31 / `c046d3f76aefde65` | exception: below identity floor | Keep visible for Captain judgment; never silently call it chatter or auto-mint from a claim alone. |
| MLB “Our Ref” + PDF | 2026-06-26 08:47:12 / `42baf49c1ab66ea5` | exception: parse failure | Keep visible recovery path. |
| Builderwest new WO, no PDF | 2026-06-24 03:03:50 / `9f815cae6aefde65` | exception: below identity floor | Keep visible; no claim-to-WO promotion. Direct Builderwest mail now enters capture. |
| MLB multi-unit new WO | 2026-07-23 08:27:42 / `235d2f636aefde65` | exception: parse failure | Keep visible; do not flatten multi-unit address evidence into a guessed job. |
| MLB Rapid Repair + PDF | 2026-07-23 07:41:39 / `e9c42cac1ab66ea5` | live | Keep deterministic live path. |
| MLB cancelled WO | 2026-07-21 23:48:40 / `e7dcb3816aefde65` | cancellation exception | Keep cancellation ledger path; never mint a new job. |
| AJ Job No, no attachment | 2026-07-06 22:46:51 / `e9f838b41ab66ea5` | live in replay, exception durable | Keep guarded evidence checks and visible durable recovery; no family semantics changed. |
| Own ops note | 2026-07-21 06:09:17 / `5b93c1fe1ab66ea5` | non-work | Keep non-work accounting. |
| MLB fencing quote PDF | 2026-07-21 07:16:33 / `d6bfb00d1ab66ea5` | exception: parse failure | Keep visible; Captain decides whether quote evidence is a new instruction. |
| MLB follow-up WO | 2026-07-21 00:16:13 / `c11ef38e6aefde65` | exception: parse failure | Keep explicit revision/recovery path. |
| AJ fencing pickup | 2026-07-15 01:57:45 / `7191686a6aefde65` | non-work | Keep collection chatter accounting. |
| Explicit system test / ignore | 2026-07-11 14:07:31 / `dbea11951ab66ea5` | blocked live | Move to accounted non-work. Exact explicit test/ignore wording only; signed live-fire fixtures remain work. |
| Non-builder external | 2026-07-10 05:58:54 / `b3c71b896aefde65` | exception: below identity floor | Keep visible when it carries builder identity; do not trust the sender or auto-mint. |
| MLB info-required “Our Ref” | 2026-07-01 01:46:25 / `e4e597831ab66ea5` | exception: below identity floor | Keep revision-shaped visible exception. |
| Builderwest invoice/report | 2026-06-17 02:29:57 / `edeb0e031ab66ea5` | non-work | Keep billing/report chatter accounting. |
| MLB reply “Our Ref” | 2026-07-23 01:32:04 / `5959c4436aefde65` | non-work | The sampled body says “please disregard job”; retain non-work. The old catalogue label is misleading. |
| AJ reply thread | 2026-07-06 22:46:52 / `1a0d1fa56aefde65` | live in replay, exception durable | Existing reply/revision guard remains; no automatic authority widening. |
| Builderwest reply thread | 2026-06-25 01:20:50 / `962c426f6aefde65` | exception: below identity floor | Keep visible revision-shaped exception. |
| Builderwest claim/ref/address | 2026-06-25 01:20:50 / `7e5043091ab66ea5` | exception: below identity floor | Keep visible; claim is not a WO. |
| Builderwest make-safe + report | 2026-06-10 05:59:55 / `035081421ab66ea5` | exception: below identity floor | Keep visible combined-obligation review; family matrix untouched. |
| Western make-safe WO subject | 2026-06-09 06:22:27 / `f866004c1ab66ea5` | live in replay, blocked durable | Keep Western adapter and evidence block; direct Western mail now enters capture. |
| Own route/signature test | 2026-06-09 04:32:05 / `270f1a391ab66ea5` | non-work | Keep own-domain accounting. |
| Builderwest new WO + PDF | 2026-06-03 05:56:24 / `8dbac79f1ab66ea5` | exception: below identity floor | Keep visible until canonical WO identity is proven; direct Builderwest mail now enters capture. |

## Additional edge checks

- **Duplicate/twin capture:** 369 twin groups were present in the independent
  corpus. Existing internet-message/ref/case-source convergence remains the
  pathway; regression coverage already proves twins and resends converge.
- **Attachment-only:** no external source with an attachment and a genuinely
  empty/near-empty body was found in this window. Existing attachment failures
  already produce `needs_review` or a typed source alarm; no fabricated
  production shape was added.
- **Multiple jobs in one email:** no external source contained more than one
  distinct canonical builder reference across subject and body in this window.
  No speculative splitter was added without a real payload.
- **Encoding/format:** 1,411 of the initial 1,428-row snapshot were HTML. The
  shared legacy HTML stripper remains authoritative. Current-message quote
  trimming is now reused for chatter/revision decisions so signatures and quoted
  work-order history cannot create work.
- **Handoff/runtime failures:** the source ledger already contained 12 HTTP 546
  and 6 HTTP 500 handoff exceptions, 111 bounded PDF deferrals, 22 lineage
  quarantines, 2 run-cap deferrals, and 2 source-persist failures. These remain
  typed operational facts and source alarms; the branch does not reinterpret
  bounded deferral as terminal failure.

## Prepared changes

1. Add the four observed direct builder domains to the anchored watched-sender
   floor. Their messages now reach deterministic accounting even when the
   database sender list or subject shape misses them.
2. Treat a canonical builder reference found only in the body as a capture
   signal. It enters deterministic review instead of an unreviewed exclusion.
3. Reuse current-message quote trimming for chatter/revision decisions.
4. A courteous operational request with strong builder identity becomes work-
   shaped and therefore a visible exception if it lacks canonical WO evidence.
   It never auto-mints from a claim alone.
5. Recognise the observed “following up on” body shape as a revision without
   matching the safe control “we will follow up with the tenant”.
6. Account explicit `SYSTEM TEST ... IGNORE` messages as non-work while
   preserving the separately authenticated synthetic live-fire lane.
7. Make the draft/job reconciliation invariant recognise canonical case-source
   fates, and fail closed over any genuine candidate miss so the fresh-source
   and unaccounted health surfaces cannot disagree.

No ES family enumeration or family matrix changed. No migration is required.

## Latency-scout reconciliation

The independent live-clock scout was reproduced read-only at
`2026-07-28T04:26:19Z`. The same `intake_health` response reported six raw
unaccounted rows, zero ledger-unfated sources, and three logical dual-capture
groups:

| Logical candidate | Received UTC | Raw rows | Canonical durable fate | Prepared reconciliation |
|---|---|---:|---|---|
| `MLB-24881` | 2026-07-28 00:11:32 | 2 | one case, `exception / below_identity_floor`, committed 92 seconds after receipt | Count the canonical case-source as the visible fate even though safety correctly produced no draft or job. |
| AJS `70062` | 2026-07-26 22:09:40 | 2 | one case, `accounted_non_wo / non_makesafe` | Count the canonical non-work case; do not invent a job from a bare-number report/invoice message. |
| `MLB-26721` | 2026-07-22 00:05:14 | 2 | one case, `exception / conflicting_fields`, `sibling_of`, committed 112 seconds after receipt | Count the canonical visible exception instead of requiring a draft or job. |

All six physical rows already had exactly one
`makesafe_intake_case_sources` row, and each twin pair pointed to the same
logical case. None had a classifier-exclusion row. Fresh-source health was
therefore correct to report zero unfated sources. The false positive came from
the legacy reconciliation invariant, which considered only drafts, jobs, and
its own classification replay while ignoring the canonical case spine.

The reconciled contract is:

```text
one physical source -> one canonical case-source fate
```

The read now resolves those case sources before asking whether a draft or job
exists. During a mixed-version rollout, the top-level health calculation also
combines the stored source-ledger count with any genuinely unaccounted
candidate count and uses the worse result. A missing case cannot be hidden by a
stale zero, while a safe exception case is no longer misreported as vanished.

## Captain review points

- The branch intentionally chooses **visibility over auto-creation** for urgent
  report chases and price requests. They become a revision or reason-coded
  exception, not a guessed live job.
- Adding direct builder domains increases the candidate set. Normal chatter is
  still accounted non-work; uncertain content becomes a visible exception.
- Two independent-catalogue expectations were contradicted by their own real
  examples (`MLB-OUR-REF-BODY-ONLY` and `MLB-RE-OUR-REF`). This branch follows
  the actual current message, not the old label.

## Validation

- Changed-file `deno check`: passed.
- Focused regression suite: 288 passed, 0 failed.
- Successful 60-day GET-only replay after the main pathway changes: 1,431
  sources, every source accounted, no increase in automatic live-job creation,
  and 30 previously non-work sources moved into visible exception accounting.
- The repository-wide baseline is not green independently of this branch:
  `deno task test:ops-api` stops on a pre-existing type mismatch in
  `ses_assembler_input_adapter_test.ts`, and the no-check runtime suite reports
  24 unrelated existing failures. Those failures were not modified or hidden.
