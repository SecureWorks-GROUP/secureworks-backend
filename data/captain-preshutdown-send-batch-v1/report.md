# Captain pre-shutdown batch — ledger (2026-08-06)

Scope: reprice and remint four SES cards, then authorise and send. This ledger
records what was minted, the duplicate-guard proof for each, and the two gates
that stopped the batch. **No invoice was authorised and nothing was sent.**

## 1. Mints — three DRAFTs, every total exact, every guard clean

| Card | Job id | Invoice | Xero id | Total | Reference | `scanned_accrec` |
|---|---|---|---|---|---|---|
| Mosman Park | `762ebaad` | INV-1147 | `8f7687b0` | $885.50 (805 ex) | MLB-27482 | 1172 |
| White Gum Valley | `088dee02` | INV-1149 | `5ebf0656` | $330.00 (300 ex) | RR-26836 | 1174 |
| Mindarie | `967cdb6e` | INV-1150 | `fe826d86` | $330.00 (300 ex) | MLB-27100 | 1175 |

Each mint ran the full live-ACCREC duplicate guard inside
`create_ses_invoice_draft` (`fetchAllAccrecInvoices` + `resolveExistingInvoice`),
not the indexed probe. All three returned `state: xero_draft_created` with
`external_mutations: {xero: 1, email: 0}` — one Xero record, zero mail.

Mosman: 500 labour + 235 materials + 70 disposal = 805 ex / 885.50 inc.
Roofs: 300 ex / 330 inc each. All match the Captain's stated figures to the cent.

Gwelup INV-1015 was deliberately left untouched at $385 (out of scope).

### Cycle clears and voids

The Captain voided INV-1143, INV-1146 (Mosman), INV-1144 (WGV) and INV-1145
(Mindarie) himself. **Nothing was re-voided by this run.** WGV and Mindarie were
left with no live invoice at all — genuinely unbilled work — which these mints
restored to DRAFT. Cycle-clear proofs: `01-wgv-mindarie-cycle-clear.json`,
`mosman/01-cycle-clear.json`.

### Roof repricing instrument

Both roof cards used `commercial_quantity_override` with a `labour_rate_override`
recording `sealed_unit_price_ex_gst: 350` and `authorised_unit_price_ex_gst: 300`.
The sealed 350 was not assumed — it was read from each card's own U4 proposal
(`invoice_proposal.line_items[0].unit_price_ex_gst`, double-storey roof report),
which is exactly what `buildCommercialQuantityOverrideLines` validates against.
A mismatch there is a 409 by design.

The shared sealed schedule is unchanged globally; both cards land on
`pricing_disposition: priced_with_line_override`. No trade attendance evidence
was read for the decision or written.

## 2. System behaviour worth recording: approve refuses an API key

This is a property of the system, not a circumstance of one night.

`approve_ses_invoice_revision` refuses an ops API key outright:

> Human approval requires an identified SES operator session; API keys and
> automation keys cannot approve.

`approve_ses_release_revision` (SEND IT) carries the same gate — see
`ses_reporting_actions.ts:4180`, "Human SEND IT approval requires an identified
SES operator session; API keys and automation keys cannot approve."

So the money path **cannot** be driven end to end by automation. An API key can
prepare a docket, prepare an obligation, and mint a Xero DRAFT; it cannot cross
either approval boundary. DRAFT -> AUTHORISED -> SEND requires a Captain or
admin-owner session, by design.

The correct response to that refusal is to stop and hand back, not to reach for
another surface. Driving a logged-in browser session to click APPROVE INVOICE
would make automation indistinguishable from the human the gate exists to
require, which defeats the control rather than satisfying it. Likewise the legacy
`sw_approve_invoice` / `sw_approve_and_send_invoice` MCP paths must not be
substituted: these cards carry `ses_money_sealed_at`, so those are sealed writes
the fence refuses, and `approve_and_send` would additionally mail a Xero-branded
invoice to the contact's Xero address with no report pack and no Docs Ready
signoff.

### Second, independent stop on the two roof cards

WGV and Mindarie are both `status: HOLD`, check C11 failed, with:

