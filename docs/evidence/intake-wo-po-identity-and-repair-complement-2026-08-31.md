# Intake WO+PO identity conflict + identified-WO repair complement — 2026-08-31

Two defects at the SES intake approval seam, one branch. Worked case:
MLB-24645 / PO-59875, 22 Pitt Street, Pingelly WA 6308 (draft
`815eea5e-1b6f-43ad-b955-ed79d55f356a`, ML Builders, Colorbond fencing
supply-and-install — the captain's live repair job).

## Defect 1 — one work order carrying both numbers refused as two instructions

The captain's Approve returned, verbatim:

> Approve failed: Instruction identity conflict: draft carries multiple
> canonical keys (MLB:PO-59875, MLB:WO-24645); review required and no card was
> minted

Mechanism, confirmed against the live draft's extraction: the structured triple
(`builder_claim_ref: MLB-24645`, `builder_po_number: PO-59875`) and the
work-order filename both derive the PO-grain key `MLB:PO-59875`, while the bare
`external_ref: MLB-24645` — with the draft's `repair` family — derives the
repair WO-fallback key `MLB:WO-24645`. `builderInstructionKeysForCard`
enumerates per source, so one instruction with two identifiers read from
sources of unequal completeness enumerated two keys, and both the correlate
gate (`multiple_instruction_keys`) and the F9 guard refused.

Fix: `distinctBuilderInstructionKeys` in
`makesafe_builder_work_order_identity.ts` — under the sealed 2026-08-02 grain
ruling (the PO is the job; the WO/claim is the GROUP), a `SCOPE:WO-n` key is
the repair fallback for having no PO, so a same-scope `SCOPE:PO-m` key subsumes
it. Nothing else collapses: two PO keys are still two instructions, a WO key
under a different builder scope still conflicts, `AJ:JOB-n` is untouched. The
existing test `makesafe_instruction_key_po_grain_test.ts` PROBE 7 already
specified this grain for the single-string form ("the work-order grain is the
fallback for having no PO, not an override"); this change applies the same
grain at the card level.

Two consumers decide conflicts on the distinct set: the F9 guard in
`approveIntakeDraft` (`index.ts`) and `correlateIntakeApprovalIdentity`.
`matchExistingInstructionCards` / `assertInstructionCardMintAvailable` and the
mint reservation deliberately keep the FULL enumeration, so a WO-keyed
existing card still blocks a twin of the same instruction, and a WO-only
re-send still finds its card. `recoveredPrimaryMint` and the atomic draft
claim are untouched.

## Defect 2 — captain ruling 2026-08-31, the identified-WO repair complement

> A properly identified, readable work order that is NOT general make-safe, NOT
> a roof report, NOT an assessment/quote report, and NOT a temporary fence
> make-safe **is** repair.

The 2026-08-25 scout report ("Why the proposed negative complement is unsafe",
`repair-siphon-intake-scout`) is answered as the captain answered it: the
complement is correct only once the identity and evidence floor has already
been passed. Implementation:

- `applyIdentifiedWorkOrderRepairComplement` (`makesafe_intake_gate.ts`) fires
  only on a genuine abstention (`ambiguous_scope`) with a readable extracted
  scope block and exactly one canonical instruction key at the repair grain.
  Restoration parks (`text_restoration_park`, `ajs_restoration_park`) and every
  positive classification pass through untouched.
- Deterministic fate ladder (`makesafe_deterministic_intake.ts`): consumed at
  the LAST exception rung, after chatter, cancellation, unknown-builder,
  quote-stage, conflicting-fields, identity-floor and parse-failure rungs have
  all fired. A cross-source family CONFLICT also keeps parking (its items carry
  positive `job_family:` evidence, not `ambiguous_scope`).
- Approval fallback (`approveIntakeDraft`): the same complement replaces the
  blanket `|| "general_makesafe"` default, floor-gated identically. Reviewed
  and persisted deterministic families still win outright.
- No auto-mint widening — but NOT for the reason first written here. The
  `repair_family_supervised_review` brake (`shouldAutoApproveCleanIntake`,
  `index.ts`) covers only the SWEEP/BOARD lane; it has no call site on the
  deterministic lane, which reaches `approveIntakeDraft` directly with its own
  `reviewed_fields.makesafe_job_family`. So since PR #771 the deterministic lane
  has auto-approved repair-family cases (declared-repair headers and
  replacement-verb classifications alike) with nobody's tick on them, and the
  complement would have widened the population reaching that gap. THIS change
  extends supervision to the deterministic lane:
  `deterministicPlanNeedsSupervisedRepairReview`
  (`makesafe_deterministic_intake_runtime.ts`) withholds the guarded approval
  call for any plan whose reviewed family is `repair`. The draft is still
  written and stamped and left `needs_review`, the run accounts the case as
  `job_creation_deferred`/parked, and a human approves it from the review queue.
  Pinned by the parked/CONTROL pair in
  `makesafe_deterministic_intake_runtime_test.ts`.

## Evidence — the 23 currently-untyped review-queue drafts

`sw_list_intake_drafts` snapshot 2026-08-31 (50 returned of 67 total across
`draft,needs_review`); 23 drafts carry no `report_type`. Each was run through
the REAL modules (`decideDeterministicMakeSafeJobFamily` over its extracted
scope block + declared type, then the complement with its two floors). Result:

- **23 of 23 classify positively** (22 via the WO PDF's declared-type header,
  Pingelly via the 2026-08-28 replacement-verb ladder). The complement fires on
  **zero** of them, and every stored deterministic family stands:
  9 temp_fence_makesafe stay temp fence, 13 general_makesafe stay make-safe,
  and Pingelly stays repair.
- Every one of the 23 resolves exactly one distinct repair-grain key
  (`MLB:PO-*`), i.e. the Defect-1 collapse also unblocks any of them that
  carries a bare external_ref beside its PO.
- **Flagged, not changed:** `cea2fec4` (MLB-24473, 9 Hansa Place Marangaroo)
  carries stored family `general_makesafe` from an older classifier vintage,
  while a FRESH classification of its scope yields
  `repair/repair_replacement_scope`. The stored deterministic verdict wins at
  approval by design, so approving it as-is mints an SWMS make-safe. The
  operator can supply `reviewed_fields.makesafe_job_family = "repair"` at
  approval; re-running the classifier over pre-verb-ladder stored verdicts is
  a separate decision, deliberately not taken here.

Raw per-draft output is reproduced in the PR body.

## Validation

- `deno check --config deno.jsonc supabase/functions/ops-api/index.ts` clean;
  every changed file passes `deno check` individually.
- Full `deno test --no-check … supabase/functions/ops-api/` failure set is
  **byte-identical** between base `39af8c47` and this branch (40 pre-existing
  failures, 0 new; 4661 → 4682 passing).
- New regressions: `makesafe_instruction_key_po_grain_test.ts` PROBE 9,
  `makesafe_intake_approval_identity_test.ts` (Pingelly ready + two-PO still
  refuses), `repair_classifier_routing_test.ts` complement + boundary controls,
  `makesafe_deterministic_intake_test.ts` fate-ladder complement + four
  controls (temp fence, general make-safe, restoration park, unknown builder).

## UX companion

`secureworks-ux` `ops.html` intake review panel: the family help text and the
approve button predate repair (PR #771) and restoration. Companion PR updates
`getMakesafeFamilyLabel`, the helper text, and makes the approve button name
the family that will actually be created (SWR- for repair).
