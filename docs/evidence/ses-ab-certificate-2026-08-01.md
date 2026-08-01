# SES Phase A/B certificate — 2026-08-01

This is the rollback anchor at the Phase A/B boundary. It certifies a state of
production, not a state of this repository: every claim below was re-proved
read-only against the live database by
`scripts/ses-ab-certificate-checker.ts` immediately before this document was
committed, and can be re-proved at any time by running it again.

**Result: 21/21 PASS — CERTIFIABLE.**

- Checker: `scripts/ses-ab-certificate-checker.ts`
- Certified baseline: `scripts/ses-ab-certificate-v1.baseline.json`
- Work-order merge accounting: `scripts/ses-ab-certificate-v1.duplicate-accounting.txt`
- Machine-readable run: `docs/evidence/ses-ab-certificate-2026-08-01.run.json`
  (`started_at` 2026-08-01T07:03:32.879Z, `finished_at` 2026-08-01T07:03:51.455Z)

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

## What is proven

### Phase A — intake source and case accounting

| Check | Claim | Observed |
| --- | --- | --- |
| `a1` | every physical SES source has exactly one canonical case-source row | 1499 emails = 1499 case-source rows = 1499 distinct post ids |
| `a2` | no persisted SES email lacks a case-source row | 0 |
| `a3` | identity keys are fully accounted | 534 total = 157 live-job + 373 exception-only + 4 synthetic, 0 residue |
| `a4` | no `confirmed_live_job` case is missing its job | 0 of 158 live cases |
| `a5` | nothing points at a missing job | 0 dangling case, correction-target and source-link job ids |
| `a6` | no identity key carries two live case-bound jobs | 0 |
| `a7` | the first captain-ruled creation exists | `SWMS-261123`, family `roof_report`, `external_ref` MLB-27309, case `confirmed_live_job` on `wo:MLB-27309/po:PO-57445` |
| `a8` | the second captain-ruled creation exists | `SWMS-261124`, display stage `archive`, `INV-0754` AUTHORISED ACCREC linked |

#### The 533 → 534 reconciliation

The task brief specifies 533 identity keys (156 live-job / 373 exception-only /
4 synthetic). Production reads **534 (157 / 373 / 4)**, and the two figures
cannot both be true at once: the brief's census is the pre-recovery snapshot,
and the recovery is itself one of the brief's own Phase A requirements.

PR 460's captain-ruled exact rescan promoted one case that was parked as
`exception / adapter_parse_failure` — an unreadable PDF, therefore **no**
`wo_po_identity_key` — to `confirmed_live_job`, carrying the newly extracted key
`wo:MLB-27309/po:PO-57445`. That is `SWMS-261123`, which check `a7` requires to
exist.

The arithmetic corroborates it rather than merely allowing it: exception-only
stays at 373 and synthetic at 4. Had the promoted case already held a key, it
would have left the exception-only pool and that count would now read 372. It
did not, so the key is new and the total moved 533 → 534 while live-job moved
156 → 157. The certified census is therefore the post-recovery one, and
`scripts/ses-ab-certificate-v1.baseline.json` records both figures with this
reasoning so a future reader is never left guessing which snapshot they hold.

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
survivor is archived out from under its own duplicate, `b9` fails. The correct
response to any failure is to adjudicate it, not to widen the baseline.

## Run output

The run embedded below is the one this certificate rests on. It is reproduced
verbatim, and its machine-readable form is
`docs/evidence/ses-ab-certificate-2026-08-01.run.json`.

