# White Gum Valley SWMS-261114 - the portal contradicts the work order, and the work order governs

Date: 2026-08-06
Branch: `fm/wgv-storey-single-reprice-v1`
Mode: **read-only investigation. Nothing was written to production.**
Actor: `fm/wgv-storey-single-reprice-v1`
Status: **SETTLED by Captain ruling 2026-08-06. Nothing pending.**

## The ruling this record exists under

> **ROOF REPORTS ARE PRICED OFF THE WORK ORDER ONLY.** The trade-observation override is
> a MAKE-SAFE rule and does not apply to roof reports.

`data/decisions/2026-08-06-roof-reports-priced-off-work-order-only.md`.

**`INV-1149` stays at $300.00 ex / $330.00 inc. No void, no reprice, no storey
correction, and the storey-correction mechanism is not to be built.**

## What this record is, and is not

It **is** the evidence record of a real contradiction on a live card: the builder's own
locked portal form says single storey, the builder's own work order says two, and under
the ruling above the work order governs the price regardless. Recording that is the
point - a future reader who finds this disagreement on this card, or the same shape on
another roof card, should land here and stop rather than re-derive a reprice from it.

It is **not** a pending reprice, an open question, or work for anyone to pick up. The
investigation below was carried out under a premise that the ruling has since reversed:
the trade-observation override was applied to a roof card in error. The Captain's words:
*"That was my error, not yours: I applied a make-safe rule to a roof card and had you
size an alarming number off it. Your evidence was correct throughout; the rule I applied
to it was wrong."*

So read sections 1, 4, 6 and 7 as findings that stand. Read sections 2, 3, 5 and 8 as
the working-out of a change that is **not happening** - kept because each documents a
real, still-true property of the system, not because anything is owed. Section 9's
census is **by design**, not a gap; it has been rewritten to say so.

Nothing was authorised, sent, approved, voided or minted. No builder was contacted.

## The card

| Field | Value |
| --- | --- |
| Job id | `088dee02-91d0-4539-8c9c-6014c9ebf06e` |
| Job number | **SWMS-261114** |
| Suburb | White Gum Valley |
| Builder ref | **RR-26836** (WO `MLB-RR-26836PO-57514`) |
| Company | `mlb` |
| Family | `roof_report` / `ordinary_roof_portal`, `invoice_basis: roof_storey_fixed` |
| Substatus | `admin_to_send_report` |
| Attendance cycle | `97fe83e0-1d73-4a2d-8ea7-9bc7f463fdcd` (1) |
| Money seal | `ses_money_sealed_at 2026-07-31T01:01:10Z`, source `job_spine` |
| `jobs.metadata.storeys` | **`double`** (unchanged by this task) |

## 1. The storey fact, established from production, not from the brief

Two independent production sources, both read today.

**a. The live portal form.** Opened
`https://primeeco.tech/share/bd8dff3e-a24d-4f33-8163-cf65505b3638` and read the page
directly (`data/wgv-storey-single-reprice-v1/portal-form-readback.txt`, redacted).

- Job Number: `MLB-RR-26836` - the card's own builder reference.
- "This form has been locked and is no longer available for editing or submission".
- `Roof Report  24 of 24`.
- `Date of Inspection  3rd Aug 2026`.
- **`Number of Storeys  Single Storey`**.

**b. The persisted capture at lock time.** `makesafe_portal_capture_revisions`
row `54a70c6f-f1fe-4d19-8399-a49d270ee1a7` (`portal-capture-row.json`):
`role roof_report`, `status verified`, `capture_result done`, `builder_reference
RR-26836`, `captured_at 2026-08-03T13:19:17Z` by `maverick` via
`capture_portal_evidence.py/v1`, signal **"form locked/submitted (form-locked
banner), 24 of 24 answered"**, source and screenshot content hash
`sha256:38957022c6e4e017bfff44a7d04d195c5a10338d338aa7b13a52d5d400c21d32`
(280,403 bytes).

**The contradicting work order.** `jobs.notes` reads *"Please attend site and conduct
a **two storey** roof report"* (`work-order-instruction.txt`). That phrase is exactly
what `roofStoreyOrderedProductFact` matches, which is why the card carries
`metadata.storeys = "double"` today.

**What resolves the two.** The Captain's standing rule: the work order's storey
statement is acceptable pricing authority **unless the trade observed otherwise on
site**. The trade did. The submitted form is locked, complete 24 of 24, filled from
the property on 3 August, and says single. Trade observation wins.

