# Two roof cards are ready to send and stop on the Captain's own session (2026-08-07)

Ledger for the approve-and-send run on SWMS-261081 (Mindarie) and SWMS-261114
(White Gum Valley). **Nothing was sent and nothing was written.** Both cards stop
at step 1 on an identity gate that only the Captain's logged-in cockpit session
can pass.

## What the Captain has to press

Four clicks total, two per card, in his own Ops Dash SES review cockpit:

| Card | Click 1 | Click 2 |
|---|---|---|
| SWMS-261081 Mindarie | **APPROVE INVOICE** | **SEND IT** |
| SWMS-261114 White Gum Valley | **APPROVE INVOICE** | **SEND IT** |

`APPROVE INVOICE` is enabled on both cards right now. `SEND IT` is disabled only
because the invoice is still DRAFT; it enables itself once the authorise lands.

## Why the skill cannot do it

`approve_ses_invoice_revision` refuses the privileged ops key by construction.
Measured on both cards, live, 2026-08-07:

```
{"success":false,"refusal":{"state":"refused","fact":
 "Human approval requires an identified SES operator session;
  API keys and automation keys cannot approve."}}
```

The gate is `canRecordSesApproval` (`ses_review_cockpit.ts`), which returns
`allowed:false` for any `auth.mode !== "jwt"`, and `approveSesInvoiceRevisionAction`
(`ses_reporting_actions.ts`) throws 403 before any RPC — so the refusal is
side-effect free. `makesafe_revision_approvals` still holds **0** rows for both
jobs after both attempts.

`approve_ses_release_revision` (SEND IT) carries the same gate, so the second
click is his too. The two `execute_*` actions do accept the ops key, so once he
approves, the authorise and the send can be driven from here.

No identity migration in the live ledger changes this. Newest applied migration
is `20260806010000_ses_release_one_route_invoice_shape`; `ses_release_operators`
is empty, so approval authority comes only from an admin/owner JWT.

## State verified before stopping

Read live, read-only, ops-api v1068.

**The one-route roof exemption is behaving.** Both cockpits plan exactly one
email: `route_kinds: ["invoice"]`, `route_count: 1`. Nothing composes a report or
photo route.

Both cockpits: `status: INVOICE_CREATE_READY`, `verdict.clean: true`,
`approval_band: shaun_clean`, zero blockers, all twelve checks C1-C12 passed.

Money, read by reference in `xero_invoices` rather than off the board flag:

| Card | Invoice | Reference | Status | Total |
|---|---|---|---|---|
| SWMS-261081 | INV-1150 `fe826d86-2160-41e8-b703-469b10c72ed2` | MLB-27100 | DRAFT | $330.00 inc |
| SWMS-261114 | INV-1149 `5ebf0656-4440-4802-95bf-8d0324d8269e` | RR-26836 | DRAFT | $330.00 inc |

The mirror is current, not stale: 141 `xero_invoices` rows updated in the five
minutes before the read. So DRAFT is today's truth, not a cached flag. The
earlier $385 invoices on both references (INV-1145, INV-1144) are DELETED and
their obligation revisions are `void_linked` — that repricing is already done and
needs no further action.

Neither card has ever been sent: **0** rows in `ses_release_route_proofs` and no
`route_send` effect in `ses_external_effects` for either job. The only effects
are the confirmed `invoice_create` pair at 04:16 / 04:17 on 2026-08-06 that minted
these two drafts.

## One thing to know before the next prepare

Both cards' current `local_invoice_proposal` still carries the superseded
`roof_storey_fixed` figure — $350 ex / $385 inc — because that docket revision was
prepared on 2026-08-06 before the ruling landed. The bound Xero DRAFT is the ruled
$300 ex / $330 inc, held by a `priced_with_line_override` obligation revision, and
that bound invoice is the money that matters. `ROOF_REPORT_PRICING` in
`roof_report_template.ts` already reads double = $300 ex / $330 inc, so the stale
proposal is history, not a live wrong price.

Still, do not re-prepare either card before sending. A new docket revision
invalidates the Docs Ready signoff and re-keys the revision for no gain — both
cards are already clean with the correct invoice bound.