```text
PASS phase_a  a1_sources_equal_case_rows  every physical SES source has exactly one canonical case-source row
       expected {"emails":1499,"case_source_rows":1499,"distinct_source_post_ids":1499}
       observed {"emails":1499,"case_source_rows":1499,"distinct_source_post_ids":1499}
       note     emails == case_source_rows == distinct post ids
PASS phase_a  a2_emails_without_case  no persisted SES email lacks a case-source row
       expected 0
       observed 0
PASS phase_a  a3_identity_key_census  identity keys are fully accounted as live-job / exception-only / synthetic
       expected {"total":534,"live_job":157,"exception_only":373,"synthetic":4,"unaccounted":0}
       observed {"total":534,"live_job":157,"exception_only":373,"synthetic":4,"unaccounted":0}
       note     the brief's pre-recovery census was 533 total / 156 live-job; The task brief's 533/156 is the pre-recovery snapshot. PR 460's captain-ruled exact rescan promoted one previously key-less exception case (reason_code adapter_parse_failure, therefore no wo_po_identity_key) to confirmed_live_job with the newly extracted key wo:MLB-27309/po:PO-57445. Exception-only stays 373 and synthetic stays 4, which is only possible if the promoted case carried no key before: had it already held one, exception-only would now read 372.
PASS phase_a  a6_keys_with_two_live_jobs  no identity key carries two live case-bound jobs
       expected 0
       observed 0
PASS phase_a  a4_live_case_without_job  no confirmed_live_job case is missing its job
       expected {"live_case_without_job":0,"live_cases":158}
       observed {"live_case_without_job":0,"live_cases":158}
PASS phase_a  a5_dangling_job_ids  no case, correction target or source link points at a missing job
       expected {"case_job":0,"target_job":0,"link_job":0}
       observed {"case_job":0,"target_job":0,"link_job":0}
PASS phase_a  a7_captain_creation_roof_report  SWMS-261123 exists as a roof_report card with lineage to MLB-27309
       expected {"family":"roof_report","external_ref":"MLB-27309","requesting_company_slug":"mlb","case_state":"confirmed_live_job","identity_key":"wo:MLB-27309/po:PO-57445","case_sources_at_least":true,"work_orders_at_least":true}
       observed {"family":"roof_report","external_ref":"MLB-27309","requesting_company_slug":"mlb","case_state":"confirmed_live_job","identity_key":"wo:MLB-27309/po:PO-57445","case_sources_at_least":true,"work_orders_at_least":true}
PASS phase_a  a8_captain_creation_historical_backfill  SWMS-261124 exists, displays archive and carries INV-0754
       expected {"family":"general_makesafe","external_ref":"BWCWA-6648","requesting_company_slug":"bw","display_after_status":"archive","invoice_rows":1,"corrections_at_least":true}
       observed {"family":"general_makesafe","external_ref":"BWCWA-6648","requesting_company_slug":"bw","display_after_status":"archive","invoice_rows":1,"corrections_at_least":true}
PASS phase_b  b1_round1_fixture_integrity  the committed round-1 fixture still hashes to the value its apply ledger recorded
       expected {"fixture_sha256":"8c2d5e02c2d19de7d2c71014766a5e3a2a37afc36aca3f54f1b4adb4203970df","applied":194,"skipped":0}
       observed {"fixture_sha256":"8c2d5e02c2d19de7d2c71014766a5e3a2a37afc36aca3f54f1b4adb4203970df","applied":194,"skipped":0}
PASS phase_b  b2_round2_fixture_integrity  the committed round-2 fixture set still hashes to the value its apply ledger recorded
       expected {"matched":true,"field_applied":4,"field_skipped":7,"temp_fence_applied":56,"temp_fence_skipped":1,"link_applied":260,"link_skipped":29}
       observed {"matched":true,"field_applied":4,"field_skipped":7,"temp_fence_applied":56,"temp_fence_skipped":1,"link_applied":260,"link_skipped":29}
       note     hash variant matched: migration_trailing_newline
PASS phase_b  b3_family_supersession  round 2's production decider superseded the round-1 family axis on exactly the recorded cards
       expected 40
       observed 40
       note     FAMILY TRUTH RULE: the production decider on full post-drain inputs is authoritative; the superseded round-1 family values are recorded, not counted as mismatches.
PASS phase_b  b4_board_field_diff  the live board matches the adjudicated verdict table advanced by the applied ledgers
       expected {"assertions":216,"mismatches":0}
       observed {"assertions":216,"mismatches":0}
PASS phase_b  b5_documented_holds_untouched  every documented captain hold still carries its held value
       expected [{"card":"SWMS-26894","family":"general_makesafe"}]
       observed [{"card":"SWMS-26894","family":"general_makesafe"}]
PASS phase_b  b6_source_job_links  every applied source-to-job link is live and no link exists beyond the ledger
       expected {"ledger_writes":260,"present":260,"table_rows":260}
       observed {"ledger_writes":260,"present":260,"table_rows":260}
       note     documented skips: {"scope_excluded_remint_supersession_captain_pile":17,"duplicate_fixture_same_binding":6,"job_external_ref_mismatch":5,"target_detail_not_found":1}
PASS phase_b  b7_board_population  every adjudicated stray carries the make-safe detail row that puts it on the board
       expected [{"job_number":"SWMS-26931","external_ref":"MLB-24664","has_detail":true},{"job_number":"SWMS-26932","external_ref":"MLB-24465","has_detail":true},{"job_number":"SWMS-26936","external_ref":"MLB-MW-26873","has_detail":true},{"job_number":"SWMS-26978","external_ref":"MLB-24659PO-56155","has_detail":true}]
       observed [{"job_number":"SWMS-26931","external_ref":"MLB-24664","has_detail":true},{"job_number":"SWMS-26932","external_ref":"MLB-24465","has_detail":true},{"job_number":"SWMS-26936","external_ref":"MLB-MW-26873","has_detail":true},{"job_number":"SWMS-26978","external_ref":"MLB-24659PO-56155","has_detail":true}]
PASS phase_b  b8_duplicate_survivor_pointers  the applied duplicate-survivor archives are exactly the adjudicated set
       expected [{"loser":"SWMS-261118","survivor":"SWMS-261065","run_key":"makesafe-duplicate-survivors-20260801-t1"},{"loser":"SWMS-26791","survivor":"SWMS-26787","run_key":"makesafe-duplicate-survivors-20260801-t2"},{"loser":"SWMS-26998","survivor":"SWMS-26736","run_key":"makesafe-duplicate-survivors-20260801-t1"}]
       observed [{"loser":"SWMS-261118","survivor":"SWMS-261065","run_key":"makesafe-duplicate-survivors-20260801-t1"},{"loser":"SWMS-26791","survivor":"SWMS-26787","run_key":"makesafe-duplicate-survivors-20260801-t2"},{"loser":"SWMS-26998","survivor":"SWMS-26736","run_key":"makesafe-duplicate-survivors-20260801-t1"}]
PASS phase_b  b9_survivors_not_stranded  no survivor is itself terminal or itself an archived duplicate
       expected [{"job_number":"SWMS-261065","terminal":false,"pointers":0},{"job_number":"SWMS-26736","terminal":false,"pointers":0},{"job_number":"SWMS-26787","terminal":false,"pointers":0}]
       observed [{"job_number":"SWMS-261065","terminal":false,"pointers":0},{"job_number":"SWMS-26736","terminal":false,"pointers":0},{"job_number":"SWMS-26787","terminal":false,"pointers":0}]
PASS droid    d1_merge_list_accounted  every work order production resolves to more than one card is adjudicated
       expected {"groups":19,"historical":16,"drain_minted":3,"unaccounted":0,"stale_fixture_rows":0}
       observed {"groups":19,"historical":16,"drain_minted":3,"unaccounted":0,"stale_fixture_rows":0}
PASS droid    d2_merge_group_membership  each adjudicated group still has exactly the cards it was adjudicated with
       expected 0
       observed 0
PASS droid    d3_dispositions_hold  production still matches every adjudicated disposition
       expected {"failures":0,"counts":{"archived_duplicate_pointer":4,"adjudicated_not_duplicate":8,"captain_excluded":1,"open_hold":6}}
       observed {"failures":0,"counts":{"archived_duplicate_pointer":4,"adjudicated_not_duplicate":8,"captain_excluded":1,"open_hold":6}}
PASS droid    d4_drain_minted_duplicates  the drain-minted duplicate jobs are exactly the adjudicated three
       expected ["SWMS-261059","SWMS-261078","SWMS-261118"]
       observed ["SWMS-261059","SWMS-261078","SWMS-261118"]

SES A/B certificate checker: 21/21 PASS (phase A 8/8, phase B 9/9, droid 4/4) — CERTIFIABLE
wrote docs/evidence/ses-ab-certificate-2026-08-01.run.json
```