One trap worth naming: the same form says `Construction Type: Double Brick`, two rows
above the storey answer. That is a wall fact, not a storey count, and it is the most
plausible way to misread this form as agreeing with the work order. It does not agree.

I found nothing contradicting the single-storey reading.

## 2. Why the fact cannot be recorded through any production surface

`storeys` is resolved by U4 through `structuredSourceFact`
(`ses_assembler_input_adapter.ts`), which scans `jobs.scope_json`,
`makesafe_job_details.scope_json`, the intake case `raw_identity_json` and
`jobs.metadata`, and returns a value **only when exactly one distinct value is found
across all roots**. So the correction cannot be additive: adding "single" anywhere
while `jobs.metadata.storeys = "double"` stands makes the fact ambiguous and the card
falls to `pricing_evidence_missing`. The existing `double` must be *replaced*.

Every candidate surface was checked and none can do it:

| Surface | Why not |
| --- | --- |
| `update_job_field` | Allow-list is 8 top-level `jobs` columns (`index.ts:6032`). No metadata key, `storeys` included. |
| `preview_makesafe_roof_storey_backfill` | Derives the storey from the **work-order text only** - the source being overridden. It would read "two storey" here, and would then classify this card `hold_competing_storey_signal` (a value already exists) and write nothing at any `dry_run` setting. Correct behaviour; simply the wrong direction. |
| `update_makesafe_job_family` | The right *pattern* - privileged, expects-before guard, preserves other metadata, audits - but it only ever writes `makesafe_job_family`. There is no storey twin. |
| `update_makesafe_details` | Writes `makesafe_job_details` only; its allow-list has no storey field. |
| `save_roof_report` / `submit_roof_report` | Writes `makesafe_roof_report_drafts.storey`, which the adapter reads **only as a fallback after** `structuredSourceFact`. With `metadata.storeys` set it is never reached. It also means minting a SecureWorks roof report on a card whose report is the builder's Prime form. |
| `makesafe_gap_fill_apply` | Additive, and restricted to five client-contact fields. Never money-path identity. |

So recording this correctly needs a **new privileged ops-api action** - the
`update_makesafe_job_family` shape, applied to `storeys`: expects-before guard,
required evidence reference (the portal share URL plus the capture content hash),
required reason, audit event, privileged-only. That is product code plus an edge
deploy on the sole money-determining field of a sealed card, which is beyond a
docs-only PR and beyond a reprice.

I did **not** write `metadata.storeys` by raw SQL. Management API access here is
read-only by contract, and a hand-written money-path fact with no audit row, no
expects-before guard and no evidence binding is precisely the shortcut the storey
backfill's preview-by-default design exists to prevent.

## 3. The derivation of $250.00 ex - NOT APPLIED, kept for the arithmetic

Under the ruling this never happens: the work order says two storey and the work order
governs. What follows is the sum as it would have run, retained only so the figure
quoted during the investigation is checkable rather than floating.

`roof_storey_fixed` prices with no free parameters
(`ses_prepare_docket_revision.ts:725`):

```
storey  = facts.storeys                       -> "single"
price   = roofReportPrice("single")           -> roof_report_template.ts:70
                                                 { ex_gst: 250, inc_gst: 275 }
line    = "RR-26836 - Single Storey roof report", quantity 1 @ 250.00
```

| Term | Source | Amount |
| --- | --- | ---: |
| Line 1: `RR-26836 - Single Storey roof report`, qty 1 x $250.00 | `ROOF_REPORT_PRICES.single.ex_gst`, locked 2026-07-16 | **250.00** |
| Subtotal ex GST | `subtotal_ex_gst = price.ex_gst` | **250.00** |
| GST | `gst = price.inc_gst - price.ex_gst = 275 - 250` | **25.00** |
| Total inc GST | `total_inc_gst = price.inc_gst` | **275.00** |

Check: `250.00 + 25.00 = 275.00`. GST is exactly 1/11th of inc (`275 / 11 = 25.00`).

Movement from the live draft: **$330.00 inc -> $275.00 inc, a reduction of $55.00 inc
($300.00 ex -> $250.00 ex, $50.00 ex).**

**No hand-set figure is involved.** With `storeys = "single"` the sealed schedule would
produce $250.00 on its own. **This was not applied.** `INV-1149` stands at $300.00 ex /
$330.00 inc under the Captain's own rate authorisation.

