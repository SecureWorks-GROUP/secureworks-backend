# SES Phase A/B certificate — 2026-08-01

This is the rollback anchor at the Phase A/B boundary. It certifies a state of
production, not a state of this repository: every claim below was re-proved
read-only against the live database by
`scripts/ses-ab-certificate-checker.ts` immediately before this document was
committed, and can be re-proved at any time by running it again.

**Result: 22/22 PASS — CERTIFIABLE, with one named legacy exception.**

> **Read the 2026-08-01 addendum at the end of this document before quoting any
> count from the body.** The C3 work-order re-attachments briefly took this
> certificate to 19/22. It is green again, but the merge-group counts, the
> disposition counts, the drain-minted job list and the phase A census
> expectations below have all been superseded there — and one newly visible
> group is held for a captain ruling under decision key
> `duplicate-mlb-27100-po-56960-survivor`.

The captain's live board review on 2026-08-01 added check `b10`: no card may
carry a blank or absent work-order identity. Production has exactly one such
card, `SWMS-26001`, ruled a **named legacy exception** on 2026-08-01 under
decision key `swms-26001-work-order-identity`. The rule stays strict for every
other card in the 437-card population. See **The named legacy exception —
`SWMS-26001`** below; it is the one thing a reader of this certificate must
carry forward.

- Checker: `scripts/ses-ab-certificate-checker.ts`
- Certified baseline: `scripts/ses-ab-certificate-v1.baseline.json`
- Work-order merge accounting: `scripts/ses-ab-certificate-v1.duplicate-accounting.txt`
- Machine-readable run: `docs/evidence/ses-ab-certificate-2026-08-01.run.json`
  (`started_at` 2026-08-01T07:21:11.837Z, `finished_at` 2026-08-01T07:21:34.384Z)

```bash
SUPABASE_ACCESS_TOKEN=... scripts/ses-ab-certificate-checker.ts \
  --output docs/evidence/ses-ab-certificate-2026-08-01.run.json
```

Exit code 0 means every check passed; 1 means at least one failed. The checker
reaches production only through the Supabase Management API `/database/query`
endpoint with `read_only: true`, and additionally refuses, before the request
leaves the process, any statement that is not a single `SELECT`/`WITH`, names a
write verb, or names a client-identifying column. No client name, phone, email
or street address is read; nothing in the checker reads suburb either.

## Scope — what this certificate does and does not cover

This certificate covers **card identity** only:

- **existence** — the card is there, and the two captain-ruled creations exist;
- **type and family** — `jobs.type`, `metadata.makesafe_job_family`, and
  `makesafe_job_details.report_type` / `.requesting_company_slug`, as the
  adjudicated verdict table advanced by the applied ledgers demands;
- **work-order identity** — every card carries a non-blank builder work-order
  reference, and every intake source resolves to exactly one canonical case.
  One named legacy exception, `SWMS-26001`, is carved out and documented below;
- **duplicates** — every builder work order that resolves to more than one card
  is adjudicated, and no card is archived as a duplicate outside that set.

It does **not** cover **evidence completeness or display fields**. Specifically
out of scope, and **not** implied by any PASS below:

- **suburb extraction** — whether `site_suburb` is present, correct, or
  correctly derived from the source;
- **PDF attachment presence** — whether a card's work-order PDF, report pack,
  photos or other artifacts are attached, complete, or legible;
- **reference display** — how a reference renders on the card, including the
  bare-versus-full `external_ref` string forms;
- more broadly, whether a card's evidence supports the stage it displays.

**Those are Phase C.** A card can pass every check here and still be missing its
report, its photos or its suburb. Treat a PASS as "this card is the right card,
correctly identified and not a duplicate", never as "this card is complete".

## What is proven

### Phase A — intake source and case accounting

| Check | Claim | Observed |
| --- | --- | --- |
| `a1` | every physical SES source has exactly one canonical case-source row | 1499 emails = 1499 case-source rows = 1499 distinct post ids |
| `a2` | no persisted SES email lacks a case-source row | 0 |
| `a3` | identity keys are fully accounted | 534 certified identities, membership-continuous; 160 live-job + 370 exception-only + 4 synthetic, 0 residue |
| `a4` | certified live-case identity continuity | 0 missing or jobless of 161 certified live cases |
| `a5` | nothing points at a missing job | 0 dangling case, correction-target and source-link job ids |
| `a6` | no identity key carries two live case-bound jobs | 0 |
| `a7` | the first captain-ruled creation exists | `SWMS-261123`, family `roof_report`, `external_ref` MLB-27309, case `confirmed_live_job` on `wo:MLB-27309/po:PO-57445` |
| `a8` | the second captain-ruled creation exists | `SWMS-261124`, display stage `archive`, `INV-0754` AUTHORISED ACCREC linked |

#### The 533 → 534 reconciliation

The task brief specifies 533 identity keys (156 live-job / 373 exception-only /
4 synthetic). Production reads **534 (160 / 370 / 4)**, and the two figures
cannot both be true at once: the brief's census is the pre-recovery snapshot,
and the recovery is itself one of the brief's own Phase A requirements.

PR 460's captain-ruled exact rescan promoted one case that was parked as
`exception / adapter_parse_failure` — an unreadable PDF, therefore **no**
`wo_po_identity_key` — to `confirmed_live_job`, carrying the newly extracted key
`wo:MLB-27309/po:PO-57445`. That is `SWMS-261123`, which check `a7` requires to
exist.

The re-certification snapshot now records the current membership: 534 keys,
160 live-job, 370 exception-only and 4 synthetic, plus all 161 current live
case ids. It includes the three verified exception-to-live promotions. The
earlier 158/157 figures were pre-growth certification numbers superseded by
this snapshot; future checks compare membership and transitions, not pinned
counts.

