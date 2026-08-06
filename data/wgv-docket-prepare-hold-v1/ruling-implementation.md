# Captain ruling implemented: a roof-report card sends ONE email

Date: 2026-08-06. Implements
`data/decisions/2026-08-06-roof-report-email-shape.md` (firstmate home), closing
the parked decision `report-only-email-applicability`.

**The ruling.** A roof-report card sends ONE email, to the group inbox, carrying
the invoice. The portal holds the report; no empty report email is fabricated.

## What changed

The exemption path identified on PR 614, mirroring the photo precedent rather
than inventing a second mechanism.

| file | change |
|---|---|
| `ses_review_cockpit.ts` | `requiredSesRouteKinds` gains `reportRouteApplicable` (default `true` = strict), filtering `report` exactly as `photoRouteApplicable` already filters `photo`. `missingRouteRefusals` threads it. New optional input `report_route_applicable` (absent = required). |
| `ses_review_cockpit.ts` | The `report_only_email_applicability_parked` blocker is retired, with a comment recording the ruling and forbidding its revival to re-park the question. |
| `ses_reporting_actions.ts` | Producer derives `report_route_applicable` from the manifest's own `draft_builder_report_email` state. |
| `ses_reporting_refusals.ts` | The retired code's FACT is removed — it asserted the decision was "still awaiting the Captain", which is now false text. |
| `ses_review_cockpit.ts` | `buildSesReleaseRevision` consumes `requiredSesRouteKinds` instead of calling `sesReleaseRouteOrder` raw, so the send path requires exactly what the approve path required. |
| `ses_reporting_actions.ts` | `prepareSesReleaseRevisionAction` threads family + both applicability flags, conservatively across composite members. |
| `ses_reporting_actions.ts` | `executeSesReleaseRevisionAction` accepts the ruled invoice-only route set (one route, kind `invoice`) alongside AJS and universal shapes — the stored set is pinned by the release content hash the approval signed, so refusing it at SEND IT would reject a release the Captain already approved, after money is AUTHORISED. A one-route release whose single route is anything other than `invoice` still refuses. |
| `ses_reporting_actions.ts` | `querySesReviewCockpitAction` accepts a one-route release read (previously only 2 or 3 routes), so the cockpit can read back a ruled invoice-only release. |

## Approve and send obey ONE ruling

The first cut of this change touched the cockpit only, and the review gate caught
what that left behind: `buildSesReleaseRevision` called `sesReleaseRouteOrder`
directly, bypassing every applicability rule, so it demanded report + photo +
invoice from every non-AJS card regardless of family.

The consequence was worse than the hold it replaced. The card would clear the
cockpit, **APPROVE INVOICE would light, the Captain would authorise real money**,
and only then would `prepare_ses_release_revision` throw. Committed money with no
send path. A written warning is not a gate, so the fix ships with the cockpit
slice rather than after it.

`requiredSesRouteKinds` is now the single producer of "what does this card owe",
consumed by both the C11 refusal path and the release builder. All three new
arguments default to the strict universal shape, so a caller that has not been
taught them gets exactly the old behaviour.

Composite releases are conservative by the same rule the builder key already
uses: a route is exempt only when **every** member exempts it, and a mixed family
falls back to strict. One dissenting member can only make a release stricter.

The throw also stopped lying. It used to recite a fixed three-route list, which
on an exempt family named routes that family never owed; it now names the missing
route and the family's real requirement.

## The photo gap: FIXED, not left silent

The same bypass meant the **existing** `photo` exemption never reached the send
path either — a report-only card failed that check on `photo` as well as on
`report`. This is visible in the live control run below, which refuses naming
both.

It is fixed, because `requiredSesRouteKinds` filters both routes and fixing one
without the other would be arbitrary. **The blast radius is nil outside the
ruling**: `photo_route: "not_applicable"` appears in exactly two places in
`ses_family_matrix.ts` — `mlbReportRow` (report-only) and the `reportOnly` branch
of `syntheticRow` (permanently release-blocked). `physicalRow` is always
`work_order_sender`. So no physical make-safe card's send requirement moves.

## The one judgement call: not keyed on `report_only`

The obvious key is `report_only`, and it is **wrong**. `own_template_roof` is
`report_only: true` and still sends a real report email — the SecureWorks
own-letterhead roof report, rendered by `renderOwnRoofReport`, drafted as a real
`REPORT_EMAIL_DRAFT`. Exempting it would have dropped a route that family
genuinely owes, which the ruling does not authorise.

The correct key is the manifest declaration the assembler already makes:

```ts
report_route_applicable:
  object(items.draft_builder_report_email).state !== "not_applicable",
```

