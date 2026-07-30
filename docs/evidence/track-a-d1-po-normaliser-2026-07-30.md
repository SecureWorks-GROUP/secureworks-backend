# Track A D1: PO normaliser identity poisoning — deployed-source verification and data repair

Date: 2026-07-30. Contract: `TRACK-A-INTAKE-DIFF-2026-07-30.md` (secureworks-wiki
PR 233), divergence D1. All production access below was strictly read-only
(management-API `database/query` SELECTs and a GET of the deployed function
bundle). No production write of any kind was made.

## 1. The deployed normaliser matches the worktree fix

Deployed `ops-api` inspected directly: version **937** (ACTIVE, updated
2026-07-28, deployed from the CI runner path
`/home/runner/work/secureworks-backend/secureworks-backend/...`). The ESZIP2.3
bundle was downloaded via the management API and the relevant modules extracted
with the eszip parser. The bundle stores type-stripped transpiled sources, so
the comparison is on the load-bearing grammar and logic, which match the
worktree exactly:

- `functions/ops-api/makesafe_builder_work_order_identity.ts` (deployed):
  `PO_LABEL_PATTERN = "(?:P\s*O|purchase\s+order)"`, `PO_TAIL_PATTERN`,
  `PO_RE` (digits required directly after the label), `LOOSE_PO_RE`,
  `BUILDER_REF_WITH_PO_RE`, `BUILDER_REF_RE` — all identical to the worktree
  file. "P.O. Box 1234" and "PO sent 24/6" cannot parse as a PO.
- `functions/_shared/makesafe_intake_case_model.ts` (deployed):
  `MAKESAFE_NORMALISER_VERSION = "makesafe_refs.normaliseRef+wo_po_precedence@v2"`,
  identical `wo:<wo>/po:<po>` precedence chain, identical
  `OPAQUE_SEPARATORS` / `WO_SEPARATORS`.
- `functions/ops-api/makesafe_deterministic_intake.ts` (deployed): the planner
  PO is sourced solely from `sharedIdentity.builder_po_number`
  (`const po = sharedIdentity.builder_po_number;`); no second permissive PO
  regex exists anywhere in the deployed module.
- `functions/ops-api/index.ts` (deployed): `distinctWorkOrderSignals` uses the
  digits-only `/PO[-#:]?\s?(\d{3,})/gi` with the same "PO Box can't match"
  comment as the worktree.

Behavioural corroboration (read-only SQL, 2026-07-30): every case with
`upper(builder_po_canonical) IN ('BOX','SENT')` carries
`normaliser_version = ...@v2` and none was created after the 2026-07-29
watermark. 0 new cases post-watermark are poisoned.

## 2. Poisoned population and existing coverage

Read-only probes on 2026-07-30:

- 335 cases `builder_po_canonical = 'BOX'` (196 distinct refs incl. the SENT
  case's ref), 1 case `'SENT'`, **all 336 with `job_id IS NULL`** (exception /
  accounted lanes only — no poisoned identity reached a live job).
- All 335 BOX cases are covered by
  `makesafe_intake_case_authority_corrections` rows from round one
  (`20260724025815_makesafe_lineage_authority_corrections.sql`: 369 case
  corrections, 600 source corrections, corrected authority cases minted with
  `normaliser_version ...+po_box_reconciliation@v1`).
- The single SENT case has **no correction coverage**: case
  `34848e85-dda7-44b0-8abd-cca721ea2068`, `wo_po_identity_key = 'po:SENT'`,
  ref MLB-24481, exception lane, minted 2026-07-21 from the chaser email
  "Do we have an install date. PO sent 24/6." (subject
  "Our Ref: MLB-24481 - 29 Gymea Ct, Armadale - Client Ref: 13330402 - Other
  Ref:", two transport rows — one Graph id, one mailbox hash id, no
  attachments — both owned solely by this case).

## 3. The repair: migration `20260730090000_makesafe_po_sent_identity_correction.sql`

Committed, **not applied** — the captain gates deploy, and the standard lane
(`scripts/apply-pending-migrations.sh`) applies it before the next gated
`ops-api` deploy.

Shape, following the round-one precedent exactly:

- Widens the correction-kind vocabulary with `false_po_sent` (case and source
  ledgers plus the source shape constraint; a `false_po_sent` source
  correction has the same legacy-case/effective-case/no-target-job shape as
  `false_po_box`).
- Re-derives the SENT case identity from its raw sources in SQL under the v2
  grammar and refuses to run unless the derivation still holds: neither
  source's subject+body parses a canonical PO (digits directly after the
  label), both name claim MLB-24481.
- Binds both transport rows to the round-one corrected authority
  `5d252e8a-6883-45dd-97fd-61ef4cb50785` (the MLB-24481 GENERAL_MAKESAFE
  partition) with the round-one expected-identity convention
  `ref:MLB-24481`, and appends one case authority correction carrying the
  legacy typed ancestry.
- Aborts the whole transaction unless the full reviewed snapshot still
  matches: legacy case row, both email content hashes, sole source ownership,
  zero attachments, the 335/1 population split, zero poisoned cases with a
  job, intact round-one BOX coverage, unchanged effective authority (2
  round-one source corrections, no supersessions).
- Ends by asserting the closing invariant: **every** poisoned case (336/336)
  has corrected-authority coverage.
- Never updates or deletes a source, case, job, assignment, draft, status or
  communication row. Migration-provisioned databases take the schema change
  and skip the data correction (footprint gate).

Every guard predicate was validated read-only against production on
2026-07-30 (all pass; the v2-grammar re-derivation returns
`canonical_po_found = false`, `mlb_digits = '24481'` for both sources).

## 4. Fixture tests

`supabase/functions/ops-api/makesafe_po_sent_identity_correction_test.ts`
pins the two real poisoned shapes (P.O. Box signature block; the verbatim
MLB-24481 "PO sent 24/6" chaser) to null PO / no identity key, and pins the
repair direction: a real work-order filename PO token still recomputes to the
digits-only canonical identity. 5/5 pass under
`deno test supabase/functions/ops-api/makesafe_po_sent_identity_correction_test.ts`.

## 5. Replay evidence

See section "D1" in the five-fates shadow replay note appended alongside the
D8 evidence (`docs/evidence/track-a-d8-duplicate-transport-2026-07-30.md`):
the replayed planner (worktree = deployed grammar) plans the SENT pair with
`builder_po_number = null`, claim MLB-24481 — below the identity floor, the
truth-set fate for this source — and plans zero `BOX`/`SENT` PO identities
across the replayed corpus.