### Phase B — the adjudicated verdict table, advanced by the applied ledgers

The verdict table is not asserted as written. It is folded forward through every
ledger production actually applied, in application order, and only the resulting
end state is diffed against the live board:

```
round 1 (PR 454)  ->  round 2 field (PR 458)  ->  round 2 temp fence (PR 458)
                  ->  SWMS-26692 family backfill (PR 463)  ->  captain holds
```

| Check | Claim | Observed |
| --- | --- | --- |
| `b1` | the committed round-1 fixture still hashes to its ledger's value | `8c2d5e02…3970df`, 194 applied / 0 skipped |
| `b2` | the committed round-2 fixture set still hashes to its ledger's value | matched; 4/7 field, 56/1 temp fence, 260/29 links |
| `b3` | round 2 superseded the round-1 family axis on exactly the recorded cards | 40 |
| `b4` | the live board matches the advanced verdict table | 216 assertions, **0 mismatches** |
| `b5` | every documented captain hold still carries its held value | `SWMS-26894` still `general_makesafe` |
| `b6` | every applied source-to-job link is live, and none exists beyond the ledger | 260 ledger writes, 260 present, 260 table rows |
| `b7` | every adjudicated stray carries the detail row that puts it on the board | 4/4 |
| `b8` | the applied duplicate-survivor archives are exactly the adjudicated set | 3 pointers, tranches t1 and t2 |
| `b9` | no survivor is itself terminal or itself an archived duplicate | 3/3 clean |
| `b10` | no card carries a blank or absent work-order identity, outside named legacy exceptions | 437 population, 0 unexcepted, 1 named exception, 0 stale |

### The named legacy exception — `SWMS-26001`

**This is the one carve-out in the certificate. Read it before relying on `b10`.**

The captain's rule is that a blank or absent work-order identity is impossible.
The checker takes the canonical board population (`makesafe`, plus
`insurance`/`restoration`, `status <> 'lost'`, terminal synthetic live-fire jobs
excluded) — 437 cards — and requires each to carry a `makesafe_job_details` row
whose `external_ref` is non-null and non-blank. A card with no detail row at all
has no identity in a harsher form, so it counts as an offender too.

Exactly one card offends, and it is ruled an exception rather than a defect to
fix:

| Fact | Value |
| --- | --- |
| Card | `SWMS-26001` |
| Decision key | `swms-26001-work-order-identity`, ruled by the captain 2026-08-01 |
| Status / created | `archived`, 2026-06-01 — the **oldest make-safe card in production** |
| Suburb | Joondalup |
| `makesafe_job_details` rows | 0 (so no `external_ref`, no `requesting_company_slug`) |
| Work-order documents | 0 |
| Intake cases | 0 |
| Work evidence | 1 assignment, 1 submitted service report, 4 media, 9 job events |

Why it is an exception and not a repair:

- **Pre-window and gmail-sourced.** The shadow adjudication could match it only
  by address-street against a `gmail.com` sender, which is below the identity
  floor. **No builder work-order identity is recoverable**, so there is nothing
  correct to write into a detail row.
- **Real work, evidenced.** A submitted service report, four media and a
  completed assignment. This is not a phantom card and is not to be deleted.
- **Not new damage.** It is the single `target_detail_not_found` skip already
  recorded in the round-2 link backfill, which `b6` counts among that ledger's
  documented skips. What the captain's rule adds is that it had only ever been
  recorded as a *link-backfill skip reason*, never as an identity defect in its
  own right.

**Conversion path.** If the captain later supplies the builder work order for
this card, convert the exception to a backfill: write the
`makesafe_job_details` row with that `external_ref`, remove the entry from
`card_work_order_identity_exceptions` in the baseline, and re-run.

The exception cannot outlive the defect it covers. It excuses exactly one named
card, and the checker separately reports any named exception whose card has
since gained an identity as `stale_exceptions`, which fails the run — so a
backfilled card forces the entry to be removed rather than leaving a permanent
hole in the rule. The expected unexcepted-offender count stays **0**, and a test
pins it: adjudicate a new offender under its own decision key, never raise the
number.

`b2` records one benign artefact. The round-2 ledger hashes a six-file
concatenation whose first member is the `makesafe_source_job_links` migration,
and the committed migration ends one newline shorter than the text hashed at
apply time — repo formatting landed after the run. The checker tries both
variants and reports which matched (`migration_trailing_newline`). Content is
byte-identical otherwise; this is a formatting difference, not a fixture change.

### Droid cross-check — the work-order merge list

The merge list is **derived at run time**, not copied: the checker reads every
`job_documents` work-order filename through the production identity grammar
(underscores normalised to spaces, per `AGENTS.md`) and keeps every canonical
builder work order that resolves to more than one make-safe card. A group that
appears in production and not in the accounting fixture is reported
`unaccounted` and fails the run, so a new duplicate cannot appear silently.

| Check | Claim | Observed |
| --- | --- | --- |
| `d1` | every merge-list work order is adjudicated | 19 groups = 16 historical + 3 drain-minted, **0 unaccounted**, 0 stale fixture rows |
| `d2` | each group still has exactly the cards it was adjudicated with | 0 drifted |
| `d3` | production still matches every adjudicated disposition | 0 failures; 4 archived-with-pointer, 8 adjudicated-not-duplicate, 1 captain-excluded, 6 open hold |
| `d4` | the drain-minted duplicate jobs are exactly the adjudicated three | `SWMS-261059`, `SWMS-261078`, `SWMS-261118` |