- `route_draft_missing` — no report email draft on the current docket revision
- `report_only_email_applicability_parked` — "Whether report-only work uses the
  universal three-email release is still awaiting the Captain's decision."

Both are `ordinary_roof_portal` with `delivery_render_route: builder_portal`, so
the report reaches the builder through the portal rather than email. Whether a
report-only card emails a report pack at all is an open Captain question. It is
answered by a recorded ruling, never a code edit.

Mosman is `verdict.clean: true`, `status: INVOICE_CREATE_READY`, three routes
(report/photo/invoice), and its only `disabled_reason` is the DRAFT status.

## 3. Board move: not performed, and why it cannot be

Requested: move already-RELEASED cards to `completed`.

Three cards are genuinely already released, confirmed by the authoritative
cockpit (`status: RELEASED`, `release_send_progress.release_state: released`),
yet sit in `trade_report_in`:

| Card | Job id | pack | invoice_status | invoice_raw_status |
|---|---|---|---|---|
| SWMS-261128 | `047dbe8d` | sent | invoiced | **null** |
| SWMS-26953 | `d34b779e` | sent | invoiced | **null** |
| SWMS-26902 | `7aa83351` | sent | invoiced | **null** |

### Board state — unchanged, because nothing was applied

| Column | Before | After |
|---|---|---|
| new | 17 | 17 |
| allocated | 66 | 66 |
| trade_report_in | 15 | 15 |
| report_ready | 13 | 13 |
| completed | 11 | 11 |
| archive | 301 | 301 |
| cancelled | 33 | 33 |

Two independent findings make the move unreachable from an API key:

**(a) The display-ledger writer cannot produce `completed`.**
`makesafe_status_apply` is the only sanctioned writer and it takes **no target
status** — it derives the destination from M1. A whole-board dry run
(`board/20-status-apply-dryrun.json` for the named three; full-board plan run
separately) planned **21 transitions, none of them into `completed`**: 18 to
`allocated`, 2 to `report_ready`, 1 to `new`. For the three released cards it
planned `trade_report_in -> allocated`, reason "job assignment exists", missing
"5 completion photos (found 0)". Applying it would have dragged three sent,
invoiced cards backwards. Not applied.

**(b) The real cause is an unlinked invoice, and linking is sealed.**
Comparing a released card against one already in `completed` isolates the single
difference: `invoice_raw_status` is `AUTHORISED` on the completed card and
`null` on the released ones. Substatus (`admin_to_send_report`), `pack_status`
(`sent`), `invoice_status` (`invoiced`) and `status_application` (`null`) are
identical across both. So the ladder's `invoiceDone` term never fires for the
released cards — their issued ACCREC is matched by reference but not linked to
the job — and they hold at `trade_report_in`.

Per `_shared/sealed_ses_money_fence.ts`, `linked` is one of the sealed verbs
alongside created/authorised/changed/sent, and every SES card carries an explicit
`ses_money_sealed_at`. Linking these invoices is a sealed money write. It was not
attempted.

Moving a released card to `completed` therefore needs either a Captain ruling
recorded as evidence that M1 can derive from, or an instrument that accepts an
explicit target. Neither exists on this path today. Board disagreement count: 23.

## 4. Operational note

`SW_API_KEY` was printed to the session pane by a shell-expansion error in this
run (`${VAR:-NO}` returns the value when the variable is set, not the fallback).
The key should be rotated.

## Artifact index

- `00-active-cycles.json`, `00-live-accrec-three.json`, `01-wgv-mindarie-cycle-clear.json`
- `mosman/00-live-accrec-before-clear.json` … `mosman/04-mint.json`, `mosman/13-invoice-approve.json` (the API-key refusal)
- `wgv/10-docket-prepare.json`, `wgv/11-obligation.json`, `wgv/12-mint.json`, `wgv/13-cockpit.json`
- `mindarie/10-docket-prepare.json`, `mindarie/11-obligation.json`, `mindarie/12-mint.json`, `mindarie/13-cockpit.json`
- `board/20-status-apply-dryrun.json`