`not_applicable` is stamped only where the matrix says the portal is the report
(`ordinary_roof_portal` → `"portal-is-the-report"`; `assessment_quote`, which is
invoice-only by an earlier return anyway). `initialManifestItems()` seeds every
item `blocked`, never `not_applicable`, so a family that owes a report email and
failed to build one keeps the route required and is still held. Fail-strict by
construction, in both the producer and the consumer.

## Scope held: physical make-safe is untouched

`physical_makesafe` (and `temporary_fencing`, `repair`, `restoration`) stamp
`draft_builder_report_email` from a real draft, never `not_applicable`, so the
report route stays required and MLB still owes its three destinations. Pinned by
`physical make-safe still owes its report email after the ruling`, which asserts
the hold both with the field absent and with it explicitly `true`, and pins
`requiredSesRouteKinds("physical_makesafe", …)` at `["report", "photo",
"invoice"]`.

## Honesty, not green

`a ruled roof-report card requires exactly the one invoice route` pins the
required set at `["invoice"]` and then makes that one route unready — the card is
still held, and the blocker still names the invoice email. Dropping a route from
the required set does not stop the remaining routes being checked, and no other
check was touched: C1–C10 and C12 evaluate exactly as before.

## Live verification

`data/wgv-docket-prepare-hold-v1/verify-live.ts` pulls each card's live cockpit
through ops-api and runs the **patched** evaluator over the facts it publishes.
Output: `live-verification.txt`.

| | SWMS-261114 White Gum Valley | SWMS-261081 Mindarie |
|---|---|---|
| live status / band | HOLD / decision_blocked | HOLD / decision_blocked |
| live blockers | `route_draft_missing`, `report_only_email_applicability_parked` | same |
| live routes on pack | `invoice` | `invoice` |
| bound Xero | INV-1149 DRAFT | INV-1150 DRAFT |
| required routes (patched) | `invoice` | `invoice` |
| blockers (patched) | **none** | **none** |
| verdict | **clean**, band `shaun_clean` | **clean**, band `shaun_clean` |
| failed checks | none | none |
| APPROVE INVOICE | **ENABLED** | **ENABLED** |
| SEND IT | disabled until AUTHORISED | disabled until AUTHORISED |
| **SENDABLE** (release builds) | **yes — 1 route: invoice** | **yes — 1 route: invoice** |
| control: same routes, strict shape | REFUSED, missing report **and photo** | REFUSED, missing report **and photo** |

**Read the last row correctly — it is the ladder working, not a residual hold.**
`sendIt` requires `xeroAuthorised || noAdditionalCharge`, and both invoices are
DRAFT. APPROVE INVOICE is what authorises them. So the Captain's path is
APPROVE INVOICE → invoice goes AUTHORISED → SEND IT lights. Both cards are
clickable for that sequence; neither is clickable straight to SEND while the
money is still a draft, and making it so would mean sending an unpayable
invoice.

The SENDABLE row is `buildSesReleaseRevision` run over each card's real live
routes — pure construction, no write, no send, no Graph call. The control row
runs the identical routes through the old strict shape and is what proves the
gap was real: it names **report and photo**, which is the photo half of the same
bypass.

## What this proof is not

It runs the patched evaluator over live card facts. It is **not** a readback from
a deployed ops-api, because the fix is not deployed — production is still v1058.
A deployed cockpit readback needs this merged and shipped from the release
worktree, and I neither merge nor deploy. See the escalation note in the PR.

## Test evidence

`ses_review_cockpit_test.ts`: 29 passed, including the four cockpit tests (the
ruled exemption, the retired decision key, the physical-make-safe control, and
the honesty control) plus three release-builder tests (a ruled card builds a
one-route release with a strict-default control; physical make-safe still owes
three routes at send and the throw names the missing route; an exempt card is
still refused when its invoice route is absent).
`ses_reporting_actions_regression_test.ts` adds the execute/read half — SEND IT
executes a sealed invoice-only release, still refuses a non-AJS release missing
routes it owes, still refuses a one-route release whose single route is not the
invoice, and the cockpit read accepts the one-route release while still
refusing a release that does not contain the job — 52 passed across the two
files. Full ops-api suite 3549 passed / 23 failed, against a pre-change
baseline of 3542 / 23 on the same tree: same 23 pre-existing failures, plus the
new tests. `deno check --config deno.jsonc
supabase/functions/ops-api/index.ts` is clean.

The 23 baseline failures and the two `cp1_drag_reschedule_test.ts` type errors
are pre-existing and unrelated; both reproduce on a stashed (clean) tree.