Each disposition is verified against production, not merely recorded:
`archived_duplicate_pointer` requires exactly one in-group duplicate pointer
whose target is another member of the same group; the other three dispositions
require that **no** member carries a pointer, so nothing can be archived under
an unruled hold; `open_hold` additionally requires that no unruled hold has more
than one live card competing for one work order; and `captain_excluded` requires
that the condition the exclusion rested on — both cards already displaying
`archive` — still holds.

## The family supersession ruling

**The production decider on full post-drain inputs is authoritative.** Where
round 2's `decideMakeSafeJobFamily`, run on inputs the PDF drain had since made
readable, re-labelled a card that round 1 had already labelled, round 2 wins.

This affects exactly **40 cards**: the intersection of the 114 family targets in
the round-1 SAFE fixture and the 56 cards in the round-2 temp-fence class. On
those 40, the round-1 fixture's family value is recorded as **superseded**, not
counted as a mismatch. Check `b3` asserts the count is exactly 40 and the run
JSON lists every card by name under `superseded_family_cards`.

Without this rule, `b4` would report 40 false mismatches against a board that is
correct. With it, `b4` reports 216 assertions and zero mismatches. The rule
narrows what the certificate claims on the family axis — it certifies the
current production decider's verdict, not the round-1 adjudication's — and that
narrowing is the point.

## Evidence pointers

### Merged pull requests (all in `SecureWorks-GROUP/secureworks-backend`)

| PR | Title |
| --- | --- |
| [448](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/448) | feat(ops-api): add durable PDF-to-board make-safe intake |
| [452](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/452) | fix(ops-api): restore authenticated SES PDF drain |
| [453](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/453) | fix(ops-api): repair make-safe board v2 projection inputs |
| [454](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/454) | fix(scripts): apply audited safe MakeSafe board corrections |
| [455](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/455) | feat(ops-api): self-sync PDF drain API key to Vault |
| [456](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/456) | fix(ops-api): preserve valid deterministic intake instructions |
| [457](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/457) | fix(ops-api): archive verified duplicate make-safe board cards |
| [458](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/458) | fix(ops-api): apply adjudicated MakeSafe board fixes |
| [459](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/459) | fix(migrations): unblock duplicate-survivor archive apply |
| [460](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/460) | feat(ops-api): recover captain-authorized missed SES jobs |
| [461](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/461) | fix(ops-api): safely apply duplicate-survivor board corrections |
| [462](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/462) | fix(migrations): renumber SES recovery migration |
| [463](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/463) | fix(scripts): complete tranche 2 board corrections and family backfill |

### Applied ledgers read by the checker

- `scripts/board-safe-fixes-v1.apply-ledger.json` (PR 454) — 194 applied, 0 skipped
- `scripts/board-fixes-round2-v1.apply-ledger.json` (PR 458) — 4 field, 56 temp-fence, 260 link, 3 population; 37 documented skips
- `scripts/board-duplicate-survivors-v1.tranche1-apply-ledger.json` (PRs 457/459) — 2 archives
- `scripts/board-duplicate-survivors-v1.tranche2-apply-ledger.json` (PRs 461/463) — 1 archive
- `scripts/swms-26692-family-backfill-v1.apply-ledger.json` (PR 463) — 1 applied
- `docs/evidence/makesafe-duplicate-survivors-2026-08-01.md` — the survivor adjudication and both execution records

### Independent verification reports relied on (named, not pathed)

- **four-vendor board audit 2026-07-31** — the 432-card adjudicated verdict
  table, its SAFE / PENDING-DRAIN / CAPTAIN fix list, and the
  `duplicate-survivor-policy` decision keys this certificate treats as open
  holds
- **shadow adjudication 2026-08-01** — the source/case connectivity adjudication
  behind the 260 link backfills and the two captain-ruled creations
- **Grok round-2 verification 431/432** — four independent read-only production
  slices over the same 432-card board, verifying PR 458's apply ledger
- **Droid verification 2026-08-01** — the duplicate/merge cross-check whose
  accounting this certificate re-derives and re-proves

## Open captain holds NOT covered by this certificate

The certificate proves that production matches what was adjudicated and applied.
It does **not** rule on anything still awaiting the captain. These remain open
and are explicitly outside its scope:

### Touching work orders the certificate covers

- **`SWMS-26894` temp-fence label.** The only temp-fence relabel round 2 skipped
  (`captain_hold_temp_fence`). Live is `general_makesafe`; the source PDF and the
  persisted draft both describe a 16 m temp fence. The certificate proves the
  hold is *intact*, not that the label is right. Decision keys:
  `temp-fence-umpire-v1-decision-swms26894-scope-anchor`,
  `ses-held-pile-packet-v1-decision-swms26894-scope-anchor`.
- **MLB-23067 / PO-54811 (`SWMS-26845` / `SWMS-26920`).** Adjudicated, then
  deliberately excluded from the apply set because both cards already display
  `archive`. If either returns to a live stage the group is already adjudicated
  and can be applied without re-litigating the survivor pick.
- **PO-53964 (`SWMS-26706` / `SWMS-26957`).** The duplicate-survivor
  re-verification adjudicated this pair *not* a duplicate (two POs, two declared
  instructions), while an independent verification slice registered
  `grok-board-verify-s3-decision-dup-po-53964-survivor` asking for a survivor
  pick. The certificate records the not-a-duplicate disposition, which production
  matches; the disagreement itself is unresolved and is the captain's.

### The six unruled merge groups the accounting fixture marks `open_hold`