## 4. A correction to the brief: the $300 is not a work-order price

The task states `INV-1149` "currently sits at $300 ex ($330 inc), priced from the work
order". Production says otherwise, and the difference changes what the Captain has to
decide (`obligation-history.json`):

| Obligation revision | Created | By | Disposition | Price | Bound invoice |
| --- | --- | --- | --- | ---: | --- |
| `4d2485e7-…` | 2026-08-03 17:04Z | maverick | `priced_from_canon` | $350 ex / $385 inc | - (superseded) |
| `ddcd08aa-…` | 2026-08-06 00:29Z | roof-report-portal-pairs-v1 | `priced_from_canon` | $350 ex / $385 inc | INV-1144 DRAFT, now `void_linked` |
| `6f47ad67-…` | 2026-08-06 04:16Z | **Captain Marnin Stobbe** | `priced_with_line_override` | **$300 ex / $330 inc** | **INV-1149 DRAFT** |

The work-order price for a double storey is the sealed **$350 ex / $385 inc**, and
that is what the first two revisions carried. The live $300 is a **Captain-authorised
card-scoped rate override** - `override_kind: commercial_rate_override`, decision key
`captain-preshutdown-send-batch-v1-wgv-roof300`, authorised 2026-08-06T01:00Z, reason
"double storey roof report reduced from the sealed $350 ex to $300 ex ($330 inc) for
this card only". The sealed matrix was not changed and trade evidence was not written.

This matters because the storey correction **structurally invalidates that
authorisation**. `buildCommercialQuantityOverrideLines` refuses with a 409 when
`labour_rate_override.sealed_unit_price_ex_gst` does not equal the U4 sealed rate
(`ses_commercial_quantity_override.ts:286`). The stored override declares sealed
`$350`; once `storeys = "single"` the sealed rate is `$250`, so the override cannot be
carried forward and must be dropped. Dropping it is what lets the price derive - but
the Captain authorised $300 knowingly, so **whether that authorisation is withdrawn or
re-expressed against the single-storey schedule is his call, not mine.**

The straight reading is that $300 was a discount off $350 for a job believed to be
double storey; on a single-storey job the sealed price is $250 and no override is
needed. I am not assuming that.

## 5. The invoice: any reprice would be void-and-remint - and no reprice is happening

`INV-1149` mirror readback (`invoice-mirror-readback.json`, live today):

| Field | Value |
| --- | --- |
| `invoice_number` | **INV-1149** |
| `status` | **DRAFT** |
| `invoice_type` | ACCREC |
| `reference` | RR-26836 |
| `sub_total` / `total_tax` / `total` | **300.00 / 30.00 / 330.00** |
| `amount_due` / `amount_paid` | 330.00 / 0.00 |
| `xero_invoice_id` | `5ebf0656-4440-4802-95bf-8d0324d8269e` |
| `invoice_obligation_revision_id` | `6f47ad67-156d-578e-8e50-38deb4063675` |
| `ses_external_token` | `SES-4c682816-6567-5fd5-8e76-07a4a7bea18c` |

**It is still $330.00 inc. It was not repriced.**

There is no in-place path. The SES Xero gateway (`makeSesXeroGateway`, `index.ts:1341`)
exposes exactly four verbs: `createDraft`, `authorise`, `fetchAuthorisedPdf` and (via
`makeSesInvoiceVoidGateway`) `voidInvoice`. **There is no update verb**, and "changed"
is one of the sealed money-fence verbs, so amending a bound draft's lines is not
reachable from any sanctioned path. The only route to $275.00 is:

```
prepare_ses_invoice_void_revision  (DRAFT -> DELETED)
approve_ses_invoice_void_revision  <- Captain
execute_ses_invoice_void_revision
then: prepare_ses_invoice_obligation (no override) -> create_ses_invoice_draft
```

This card has already been through that sequence once: `INV-1144` at $385 was
`DELETED` and reminted as `INV-1149` at $330 four hours ago. The precedent is the
system's own.

Per the task boundary - *"If a void-and-remint is required rather than an in-place
change, say so and stop"* - I stopped here and named it. **The Captain then ruled no
void.** The sequence above was never run and is recorded only as the general shape of a
reprice on this system, which remains true for any future repricing question.

## 6. Duplicate guard: clean, and it blocks a remint by design

Read-only probe run against production `ops-api?action=resolve_ses_invoice_duplicates`
(`duplicate-probe.json`):

