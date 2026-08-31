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

**The subsuming PO must be DECLARED.** `builderInstructionKeysForCard`
enumerates purchase orders out of attachment FILENAMES as well as the typed
triple, and MLB attaches every PDF of a claim to every card in that family
(AGENTS.md: DECLARED PO coverage 62/440 against OBSERVED 274/440 — "an observed
token is not ownership"). So the collapse takes its authority from
`declaredBuilderInstructionKeysForCard`, which reads the card's typed identity
(`builder_work_order_number` / `builder_claim_ref` / `builder_po_number`) and
its own stored external reference and deliberately ignores attachment names.
Pingelly is unaffected — its PO IS declared in `builder_po_number`. A claim-only
repair card carrying a sibling job's `work_order_PO-57087_*.pdf` keeps refusing
`multiple_instruction_keys` for human adjudication, instead of collapsing to one
key and then stamping the neighbour's PO as this card's money reference.
`declaredKeys` defaults to empty, so a caller that proves no provenance gets no
collapse.

### Which side of the mint gate reads which grain

This card's OWN identity reads the DISTINCT set with declared-PO-only
subsumption: the F9 conflict decision and `correlateIntakeApprovalIdentity`, the
availability probe's `candidateKeys`, and the mint reservation. The EXISTING
card's enumeration (`matchExistingInstructionCards`) stays FULL, so a re-send
showing only the work-order reference still finds the card it already has.
`recoveredPrimaryMint` and the atomic draft claim are untouched.

That asymmetry is a change from this branch's first pass, which kept the
candidate and reservation sides on the full enumeration too. Reserving the
claim-grain `MLB:WO-<claim>` key would DURABLY false-block every other purchase
order on that claim, because `makesafe_instruction_key_mints` rows persist after
a successful mint — and one MLB claim routinely hosts several POs, each its own
card (MLB-26183 carried three). The distinct set gives up one thing in exchange:
inside the narrow window where two drafts of the SAME instruction are approved
concurrently, one carrying WO+PO and the other carrying only the WO, the two
reserve different keys and no longer collide. **The trade is accepted
deliberately: a permanent wrong refusal is worse than a rare transient twin, and
the transient one is detectable and recoverable.** The race is not engineered
away in this change.

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

  **Measured exposure of the gap while it was open:** a read-only authenticated
  check on 2026-08-31 found ZERO `SWR-` jobs in the system — the three
  repair-marked cards are pre-type `SWMS-` rows. So the absent brake never fired
  live, most likely because Pingelly was the first arrival that qualified and
  the identity conflict of Defect 1 blocked it before it could mint. The gap was
  real and is closed here; nothing has to be unwound.

### Supervision must not cost the pack path

Parking the repair draft moves the mint onto the human lane, and that lane did
not bind the intake case. `makesafe_intake_cases.job_id` was written ONLY by the
deterministic runtime's own second `insertCaseAndSources(..., jobId)`, which
runs after the approval the brake now withholds; nothing else in the codebase
writes it, and the case cannot self-heal on a later sweep because its
`makesafe_intake_case_sources` row already makes the source a FINAL fate. A
caseless repair card is refused at `prepare_ses_docket_revision` with
`spine_missing_source` / `spine_missing_lineage`, so the whole pack path would
have been blocked for a physical-shaped family.

`bindIntakeCasesToMintedJobs` (`makesafe_intake_settlement.ts`) closes that at
the one shared seam that already holds both coordinates —
`makesafe_intake_job_mints` carries `case_id` from
`resolveDeterministicDraftMintAuthority` and `job_id` from `completeIntakeMint`
— so the binding now happens whichever lane approved the draft. It is a
compare-and-set on `job_id IS NULL` (never re-points a bound case), it promotes
only in the census-permitted `exception -> live` direction, and it
checks the job TYPE itself rather than letting
`enforce_makesafe_intake_case_write` decide: that trigger admits make-safe and
repair but RAISES for a restoration (`insurance`) job, so an unscoped write
would fail settlement for that family. The runtime is deliberately NOT allowed
to re-approve; that would restore the unsupervised `SWR-` mint through a side
door. Pinned by the binding cases in `makesafe_intake_settlement_test.ts`.

Two follow-on constraints that are easy to get wrong:

- **The blocked-live signal cannot be read off the parked case row.**
  `makesafe_intake_cases_exception_shape_check` forces
  `cardinality(blocked_reasons) = 0` on an unbound case, so `casePayload` stores
  `[]` on EVERY parked row however blocked its plan was — and a
  `blocked_live_job` plan (missing portal or secondary evidence) is the common
  repair shape. The coordinate that survives the park is the DRAFT's
  `missing_fields`, which the runtime writes from `plan.blockedReasons`, and the
  bind reads it back so the gap-fill queue and the intake exception desk keep
  seeing "live but short of evidence". Only a deterministic draft reaches this
  binding, because `intakeMintAuthority` yields no `case_id` without
  `extraction.deterministic_intake === true`.
- **The runtime must re-read the case it is about to re-decide.** Settlement
  runs INSIDE the guarded approval, so by the time the deterministic lane issues
  its own second `insertCaseAndSources` the row is already bound. Re-deciding
  against the stale pre-approval row computes `decisionChanged = true` and emits
  an UPDATE whose only real difference is the decision metadata — which
  `enforce_makesafe_intake_case_write` refuses ("decision metadata may change
  only with an audited case decision"), failing the case, degrading the run and
  permanently skipping its post-board notification. The second call therefore
  omits `knownExisting` entirely; the trigger branch is modelled by the `fail`
  hook in `makesafe_deterministic_intake_runtime_test.ts`.

### The brake that closes the property: the FINAL family, at the mint

The supervised-repair rule was being read at two different places from two
different inputs. `shouldAutoApproveCleanIntake` judges
`resolvedIntakeDraftFamily` (subject + preview + stored family); approval
derives its own from the full instruction text and only then applies the
complement, and `deterministicDraftFamilyForApproval` honours a stored family
only when `extraction.deterministic_intake === true`. A legacy-vintage draft
could therefore pass the sweep as `general_makesafe` and resolve to `repair` at
the moment of minting — an `SWR-` card with nobody's tick, on the one lane the
earlier rounds had not closed.

`approveIntakeDraft` now refuses (409, nothing written, draft left
`needs_review`) when the FINAL `approvedJobFamily` is repair AND the caller
carries the module-private `UNATTENDED_INTAKE_APPROVAL` marker. Every in-repo
automation lane stamps it — the clean-intake sweep, the re-extract auto-file,
the Auto-Intake v2 scan, and all three deterministic-runtime `approveDraft`
wirings (standing scan, fresh-source scan, source-persist recovery). Human and
API-operator approvals through the route are unchanged. The Symbol follows the
`SOURCE_PERSIST_NO_SEND_RECOVERY` precedent so no request body can forge it and
a new automation lane that omits it is a reviewable omission. The deterministic
lane's earlier park stays as belt-and-braces. Pinned by the paired
unattended/operator tests in `repair_intake_routing_test.ts`.

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