`MLB-25076PO-52377`, `MLB-25321PO-52394`, `MLB-25857PO-53193`,
`MLB-26177PO-53982`, `MLB-26721PO-55622`, `MLB-24749PO-56699`. Each carries a
registered `duplicate-survivor-policy` decision key from the four-vendor board
audit. The certificate proves only that none has been archived behind the
captain's back and that none has two live cards on one work order.
`MLB-26177PO-53982` additionally sits behind
`makesafe-board-30day-reconcile-plan-v1-decision-inv0819-false-draft-void`.

### The six PDF-proven duplicate pairs never in scope

`SWMS-261057/261081`, `SWMS-26728/26856`, `SWMS-26740/26859`,
`SWMS-26748/26858`, `SWMS-26755/26844`, `SWMS-26819/26871`. None overlaps the
nine nominated groups, so none was adjudicated by the survivor ruling. They do
not appear on the derived merge list because each pair's PO is recoverable from
only one card's filename, which is exactly why they need the captain rather than
a rule.

### Other open SES holds outside this certificate

Builder-as-client remediation (31 cards); re-adjudicating 49 stale exception
instructions now their PDFs are readable; writing off 170 sourceless backfill
exceptions; splitting degenerate `po:BOX` cases; survivors for the 17 re-mint
orphan pairs excluded from the link backfill as
`scope_excluded_remint_supersession_captain_pile`; disposition of the 2 certain
and 2 probable open instructions; the family-value reclassifications
(`SWMS-261057`, `SWMS-26706`, `SWMS-26714`) and the Grok family spot-check;
the evidence-ruler rulings (PO evidence floor, GHL/Prime equivalence,
report-ready authority, repair and restoration recipes, cancelled-card floor).

## Re-running this certificate

The checker is the certificate's only load-bearing artefact; this document
explains it. Re-run it whenever the board state is in question — after any
future tranche, after a drain window, or before Phase C work touches this
ground:

```bash
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/ses-ab-certificate-checker.ts
```

If a new duplicate work order appears, `d1` reports it as `unaccounted` and the
run fails. If a hold is quietly written through, `b5` or `d3` fails. If a
survivor is archived out from under its own duplicate, `b9` fails. If a card
loses its work-order identity, `b10` fails — and so does a named exception that
no longer offends. The correct response to any failure is to adjudicate it under
its own decision key, not to widen the baseline.

## Run output

The run embedded below is the one this certificate rests on. It is reproduced
verbatim, and its machine-readable form is
`docs/evidence/ses-ab-certificate-2026-08-01.run.json`.