```json
{ "match_tier": "job_id", "ambiguity": "none",
  "allows_create": false, "reason_codes": ["blocked_duplicate_live"] }
```

- **What it scanned:** `query_shape: "indexed_job_then_normalized_reference"`,
  `scanned_full_estate: false` - the indexed mirror probe, by `job_id` first and then
  by normalised reference `rr26836`. This is the cheap read-only probe, deliberately
  **not** the full live-ACCREC estate scan; that one
  (`fetchAllAccrecInvoices` + `resolveExistingInvoice`) runs inside
  `create_ses_invoice_draft`, and running it would mean minting, which I did not do.
- **What it found:** one live ACCREC row - `INV-1149`, DRAFT, reference `RR-26836`.
  Nothing ambiguous, nothing stray, no second live invoice. `ambiguity: "none"`.
- **Mirror cross-check** over every ACCREC row referencing `26836`: two rows, both on
  this card - `INV-1144` DELETED $385.00 and `INV-1149` DRAFT $330.00. Clean.
- **`allows_create: false` is the guard working**, not a fault. A $250 remint is
  refused while `INV-1149` is live. `prepareSesInvoiceObligationAction` enforces the
  same order at `ses_reporting_actions.ts:1436`: a commercial override cannot be
  applied while the disposition is `blocked_duplicate_live`. Void first, then mint.

## 7. What was and was not done

Not done, at any point:

- No authorise. No send. No approve. No void. No mint. No builder contact.
- `INV-1149` is untouched and remains DRAFT at $330.00 inc.
- `jobs.metadata.storeys` is untouched and still reads `double`.
- No docket prepared, no obligation revision written, no signoff moved.
- No migration. No edge deploy. No change to the sealed money fence, the rate guard,
  the duplicate guard or any send gate.
- Mindarie `SWMS-261081` / `INV-1150`, Koondoola `SWMS-261025`, Clarkson `SWMS-26931`,
  West Perth `SWMS-261018` and Queens Park `SWMS-26845` were not read or touched.

