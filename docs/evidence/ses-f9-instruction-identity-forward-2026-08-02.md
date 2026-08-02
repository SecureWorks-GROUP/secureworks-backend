# SES F9: forward instruction identity gate

## Outcome

The forward path now treats one canonical builder instruction as one card. The
implementation landed in the required order: grammar and evidence authority
first, attach-time correction second, and the pre-mint gate last. F3 depends on
the canonical keys produced by F1/F2 and on F6 excluding internal cover sheets,
so placing it last keeps the mint decision on one shared identity boundary
(`supabase/functions/ops-api/makesafe_builder_work_order_identity.ts:248`,
`supabase/functions/ops-api/makesafe_instruction_mint_gate.ts:102`).

## Forward-only changes

- F1 accepts and preserves the optional MLB two-letter business-unit infix in
  the canonical claim/work-order key
  (`supabase/functions/ops-api/makesafe_builder_work_order_identity.ts:19`).
- F2 promotes an exact bare five-or-more-digit external reference only when the
  requesting company slug is exactly `aj`; the R2 key vocabulary remains limited
  to AJ, WB and KBA
  (`supabase/functions/ops-api/makesafe_builder_work_order_identity.ts:200`,
  `supabase/functions/ops-api/makesafe_builder_work_order_identity.ts:248`).
- F4 runs only after a newly attached typed work order. Missing/junk or
  corroborated internally-conflicting identity is corrected with a job event;
  a disagreement with one good key writes a visible conflict event and does not
  change identity
  (`supabase/functions/ops-api/index.ts:30549`,
  `supabase/functions/ops-api/index.ts:30950`,
  `supabase/functions/ops-api/makesafe_intake_settlement.ts:161`,
  `supabase/functions/ops-api/makesafe_work_order_identity_refresh.ts:129`).
- F6 recognises `work-order-SWMS-*.pdf` as an internal SecureWorks cover sheet,
  excludes it from instruction extraction and deterministic intake evidence,
  and refuses to count it as the typed builder-WO floor
  (`supabase/functions/ops-api/makesafe_builder_work_order_identity.ts:90`,
  `supabase/functions/ops-api/makesafe_deterministic_intake.ts:505`,
  `supabase/functions/ops-api/index.ts:13701`,
  `supabase/functions/ops-api/index.ts:17130`,
  `scripts/ses-measure-card-evidence.ts:129`).
- F3 pages all make-safe cards and their typed work-order documents, derives
  canonical keys using the same grammar, and refuses a match before the draft
  claim or job mint. Terminal matches become visible binding exceptions; they
  are never silently revived and never permit a second card
  (`supabase/functions/ops-api/makesafe_instruction_mint_gate.ts:102`,
  `supabase/functions/ops-api/index.ts:18221`,
  `supabase/functions/ops-api/makesafe_deterministic_intake_runtime.ts:3235`,
  `supabase/functions/ops-api/makesafe_intake_exception_cards.ts:505`).

No backfill, board re-key sweep, merge, archive, stage move, deploy, money-seal
change or production write is part of this change.

## Read-only current-board measurement

The privacy-safe Management API measurement selects only job references,
builder references/slugs and work-order filenames. Its request explicitly sends
`read_only: true` (`scripts/ses-f9-measure-instruction-identity.ts:62`). On
2026-08-02 it found:

- F1: 4 current cards newly readable by the MLB infix grammar.
- F2: 24 current cards newly readable by the exact `aj` bare-digit rule. This is
  the measured current value, not the earlier 26-card planning estimate.
- F6: 6 current cards lose their apparent builder work order because their only
  typed work order is a SecureWorks-generated cover sheet.

The aggregate fields and predicates are defined at
`scripts/ses-f9-measure-instruction-identity.ts:46` through
`scripts/ses-f9-measure-instruction-identity.ts:48`.

## Regression gates

- MLB infix, AJ-only bare digits, and non-AJ refusal:
  `supabase/functions/ops-api/makesafe_builder_work_order_identity_test.ts:11`.
- Good identity never overwritten and every correction/conflict visible:
  `supabase/functions/ops-api/makesafe_work_order_identity_refresh_test.ts:60`.
- Internal cover sheet fails both deterministic and board evidence floors:
  `supabase/functions/ops-api/makesafe_deterministic_intake_test.ts:892`,
  `supabase/functions/ops-api/makesafe_intake_auto_approval_test.ts:65`,
  `scripts/test/ses-measure-card-evidence_test.ts:166`.
- Existing terminal instruction is refused before mint and projected as a
  human-only exception:
  `supabase/functions/ops-api/makesafe_instruction_mint_gate_test.ts:23`,
  `supabase/functions/ops-api/makesafe_intake_exception_cards_test.ts:536`.

## Validation

The 15 focused identity, intake-runtime, attach, lifecycle, audit and evidence
test files passed together: **330 passed, 0 failed**. Changed TypeScript files
also passed `deno lint`, the formatted F9 files passed `deno fmt --check`, and
`git diff --check` passed.

The repository-wide `deno task test:ops-api` remains blocked during type-check,
before tests execute, by the pre-existing `(string | undefined)[]` to `string[]`
error in the untouched
`supabase/functions/ops-api/myjobs_all_means_all_test.ts:382`. F9 does not modify
that file.