```text
PASS phase_a  a1_sources_equal_case_rows         every physical SES source has exactly one canonical case-source row
       expected {"emails":1499,"case_source_rows":1499,"distinct_source_post_ids":1499}
       observed {"emails":1499,"case_source_rows":1499,"distinct_source_post_ids":1499}
       note     emails == case_source_rows == distinct post ids
PASS phase_a  a2_emails_without_case             no persisted SES email lacks a case-source row
       expected 0
       observed 0
PASS phase_a  a3_identity_key_census             identity keys are fully accounted as live-job / exception-only / synthetic
       expected {"unaccounted":0,"partition_complete":true,"keys_lost":0,"live_job_regression":0,"synthetic":4,"missing_certified_keys":[],"synthetic_identity_drift":[],"live_job_regression_keys":[]}
       observed {"unaccounted":0,"partition_complete":true,"keys_lost":0,"live_job_regression":0,"synthetic":4,"missing_certified_keys":[],"synthetic_identity_drift":[],"live_job_regression_keys":[]}
       note     census invariant, not a pinned count: certified floor 534 total / 160 live-job / 370 exception-only / 4 synthetic; live now 534 total (+0) / 160 live-job (+0) / 370 exception-only / 4 synthetic. Re-certification snapshot, 2026-08-01: certified identity manifests are diffed by membership. Every certified key and live case must remain present, live-job keys may not regress, exception-only keys may promote to live, the synthetic identity set is closed, and growth above the snapshot is reported rather than failed. Never trim or re-snapshot the manifest to make a failure green. The brief's pre-recovery census was 533 total / 156 live-job; the certified manifest is the current re-certification snapshot.
PASS phase_a  a6_keys_with_two_live_jobs         no identity key carries two live case-bound jobs
       expected 0
       observed 0
PASS phase_a  a4_live_case_without_job           no confirmed_live_job case is missing its job
       expected {"live_case_without_job":0,"missing_certified_live_cases":[],"certified_live_cases_without_job":[]}
       observed {"live_case_without_job":0,"missing_certified_live_cases":[],"certified_live_cases_without_job":[]}
       note     certified identity set 161 live cases; live now 161 (+0 post-baseline intake growth).
PASS phase_a  a5_dangling_job_ids                no case, correction target or source link points at a missing job
       expected {"case_job":0,"target_job":0,"link_job":0}
       observed {"case_job":0,"target_job":0,"link_job":0}
PASS phase_a  a7_captain_creation_roof_report    SWMS-261123 exists as a roof_report card with lineage to MLB-27309
       expected {"family":"roof_report","external_ref":"MLB-27309","requesting_company_slug":"mlb","case_state":"confirmed_live_job","identity_key":"wo:MLB-27309/po:PO-57445","case_sources_at_least":true,"work_orders_at_least":true}
       observed {"family":"roof_report","external_ref":"MLB-27309","requesting_company_slug":"mlb","case_state":"confirmed_live_job","identity_key":"wo:MLB-27309/po:PO-57445","case_sources_at_least":true,"work_orders_at_least":true}
PASS phase_a  a8_captain_creation_historical_backfill SWMS-261124 exists, displays archive and carries INV-0754
       expected {"family":"general_makesafe","external_ref":"BWCWA-6648","requesting_company_slug":"bw","display_after_status":"archive","invoice_rows":1,"corrections_at_least":true}
       observed {"family":"general_makesafe","external_ref":"BWCWA-6648","requesting_company_slug":"bw","display_after_status":"archive","invoice_rows":1,"corrections_at_least":true}
PASS phase_b  b1_round1_fixture_integrity        the committed round-1 fixture still hashes to the value its apply ledger recorded
       expected {"fixture_sha256":"8c2d5e02c2d19de7d2c71014766a5e3a2a37afc36aca3f54f1b4adb4203970df","applied":194,"skipped":0}
       observed {"fixture_sha256":"8c2d5e02c2d19de7d2c71014766a5e3a2a37afc36aca3f54f1b4adb4203970df","applied":194,"skipped":0}
PASS phase_b  b2_round2_fixture_integrity        the committed round-2 fixture set still hashes to the value its apply ledger recorded
       expected {"matched":true,"field_applied":4,"field_skipped":7,"temp_fence_applied":56,"temp_fence_skipped":1,"link_applied":260,"link_skipped":29}
       observed {"matched":true,"field_applied":4,"field_skipped":7,"temp_fence_applied":56,"temp_fence_skipped":1,"link_applied":260,"link_skipped":29}
       note     hash variant matched: migration_trailing_newline
PASS phase_b  b3_family_supersession             round 2's production decider superseded the round-1 family axis on exactly the recorded cards
       expected 40
       observed 40
       note     FAMILY TRUTH RULE: the production decider on full post-drain inputs is authoritative; the superseded round-1 family values are recorded, not counted as mismatches.
PASS phase_b  b4_board_field_diff                the live board matches the adjudicated verdict table advanced by the applied ledgers
       expected {"assertions":216,"mismatches":0}
       observed {"assertions":216,"mismatches":0}
PASS phase_b  b5_documented_holds_untouched      every documented captain hold still carries its held value
       expected [{"card":"SWMS-26894","family":"general_makesafe"}]
       observed [{"card":"SWMS-26894","family":"general_makesafe"}]
PASS phase_b  b6_source_job_links                every applied source-to-job link is live and no link exists beyond the ledger
       expected {"ledger_writes":260,"present":260,"table_rows":260}
       observed {"ledger_writes":260,"present":260,"table_rows":260}
       note     documented skips: {"scope_excluded_remint_supersession_captain_pile":17,"duplicate_fixture_same_binding":6,"job_external_ref_mismatch":5,"target_detail_not_found":1}
PASS phase_b  b7_board_population                every adjudicated stray carries the make-safe detail row that puts it on the board
       expected [{"job_number":"SWMS-26931","external_ref":"MLB-24664","has_detail":true},{"job_number":"SWMS-26932","external_ref":"MLB-24465","has_detail":true},{"job_number":"SWMS-26936","external_ref":"MLB-MW-26873","has_detail":true},{"job_number":"SWMS-26978","external_ref":"MLB-24659PO-56155","has_detail":true}]
       observed [{"job_number":"SWMS-26931","external_ref":"MLB-24664","has_detail":true},{"job_number":"SWMS-26932","external_ref":"MLB-24465","has_detail":true},{"job_number":"SWMS-26936","external_ref":"MLB-MW-26873","has_detail":true},{"job_number":"SWMS-26978","external_ref":"MLB-24659PO-56155","has_detail":true}]
PASS phase_b  b8_duplicate_survivor_pointers     the applied duplicate-survivor archives are exactly the adjudicated set
       expected [{"loser":"SWMS-261118","survivor":"SWMS-261065","run_key":"makesafe-duplicate-survivors-20260801-t1"},{"loser":"SWMS-26791","survivor":"SWMS-26787","run_key":"makesafe-duplicate-survivors-20260801-t2"},{"loser":"SWMS-26998","survivor":"SWMS-26736","run_key":"makesafe-duplicate-survivors-20260801-t1"}]
       observed [{"loser":"SWMS-261118","survivor":"SWMS-261065","run_key":"makesafe-duplicate-survivors-20260801-t1"},{"loser":"SWMS-26791","survivor":"SWMS-26787","run_key":"makesafe-duplicate-survivors-20260801-t2"},{"loser":"SWMS-26998","survivor":"SWMS-26736","run_key":"makesafe-duplicate-survivors-20260801-t1"}]
PASS phase_b  b10_card_work_order_identity       no card carries a blank or absent work-order identity, outside named legacy exceptions
       expected {"board_population":437,"unexcepted_offenders":0,"named_exceptions":1,"stale_exceptions":0}
       observed {"board_population":437,"unexcepted_offenders":0,"named_exceptions":1,"stale_exceptions":0}
       note     named legacy exceptions: SWMS-26001 (swms-26001-work-order-identity)
PASS phase_b  b9_survivors_not_stranded          no survivor is itself terminal or itself an archived duplicate
       expected [{"job_number":"SWMS-261065","terminal":false,"pointers":0},{"job_number":"SWMS-26736","terminal":false,"pointers":0},{"job_number":"SWMS-26787","terminal":false,"pointers":0}]
       observed [{"job_number":"SWMS-261065","terminal":false,"pointers":0},{"job_number":"SWMS-26736","terminal":false,"pointers":0},{"job_number":"SWMS-26787","terminal":false,"pointers":0}]
PASS droid    d1_merge_list_accounted            every work order production resolves to more than one card is adjudicated
       expected {"groups":21,"historical":17,"drain_minted":4,"unaccounted":0,"stale_fixture_rows":0}
       observed {"groups":21,"historical":17,"drain_minted":4,"unaccounted":0,"stale_fixture_rows":0}
PASS droid    d2_merge_group_membership          each adjudicated group still has exactly the cards it was adjudicated with
       expected 0
       observed 0
PASS droid    d3_dispositions_hold               production still matches every adjudicated disposition
       expected {"failures":0,"counts":{"archived_duplicate_pointer":4,"adjudicated_not_duplicate":9,"captain_excluded":1,"open_hold":6,"captain_hold_live_pair":1}}
       observed {"failures":0,"counts":{"archived_duplicate_pointer":4,"adjudicated_not_duplicate":9,"captain_excluded":1,"open_hold":6,"captain_hold_live_pair":1}}
PASS droid    d4_drain_minted_duplicates         the drain-minted duplicate jobs are exactly the adjudicated set
       expected ["SWMS-261059","SWMS-261078","SWMS-261081","SWMS-261118"]
       observed ["SWMS-261059","SWMS-261078","SWMS-261081","SWMS-261118"]

SES A/B certificate checker: 22/22 PASS (phase A 8/8, phase B 10/10, droid 4/4) — CERTIFIABLE
```

