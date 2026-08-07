# The item-14 portal-truth guard reads the capture ledger (2026-08-07)

## The defect

The item-14 portal-truth guard answered "is this card portal-verified?" from two
columns on `makesafe_job_details`:

- `portal_verified_at`
- `portal_verified_cycle`

Those columns have exactly **one** writer: `mark_makesafe_portal_report_done`.

But that marker is not the only **producer** of a portal capture. The portal
observer (`capture_portal_evidence.py/v1`) and the trade attestation
(`trade_portal_confirmation/v1`) record their captures in the append-only
`makesafe_portal_capture_revisions` ledger, and stamp **no column**. The guard
never read that table.

So a card could hold a verified, current-cycle, compliant capture and still be
refused for having "no portal-locked verification recorded". Three live roof
cards were in exactly that state on 2026-08-07:

| Card | Ref | Cycle | `portal_verified_at` | Ledger capture |
|---|---|---|---|---|
| SWMS-261116 | MLB-27387 | 1 | NULL | `roof_report` / done / verified |
| SWMS-261079 | MLB-27148 | 1 | NULL | `roof_report` / done / verified |
| SWMS-261019 | MLB-27037 | 1 | NULL | `roof_report` / done / verified |

This is the sixth instance in this campaign of two places disagreeing about one
fact.

## The fix

`loadMakesafePortalVerification` (ops-api `index.ts`) now also reads the ledger
and publishes a third input, `ledgerCaptureSatisfied`, which
`portalVerificationSatisfied` accepts as satisfying portal truth.

**It writes no new rule.** The two questions were already answered elsewhere and
are consumed, not restated:

- **Which ledger rows count** is `portalCapturesFromLedger`
  (`makesafe_board_read_model.ts`) — the board's existing validator: trusted
  producer through the sealed `isTrustedSesPortalCaptureProducer` seam,
  status/result agreement, builder-reference match, `sha256:` source hash, a real
  PNG screenshot in the capture bucket for the observer producer, and the capture
  URL having to be one of the card's own genuine portal links
  (`urlIsBuilderPortalLink`).
- **What is enough** is `ledgerPortalCapturesSatisfy`, over
  `requiredPortalCaptureRoles` — the same required-role set the card-column path
  enforces. `validatePortalEvidenceForReportType` was refactored to call that one
  definition too, so the two paths cannot drift into requiring different things.

The composition lives at the one caller in `index.ts` because
`makesafe_portal_guard.ts` cannot import the board read model — that module
imports *this* one. The pure predicate therefore takes already-projected captures
as an argument.

### Both entry points, one predicate

`assertMakesafePortalVerifiedForDraftInvoice` and
`assertMakesafePortalVerifiedForAdvance` are both the item-14 guard over one
predicate. Both change. Teaching one about the ledger and not the other would be
the same disease one seam further along.

## Current cycle is enforced twice, independently

The invariant that has broken three separate times in this campaign:

1. The runtime read is narrowed to the card's own `attendance_cycle_id`
   (`.eq('attendance_cycle_id', …)`).
2. `portalCapturesFromLedger` independently drops any row whose
   `attendance_cycle_id` differs from the card's — an **id** comparison, which is
   stronger than a cycle-number compare because an id cannot be reused across a
   re-attend.

A card with no current attendance cycle reads no rows at all. Both are asserted
in `makesafe_portal_ledger_capture_guard_test.ts`, including the case where the
query filter is deliberately defeated so only the projection can refuse.

`ledgerPortalCapturesSatisfy` deliberately does **not** re-check the cycle:
`portalCapturesFromLedger` stamps the *card's* `cycle_number` onto every capture
it returns, so a cycle field re-read there would compare a value to itself and
read as a check while proving nothing.

## Fails closed

No report type, no attendance cycle, an unreadable ledger, or a PostgREST error
all yield `false` — exactly the pre-change behaviour. A read fault must never be
the reason a card becomes invoiceable.

## Blast radius (production, read-only, 2026-08-07)

