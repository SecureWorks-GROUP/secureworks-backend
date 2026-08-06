# White Gum Valley SWMS-261114 — docket prepare held, blocker 1 is blocker 2

Date: 2026-08-06. Read-only against production. ops-api v1058, commit `ebd97881`.
Card: job `088dee02-91d0-4539-8c9c-6014c9ebf06e`, SWMS-261114, White Gum Valley,
MLB, family `ordinary_roof_portal` (roof report), builder reference `RR-26836`.

## Outcome in one line

**Blocker 1 cannot be cleared by preparing a docket revision.** It is not a
stale-revision defect — it is the same parked product decision as blocker 2,
surfaced a second time as a mechanical route check. **No prepare was committed,
no release was run, and blocker 2 is untouched.**

## The two blockers as the cockpit serves them

`GET ops-api?action=query_ses_review_cockpit&job_id=…` — status `HOLD`,
approval band `decision_blocked`, checks C1–C10 and C12 all pass, C11 fails.

| # | code | fact |
|---|---|---|
| 1 | `route_draft_missing` | The report email has no draft on the current docket revision. |
| 2 | `report_only_email_applicability_parked` | Whether report-only work uses the universal three-email release is still awaiting the Captain's decision. (`decision_key: report-only-email-applicability`) |

## Why blocker 1 is blocker 2

The two blockers are two readings of one unresolved question. The cockpit
requires a report route this family's assembler is designed never to produce.

**The assembler declares the report email not applicable for this family.**
`ses_family_matrix.ts` `mlbReportRow` gives `ordinary_roof_portal`
`job_type: "roof_report"`, `report_only: true`. In `ses_prepare_docket_revision.ts`
the whole `reportFile`-producing block is gated on
`row.job_type === "physical_makesafe"`, with a single `else if` for
`own_template_roof`. Neither matches, so `reportFile` is structurally `null` for
this family; `buildEmailDrafts` gates `REPORT_EMAIL_DRAFT` on `if (reportFile)`,
and the manifest hard-codes
`items.draft_builder_report_email = notApplicable("portal-is-the-report")`.
The portal *is* the report — there is no report PDF to attach.

**The cockpit requires it anyway.** `requiredSesRouteKinds` returns the universal
route order for every non-assessment builder and filters out only `photo`:

```
kind !== "photo" || photoRouteApplicable
```

So required routes here are `report` + `invoice`. The photo half of exactly this
problem was already answered — the code comment on that filter says
`photo_route_applicable` exists "so the cockpit does not invent an unsatisfiable
HOLD (PR 563 honesty)". The report half was not. That asymmetry is the parked
decision.

Clearing blocker 1 therefore requires one of two things, and both are answers to
blocker 2:

- make the assembler emit a report email for a card with no report to attach, or
- drop `report` from the required route set for report-only families.

Either is a ruling on whether report-only work uses the universal three-email
release. **Neither was taken.**

## Live read-only proof that a prepare does not clear it

`POST ops-api?action=prepare_ses_docket_revision` with `dry_run: true`
(idempotency key `wgv-docket-prepare-hold-v1-dryrun-1`). `dry_run` skips
`deps.persist` entirely (`ses_prepare_docket_revision.ts`, `if (!request.dry_run)`),
so nothing was written — the response confirms `persisted: false`.

Result on current inputs and current code:

- `state: "ready"`, `blockers: []`
- `email_drafts` keys: **`["INVOICE_EMAIL_DRAFT"]`** — no `REPORT_EMAIL_DRAFT`
- manifest `draft_builder_report_email`: `{state: not_applicable, rule: portal-is-the-report}`
- manifest `supporting_report_pdf`: `{state: not_applicable, rule: report-only-portal-is-the-report}`
- manifest `draft_photo_evidence_email`: `{state: not_applicable, rule: report-only-has-no-photo-email}`
- manifest `draft_invoice_bundle_email`: `ready`

The assembler considers this card complete. The report route is not missing from
the pack; it is declared inapplicable to it.

**Persisted history says the same thing five times.** Every docket revision this
card has ever had carries exactly one email draft key, `INVOICE_EMAIL_DRAFT`:

| revision | committed | state | stage | email draft keys |
|---|---|---|---|---|
| `8fdacbd8` | 2026-08-03 17:04:25 | ready | pre_xero | INVOICE_EMAIL_DRAFT |
| `44c37a2e` | 2026-08-06 00:29:44 | ready | pre_xero | INVOICE_EMAIL_DRAFT |
| `51ec7c52` | 2026-08-06 01:36:34 | ready | pre_xero | INVOICE_EMAIL_DRAFT |
| `cce185ce` | 2026-08-06 01:37:34 | ready | pre_xero | INVOICE_EMAIL_DRAFT |
| `ab859c53` | 2026-08-06 04:16:11 | ready | pre_xero | INVOICE_EMAIL_DRAFT |