## Addendum — 2026-08-01, re-certified after the C3 work-order re-attachments

The certificate above was re-proved and is green again. Between the original run
and this one it went to **19/22**, and this addendum records why and what was
decided. Nothing in the body above is retracted; this section supersedes the
`d1`/`d3`/`d4` counts and the phase A census expectations it names.

### What broke it

The C3 work-order re-attachments (PRs 466/469/470) copied builder work-order
PDFs onto cards that were missing them. Two of those attach targets landed on a
work order an OLDER card already carried, so production began resolving two
multi-card work-order identity groups that had never been adjudicated, and `d1`
reported them `unaccounted`. Separately, ordinary intake promoted three
exception-only identity keys to live jobs (`160 -> 160` live-job, `370 -> 370`
exception-only, total unchanged at 534; live cases `161 -> 161`), which failed
the then-pinned `a3`/`a4` census equality.

Neither was a data defect. The re-attachments are correct and the census move is
healthy growth.

### The two groups, adjudicated

**`MLB-26246PO-54129` -> `SWMS-26748`, `SWMS-26858` — `adjudicated_not_duplicate`.**
The single PO-54129 work order declares TWO deliverables in its own text:
`Notes/Instructions: Assessment Report & Quote`, plus `Notes: ... temp fence
required`. Each card carries its own separately-priced invoice for a different
one — `SWMS-26748` holds INV-0820 $786.50 referenced `MLB-26246 - Temp Fence
Make-Safe` with two 2026-06-24 attendances, and `SWMS-26858` holds INV-0880
$165.00 AUTHORISED (the assessment price) with the pack sent to the builder on
2026-07-17 and the portal marked complete. The "one instruction" precondition
for archiving a duplicate therefore fails, and both cards carry real billed
work; archiving either would hide a separately invoiced deliverable, one of them
AUTHORISED. Recorded as not-a-duplicate, no write applied.

Noted in passing, and deliberately NOT fixed here: `SWMS-26748`'s
`assessment_report_quote` family is a known mis-derivation. Its family was
"corrected" on 2026-07-21 by reading the shared PDF's assessment line, and U4
rejected the card on 2026-07-28 because that classification does not match the
sealed builder-family matrix. It is really the temp-fence card. Repairing it is
that card's own work.

**`MLB-27100PO-56960` -> `SWMS-261057`, `SWMS-261081` — `captain_hold_live_pair`,
decision key `duplicate-mlb-27100-po-56960-survivor`.**
This one IS a single instruction: PO-56960 declares only `Roof Reports / Roof
Report Request`, a two-storey roof report, and firstmate triage on 2026-07-28
independently flagged the pair as one job from the same 2026-07-23 email. The
survivor, however, is genuinely undecidable under the captain's standing
survivor ruling:

- The PO-bearing `external_ref` sits on `SWMS-261057` (`MLB-27100PO-56960`), but
  `AGENTS.md` explicitly forbids deriving the survivor from the `external_ref`
  string form — the `SWMS-261118` / `SWMS-261065` precedent went the other way.
- The fallback limb, "the evidence-carrying worked card", does not separate them
  either: neither card has an assignment, service report, media item or invoice.
- The two discriminators that do exist point in OPPOSITE directions.
  `SWMS-261057` holds the 2026-07-26 Hugo booking; `SWMS-261081` holds the
  canonical `confirmed_live_job` intake case bearing
  `wo:MLB-27100/po:PO-56960`, and the `roof_report` family that matches the PDF.
- The two 2026-07-28 triage notes each name the OTHER card as the merge target.

Both cards are live, so archiving the wrong one strands either a booked
attendance or the case-bound identity. Per the task's own fallback clause this
is held for a captain ruling rather than guessed. **The certificate is green
because the group is ACCOUNTED, not because it is settled.**

### How a hold can be accounted without going quiet

`captain_hold_live_pair` is a new disposition, deliberately distinct from the
existing `open_hold` rather than a widening of it. The existing rule — that an
`open_hold` may not have more than one live card on one work order — is a real
guard protecting the other six holds and is left strictly intact; this group
would have violated it.

The new disposition must name a decision key (the fixture parser refuses it
otherwise), and the checker pins the exact shape it was recorded in: if a member
goes terminal, or a duplicate pointer appears on either card, the hold no longer
describes production and `d3` fails. A stale hold cannot silently absorb a real
change — it forces re-adjudication.

### The census checks now assert invariants, not counts

`a3` and `a4` no longer pin the observed census. The recorded numbers are a
certified identity manifests diffed by membership, and the checks assert what those numbers
were protecting:

- every identity key lands in exactly one of live-job / exception-only /
  synthetic (`unaccounted: 0`, and the buckets must sum to the total);