Done: production reads only (Management API `read_only: true`, the read-only ops-api
duplicate probe, and one browser read of the builder's own share link), plus this
ledger.

## 8. What the Captain was asked, and what he ruled

Two decisions were put up: build a storey-correction action, and void `INV-1149`. **Both
were declined**, on a ground that made the questions moot rather than answering them
individually - the trade-observation override does not reach roof reports at all.

| Asked | Ruled |
| --- | --- |
| Approve building a privileged storey-correction action | **No. Not to be built.** |
| Void `INV-1149` so a $250.00 / $275.00 draft can be minted | **No void.** Stays $300.00 ex / $330.00 inc. |
| Confirm whether the $300 authorisation is withdrawn | **Stands.** |

Nothing here is open.

## 9. The 40-of-63 census is BY DESIGN, not a gap

This section previously argued that 40 roof cards sat behind a hole worth closing. **That
reading was wrong**, and it was wrong because the premise it rested on was wrong, not
because the numbers were. The counts are accurate; what they mean has changed completely.

Read-only census of the roof-report family, 2026-08-06 (`gap-sizing-counts.json`,
`gap-sizing-exposed-cards.json`):

| Measure | Count |
| --- | ---: |
| Roof-report cards | 63 |
| Carrying a **work-order-derived** `storeys` fact | **40** (29 single, 11 double) |
| Of those, with a captured trade portal form on record | 6 |
| Carrying the fact and a portal share link but no capture pulled yet | 14 |

Those 40 cards are priced off the builder's instruction because **that is the rule for
roof reports**. The absence of any surface to overwrite a roof card's storey with a trade
observation is the design working, not an exposure. A trade contradiction on a roof card
is worth seeing and worth recording; it is not a pricing input.

**Nothing follows from this table.** It is retained so that the next person who counts
these cards finds the ruling attached to the number instead of re-raising the alarm.

The make-safe trade-observation override is untouched by any of this and continues to
apply on make-safe cards, where it belongs.

## 10. Post-ruling verification: is the card clickable and sendable?

Read-only, 2026-08-06, after the ruling. Everything below is **what the production
cockpit says**, not an inference (`cockpit-verdict-and-controls.json`,
`cockpit-money.json`, `docs-ready-queue-row.json`).

`ops-api?action=query_ses_review_cockpit` for `SWMS-261114`:

| Field | Value |
| --- | --- |
| `status` | **`INVOICE_CREATE_READY`** |
| `stale` | `false` |
| `verdict.clean` | **`true`** |
| `verdict.checks` | **12 of 12 passed** (C1-C12) |
| `verdict.blockers` | **`[]`** |
| `approval_band` | `shaun_clean` |
| `controls.captain_only` | `false` |

**APPROVE INVOICE is genuinely active, not merely unblocked:**

```
"approve_invoice": { "enabled": true, "disabled_reason": null,
  "plan": "Approve the existing Xero DRAFT for this exact obligation revision;
           authorise only if this approval explicitly includes authorise;
           then attach the real Xero PDF as a new docket revision." }
```

It targets **the existing draft** - it is not proposing a fresh mint.

**SEND IT is honestly disabled, and for the right reason:**

```
"send_it": { "enabled": false, "failed_checks": [],
  "route_kinds": ["invoice"], "route_count": 1,
  "disabled_reason": "The bound Xero invoice is DRAFT, not AUTHORISED.
                      The invoice email cannot go out against an unauthorised invoice." }
```

`failed_checks: []` - nothing is wrong with the card. SEND IT is sequenced behind
APPROVE INVOICE by design and lights up once the invoice is AUTHORISED.

**Bound money reads the ruled figure:** `INV-1149`, `DRAFT`, **total 330**,
`pdf_available: true`.

### Three things a reader should not misread

1. **The cockpit's `local_invoice_proposal` shows $350 ex / $385 inc, storeys
   `double`.** That is the *canon* derivation on the current docket. The **bound**
   invoice is $330 inc because the Captain's `commercial_rate_override` was applied at
   obligation-prepare. Both numbers are correct and they are different things. The
   invoice is the $330.
2. **`supporting_invoice_pdf` reads `blocked`** with `reason_code: recovery-not-run`
   ("Pre-Xero review carries a local proposal, never a Xero PDF"). That is the expected
   `pre_xero` docket state and it gates nothing - `verdict.blockers` is empty and C2
   passes. APPROVE INVOICE is what binds the real Xero PDF as a new docket revision.
3. **The live PDF content hash differs from the one stored on the obligation's
   `xero_binding`** (`sha256:6c701fca…` live vs `sha256:6133d587…` stored). Expected: a
   DRAFT stays editable in Xero, so the cockpit re-fetches current bytes rather than
   serving the stored pointer. Not drift.

### The second gate, which the cockpit does not surface as the blocking one

`list_ses_docs_ready_reviews` has this card at **`review_state: needs_review`** on
docket `ab859c53…` (`docket_stage: pre_xero`, committed 2026-08-06T04:16:11Z,
`invalidated_signoff_event_id: null`). So Docs Ready signoff has **not** been ticked.
Send-time re-checks current signoff, so both the AUTHORISED invoice and the signoff are
needed before the pack can go. The cockpit names the invoice wall because that is the
one hit first.

### Plain reading

The card is **clickable now** - APPROVE INVOICE is live, with clean 12-of-12 checks and
no blockers. It is **not yet sendable**, honestly so: the invoice is still a DRAFT and
the Docs Ready tick is outstanding. Both are the Captain's clicks, in that order.

Nothing in this verification wrote anything.

## Files

| File | What it is |
| --- | --- |
| `report.md` | This ledger |
| `portal-form-readback.txt` | Live redacted read of the portal share form, 2026-08-06 |
| `portal-capture-row.json` | Persisted `makesafe_portal_capture_revisions` row from the 3 Aug lock |
| `work-order-instruction.txt` | The contradicting "two storey roof report" instruction |
| `invoice-mirror-readback.json` | Live `xero_invoices` readback for SWMS-261114 |
| `obligation-history.json` | All three obligation revisions with totals and bindings |
| `duplicate-probe.json` | Read-only duplicate-guard probe output |
| `gap-sizing-counts.json` | Roof-family census behind section 9 (by design, not a gap) |
| `gap-sizing-exposed-cards.json` | The 6 cards with both a work-order storey fact and a captured portal form |
| `cockpit-verdict-and-controls.json` | Post-ruling cockpit verdict + controls (section 10) |
| `cockpit-money.json` | Post-ruling bound-invoice and proposal money block |
| `docs-ready-queue-row.json` | This card's Docs Ready queue row (`needs_review`) |
| `../decisions/2026-08-06-roof-reports-priced-off-work-order-only.md` | The ruling that settles this record |