The last three share one `input_content_hash` (`sha256:d3042e59…`) — three
prepares over identical inputs, three times no report draft. A sixth would be the
same.

## Pack state before, and what a prepare would have cost

Current revision `ab859c53-9df7-5c81-82db-78a0310c0495`, stage `pre_xero`,
`pre_xero_docs_ready: true`, output hash `sha256:866a1c64…`, 13 artifacts
(including `invoice_email_draft`, no report email draft artifact).

**The Captain's Docs Ready signoff was never at risk, because this card has never
had one.** `ses_docket_review_events` for this job holds five rows, sequences 92 /
240 / 250 / 253 / 255, every one `event_kind: prepared`, `review_state:
needs_review`, `signed_off_at: null`, `invalidated_signoff_event_id: null`. There
are zero `signed_off` events in the card's whole history. It appears in
`list_ses_docs_ready_reviews` under state `needs_review`, not as an approved pack.

Other things a re-prepare could have disturbed, all checked and all absent:

- `makesafe_release_revisions` members for this job: **none**. Cockpit
  `release_send_progress: {kind: "none"}`.
- `makesafe_revision_approvals` rows for this job: **none** (the table holds 22
  invoice and 20 release approvals for other cards, so the read is sound). So
  there is no APPROVE INVOICE row a re-prepare could orphan.
- `makesafe_docket_revisions.xero_binding`: **null on all five revisions**;
  `invoice_obligation_revision_id` likewise null. The Xero PDF lives on its own
  storage prefix, not as a revision-scoped docket artifact.

So the cost was low — but the benefit was zero, and one documented hazard was
live: the card holds a **DRAFT** Xero invoice against a `pre_xero` pack, and the
recoverable-rebind path in CLAUDE.md covers **AUTHORISED** invoices only. Writing
a sixth identical revision that cannot clear the blocker, on the morning of a
batch sitting, is churn against that hazard for nothing. Held.

## Money — read, not touched

Recorded only to show nothing moved. No re-price, no re-derivation, no
verification by another route.

- Bound Xero invoice: **INV-1149, DRAFT, $330.00 inc** — matches the Captain's
  standing ruling ($300 ex / $330 inc).
- Obligation revision `6f47ad67-156d-578e-8e50-38deb4063675`, state
  `create_executed`, `pricing_disposition: priced_with_line_override`, created
  2026-08-06 04:16:23 (12s after the current docket revision).
- The prior obligation revision `ddcd08aa` (INV-1144, $385) is `void_linked`.
- The docket's `local_invoice_proposal` still reads canon roof-storey double
  ($350 ex / $385 inc). That disagreement with the bound $330 is **pre-existing**
  on the current revision and is the expected shape of a line override: the
  override lives on the obligation ledger, not on the docket proposal. A fresh
  docket would re-derive the same canon proposal. Not a finding to act on here.

## Board readback

`GET ops-api?action=makesafe_board`, card SWMS-261114: `canonical_stage:
report_ready`, `pack_status: drafted`, `has_wo: true`, `invoice_status: draft`,
`invoice_qualifies_as_current_draft: true`, reason `qualifying_draft`,
`site_suburb: White Gum Valley`.

`invoice_date` and `invoice_created_at` read **null**. That is the known reattend
presentation defect another worker owns. Not touched, not investigated, and not
caused by anything here — no write was made to this card at all.

## Boundaries honoured

- No release prepared, approved or executed. No send, no authorise, no mint, no
  void, no re-price.
- No docket revision committed. The only prepare call was `dry_run: true`,
  `persisted: false`.
- Blocker 2 untouched and still standing: `report_only_email_applicability_parked`,
  `decision_key: report-only-email-applicability`. No release shape was chosen,
  implicitly or otherwise.
- No gate, fence or evidence check weakened. No migration proposed.
- No production write of any kind; every query above was a GET, a `read_only:
  true` Management API select, or the dry-run prepare.

## What the Captain has to decide

Blocker 1 clears the moment blocker 2 is ruled, and not before:

- **If report-only work does NOT use the universal three-email release** —
  `requiredSesRouteKinds` should drop `report` for report-only families, the same
  way it already drops `photo`. C11 then passes on the existing docket revision
  with no prepare at all, and this card goes to two blockers → zero.
- **If it DOES** — the assembler needs a report email for a card whose report is
  the Prime portal link, which means deciding what that email carries when there
  is no report PDF. That is a new recipe, not a re-prepare.

Until then this card is honestly held at two blockers, and one prepare would not
have moved it.