- no identity key or live case is destroyed (`keys_lost: 0`, no negative growth
  from the floor) — keys are append-only, so a total BELOW the floor is a real
  defect;
- promotion runs exception -> live only (`live_job_regression: 0`);
- the synthetic live-fire set stays closed;
- a `confirmed_live_job` case always has its job (unchanged, still `0`).

Growth above the floor is reported in the run note instead of failing the run,
so healthy intake can never fail the certificate again. `evaluateCensusInvariants`
is a pure function with unit tests that prove each invariant still catches the
defect it protects. **Do not respond to a future `a3`/`a4` failure by re-pinning
the numbers** — a count that moves DOWN is exactly what these checks exist to
catch.

### Superseded counts

| | Original | This addendum |
|---|---|---|
| merge groups | 19 (16 historical / 3 drain-minted) | 21 (17 / 4) |
| `adjudicated_not_duplicate` | 8 | 9 |
| `captain_hold_live_pair` | — | 1 |
| drain-minted duplicate jobs | 3 | 4 (adds `SWMS-261081`) |
| unruled groups | 6 | 7 |

`archived_duplicate_pointer` (4), `captain_excluded` (1) and `open_hold` (6) are
unchanged. **No board write, status application or duplicate archive was applied
by this work** — it is fixture, checker and documentation only.

### Re-proved run — 22/22, CERTIFIABLE