Re-provable: `scripts/ses-portal-truth-ledger-blast-radius.ts` (Management API,
`read_only: true`; refuses non-SELECT statements and client-identifying columns
before the request is sent). It imports the shipped predicates rather than
restating them in SQL, and exits non-zero if any card becomes eligible without a
compliant current-cycle capture, or if any card loses eligibility.

```
report cards examined            118
satisfied BEFORE                  16
satisfied AFTER                   19
newly eligible                     3
newly refused                      0
still refused                     99
prior-cycle ledger rows ignored    0
```

The three newly-eligible cards are **exactly** the three named cards, each with
its capture evidence:

| Card | Revision | Role | Result | Producer | Captured by | Screenshot |
|---|---|---|---|---|---|---|
| SWMS-261019 | `c4595559…` | roof_report | done | `capture_portal_evidence.py/v1` | ses-run-skill-batch1-v1 | yes |
| SWMS-261079 | `756917bf…` | roof_report | done | `capture_portal_evidence.py/v1` | maverick | yes |
| SWMS-261116 | `be4d6912…` | roof_report | done | `capture_portal_evidence.py/v1` | maverick | yes |

### The guard is not a rubber stamp

The ledger holds 28 rows across 15 cards; 7 are `capture_result = done`. All
seven are accounted for:

- 3 → the newly-eligible cards above.
- 2 (SWMS-261081, SWMS-261114) → already satisfied by a column stamp; no change.
- 2 (SWMS-26853, SWMS-26934) → **still refused**, correctly. Both carry an empty
  `builder_reference`, which `portalCapturesFromLedger` refuses. SWMS-26853 is
  additionally an assessment card holding only a `photos` capture, so it fails
  the triad as well.

Twelve of the fifteen cards with ledger rows remain refused.

## Known carry-forwards

- **SWMS-261079 carries a superseded price.** Its current `pre_xero` proposal is
  `total_inc_gst = 385`, against the ruled double-storey `$330` (Captain
  2026-08-06). It needs a fresh prepare before any mint. Nothing was minted,
  approved, authorised, sent, voided or re-priced by this work. For contrast the
  other two cards' proposals are `275` (the current locked single-storey price).
- **The three cards' portal links are tagged `builder_portal`, not
  `roof_report`.** That is why an earlier sweep did not see their captures.
  `portalCapturesFromLedger` already resolves a `builder_portal` link to
  `roof_report` on a roof card, so the guard is unaffected — but the mis-tagging
  is real and a separate ticket owns link detection. The same `external_links`
  arrays also carry `documents.primeeco.tech` and S3 CDN URLs tagged
  `builder_portal`; `urlIsBuilderPortalLink` rejects those structurally.

## Not proved live

`prior_cycle_ledger_rows_ignored` is **0**: production currently holds no
prior-cycle capture rows at all. The prior-cycle refusal is therefore proved by
test only, not by live data. **First live proof trigger:** the first re-attend
that bumps a report card's `attendance_cycle_id` while a previous cycle's capture
row survives — at that point re-run the blast-radius script and confirm the card
appears in neither `newly_eligible` nor `satisfied_after`.

## Tests

`supabase/functions/ops-api/makesafe_portal_ledger_capture_guard_test.ts` — 18
tests. The PASS case is the control; every negative flips exactly one coordinate
off it:

- no capture at all
- prior-cycle capture only (both enforcement layers)
- a re-attend re-refusing a card that passed on the old cycle
- untrusted producer; `not_done`; `unreachable`; status/result disagreement
- builder-reference mismatch and empty builder reference
- `source_url` not on the card; `source_url` is CDN pollution
- malformed `source_content_hash`
- observer capture with no / non-PNG / zero-byte / wrong-path screenshot
- wrong role for a roof card; `job_id` mismatch
- unreadable ledger (fails closed)
- no current attendance cycle
- an assessment card is not satisfied by a roof-only ledger capture
- a non-report make-safe never reads the ledger at all