```text
PASS phase_a  a1_sources_equal_case_rows         every physical SES source has exactly one canonical case-source row
       expected {"emails":1499,"case_source_rows":1499,"distinct_source_post_ids":1499}
       observed {"emails":1499,"case_source_rows":1499,"distinct_source_post_ids":1499}
       note     emails == case_source_rows == distinct post ids
PASS phase_a  a2_emails_without_case             no persisted SES email lacks a case-source row
       expected 0
       observed 0
PASS phase_a  a3_identity_key_census             identity keys are fully accounted as live-job / exception-only / synthetic
       expected {"unaccounted":0,"partition_complete":true,"keys_lost":0,"live_job_regression":0,"synthetic":4,"missing_certified_keys":[],"synthetic_identity_drift":[],"live_job_regression_keys":[]}
       observed {"unaccounted":0,"partition_complete":true,"keys_lost":0,"live_job_regression":0,"synthetic":4,"missing_certified_keys":[],"synthetic_identity_drift":[],"live_job_regression_keys":[]}
       note     census invariant, not a pinned count: certified floor 534 total / 160 live-job / 370 exception-only / 4 synthetic; live now 534 total (+0) / 160 live-job (+0) / 370 exception-only / 4 synthetic. Re-certification snapshot, 2026-08-01: certified identity manifests are diffed by membership. Every certified key and live case must remain present, live-job keys may not regress, exception-only keys may promote to live, the synthetic identity set is closed, and growth above the snapshot is reported rather than failed. Never trim or re-snapshot the manifest to make a failure green. The brief's pre-recovery census was 533 total / 156 live-job; the certified manifest is the current re-certification snapshot.
PASS phase_a  a6_keys_with_two_live_jobs         no identity key carries two live case-bound jobs
       expected 0
       observed 0
PASS phase_a  a4_live_case_without_job           no confirmed_live_job case is missing its job
       expected {"live_case_without_job":0,"missing_certified_live_cases":[],"certified_live_cases_without_job":[]}
       observed {"live_case_without_job":0,"missing_certified_live_cases":[],"certified_live_cases_without_job":[]}
       note     certified identity set 161 live cases; live now 161 (+0 post-baseline intake growth).
PASS phase_a  a5_dangling_job_ids                no case, correction target or source link points at a missing job
       expected {"case_job":0,"target_job":0,"link_job":0}
       observed {"case_job":0,"target_job":0,"link_job":0}
PASS phase_a  a7_captain_creation_roof_report    SWMS-261123 exists as a roof_report card with lineage to MLB-27309
       expected {"family":"roof_report","external_ref":"MLB-27309","requesting_company_slug":"mlb","case_state":"confirmed_live_job","identity_key":"wo:MLB-27309/po:PO-57445","case_sources_at_least":true,"work_orders_at_least":true}
       observed {"family":"roof_report","external_ref":"MLB-27309","requesting_company_slug":"mlb","case_state":"confirmed_live_job","identity_key":"wo:MLB-27309/po:PO-57445","case_sources_at_least":true,"work_orders_at_least":true}
PASS phase_a  a8_captain_creation_historical_backfill SWMS-261124 exists, displays archive and carries INV-0754
       expected {"family":"general_makesafe","external_ref":"BWCWA-6648","requesting_company_slug":"bw","display_after_status":"archive","invoice_rows":1,"corrections_at_least":true}
       observed {"family":"general_makesafe","external_ref":"BWCWA-6648","requesting_company_slug":"bw","display_after_status":"archive","invoice_rows":1,"corrections_at_least":true}
PASS phase_b  b1_round1_fixture_integrity        the committed round-1 fixture still hashes to the value its apply ledger recorded
       expected {"fixture_sha256":"8c2d5e02c2d19de7d2c71014766a5e3a2a37afc36aca3f54f1b4adb4203970df","applied":194,"skipped":0}
       observed {"fixture_sha256":"8c2d5e02c2d19de7d2c71014766a5e3a2a37afc36aca3f54f1b4adb4203970df","applied":194,"skipped":0}
PASS phase_b  b2_round2_fixture_integrity        the committed round-2 fixture set still hashes to the value its apply ledger recorded
       expected {"matched":true,"field_applied":4,"field_skipped":7,"temp_fence_applied":56,"temp_fence_skipped":1,"link_applied":260,"link_skipped":29}
       observed {"matched":true,"field_applied":4,"field_skipped":7,"temp_fence_applied":56,"temp_fence_skipped":1,"link_applied":260,"link_skipped":29}
       note     hash variant matched: migration_trailing_newline
PASS phase_b  b3_family_supersession             round 2's production decider superseded the round-1 family axis on exactly the recorded cards
       expected 40
       observed 40
       note     FAMILY TRUTH RULE: the production decider on full post-drain inputs is authoritative; the superseded round-1 family values are recorded, not counted as mismatches.
PASS phase_b  b4_board_field_diff                the live board matches the adjudicated verdict table advanced by the applied ledgers
       expected {"assertions":216,"mismatches":0}
       observed {"assertions":216,"mismatches":0}
PASS phase_b  b5_documented_holds_untouched      every documented captain hold still carries its held value
       expected [{"card":"SWMS-26894","family":"general_makesafe"}]
       observed [{"card":"SWMS-26894","family":"general_makesafe"}]
PASS phase_b  b6_source_job_links                every applied source-to-job link is live and no link exists beyond the ledger
       expected {"ledger_writes":260,"present":260,"table_rows":260}
       observed {"ledger_writes":260,"present":260,"table_rows":260}
       note     documented skips: {"scope_excluded_remint_supersession_captain_pile":17,"duplicate_fixture_same_binding":6,"job_external_ref_mismatch":5,"target_detail_not_found":1}
PASS phase_b  b7_board_population                every adjudicated stray carries the make-safe detail row that puts it on the board
       expected [{"job_number":"SWMS-26931","external_ref":"MLB-24664","has_detail":true},{"job_number":"SWMS-26932","external_ref":"MLB-24465","has_detail":true},{"job_number":"SWMS-26936","external_ref":"MLB-MW-26873","has_detail":true},{"job_number":"SWMS-26978","external_ref":"MLB-24659PO-56155","has_detail":true}]
       observed [{"job_number":"SWMS-26931","external_ref":"MLB-24664","has_detail":true},{"job_number":"SWMS-26932","external_ref":"MLB-24465","has_detail":true},{"job_number":"SWMS-26936","external_ref":"MLB-MW-26873","has_detail":true},{"job_number":"SWMS-26978","external_ref":"MLB-24659PO-56155","has_detail":true}]
PASS phase_b  b8_duplicate_survivor_pointers     the applied duplicate-survivor archives are exactly the adjudicated set
       expected [{"loser":"SWMS-261118","survivor":"SWMS-261065","run_key":"makesafe-duplicate-survivors-20260801-t1"},{"loser":"SWMS-26791","survivor":"SWMS-26787","run_key":"makesafe-duplicate-survivors-20260801-t2"},{"loser":"SWMS-26998","survivor":"SWMS-26736","run_key":"makesafe-duplicate-survivors-20260801-t1"}]
       observed [{"loser":"SWMS-261118","survivor":"SWMS-261065","run_key":"makesafe-duplicate-survivors-20260801-t1"},{"loser":"SWMS-26791","survivor":"SWMS-26787","run_key":"makesafe-duplicate-survivors-20260801-t2"},{"loser":"SWMS-26998","survivor":"SWMS-26736","run_key":"makesafe-duplicate-survivors-20260801-t1"}]
PASS phase_b  b10_card_work_order_identity       no card carries a blank or absent work-order identity, outside named legacy exceptions
       expected {"board_population":437,"unexcepted_offenders":0,"named_exceptions":1,"stale_exceptions":0}
       observed {"board_population":437,"unexcepted_offenders":0,"named_exceptions":1,"stale_exceptions":0}
       note     named legacy exceptions: SWMS-26001 (swms-26001-work-order-identity)
PASS phase_b  b9_survivors_not_stranded          no survivor is itself terminal or itself an archived duplicate
       expected [{"job_number":"SWMS-261065","terminal":false,"pointers":0},{"job_number":"SWMS-26736","terminal":false,"pointers":0},{"job_number":"SWMS-26787","terminal":false,"pointers":0}]
       observed [{"job_number":"SWMS-261065","terminal":false,"pointers":0},{"job_number":"SWMS-26736","terminal":false,"pointers":0},{"job_number":"SWMS-26787","terminal":false,"pointers":0}]
PASS droid    d1_merge_list_accounted            every work order production resolves to more than one card is adjudicated
       expected {"groups":21,"historical":17,"drain_minted":4,"unaccounted":0,"stale_fixture_rows":0}
       observed {"groups":21,"historical":17,"drain_minted":4,"unaccounted":0,"stale_fixture_rows":0}
PASS droid    d2_merge_group_membership          each adjudicated group still has exactly the cards it was adjudicated with
       expected 0
       observed 0
PASS droid    d3_dispositions_hold               production still matches every adjudicated disposition
       expected {"failures":0,"counts":{"archived_duplicate_pointer":4,"adjudicated_not_duplicate":9,"captain_excluded":1,"open_hold":6,"captain_hold_live_pair":1}}
       observed {"failures":0,"counts":{"archived_duplicate_pointer":4,"adjudicated_not_duplicate":9,"captain_excluded":1,"open_hold":6,"captain_hold_live_pair":1}}
PASS droid    d4_drain_minted_duplicates         the drain-minted duplicate jobs are exactly the adjudicated set
       expected ["SWMS-261059","SWMS-261078","SWMS-261081","SWMS-261118"]
       observed ["SWMS-261059","SWMS-261078","SWMS-261081","SWMS-261118"]

SES A/B certificate checker: 22/22 PASS (phase A 8/8, phase B 10/10, droid 4/4) — CERTIFIABLE
```
