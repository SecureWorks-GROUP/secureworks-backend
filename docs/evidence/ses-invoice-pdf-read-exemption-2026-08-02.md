# The money seal now permits reading an invoice PDF, and nothing else

**Date:** 2026-08-02
**Register rows addressed:** 12 and 75
**Captain's ruling:** asked whether reading an invoice PDF should be exempt from
the SES money seal — *"Yeah, of course. That should that's fine. Of course you
should be able to allow reading."*

## The defect

`ops-api` `get_invoice_pdf` ran through `assertLegacySesInvoiceActionAllowed`,
which refuses any sealed SES job with `sealed_ses_release_required`. Because
every make-safe card is sealed, the refusal was universal: no operator could
open a make-safe invoice, including invoices SecureWorks Group had already sent
to a builder.

Read-only production measurement (Supabase Management API, `read_only: true`,
SELECT only), 2026-08-02:

| Measure | Count |
|---|---:|
| SES cards (`type=makesafe` ∪ `SWMS-%` ∪ has `makesafe_job_details`) | 440 |
| …carrying an explicit `ses_money_sealed_at` | **440** |
| …with a linked ACCREC Xero invoice (the View PDF condition) | 217 |
| …with no ACCREC invoice at all (button not rendered) | 223 |
| Linked ACCREC invoice rows, all with a `xero_invoice_id` | 279 |

Every one of those 217 cards was on the refused route. Status split of the 279
invoices: PAID 107, AUTHORISED 83, DELETED 61, DRAFT 20, VOIDED 8.

## What changed

One thing: the seal's permitted-action set gained a read.

`_shared/sealed_ses_money_fence.ts` (additive only — no existing export
changed):

- `SEALED_SES_MONEY_READ_EXEMPT_ACTIONS` — a closed set whose only member is
  `get_invoice_pdf`. The fence module is the single authority on what is exempt.
- `sealedSesMoneyReadExemptionApplies(action, caller)` — **two locks**. The
  action must be on that set, **and** the caller must be an identified operator
  (the privileged ops key, or an admin/owner session). The make-safe automation
  routine is not an operator, and every write call site passes no caller context
  at all, so a write cannot reach the exemption even if a write verb were
  mistakenly listed.
- `sealedSesMoneyReadExemptionWriteVerbViolations()` — refuses any allow-listed
  name carrying a write verb, at word level, never as a substring.

`ops-api/index.ts`: the two `sealedSesMoneyRefusal` sites on the invoice route
consult that predicate; `getInvoicePdf` passes the server-resolved caller
(`authMode` plus the profile role — never a request parameter). Nothing else
moved.

### What did NOT change

- The seal's shape, its classification (`inspectSealedSesJob`), its refusal
  text, its recovery action, and the approved release path.
- Every other sealed effect: create, draft, amend, void, re-link, re-number,
  issue, send, email, share, status change. All still refuse with
  `sealed_ses_release_required`.
- Every identity and entitlement refusal on the read path itself. An invoice
  missing from the local Xero mirror still fails closed (503), an invoice with
  no authoritative job link still refuses (409), an unreadable job
  classification still refuses (503), and a synthetic live-fire job is still
  forbidden (409) — each before any Xero call.
- Non-SES invoices. An unsealed job's PDF read never needed the exemption and
  does not now depend on one.
- `create_invoice`'s and `createDepositInvoice`'s refusals, and the
  `send_invoice_email` gate at the branded-delivery site.

## Proof, both directions

`supabase/functions/ops-api/sealed_ses_money_fence_test.ts`:

- *an operator may READ a sealed make-safe invoice PDF at draft, authorised and
  paid* — all three states, all three operator caller shapes.
- *the read exemption covers every way a job is sealed, and SES-bound invoices* —
  `job_type`, `job_number`, explicit `ses_money_sealed_at`, plus an invoice
  carrying an obligation revision and an external delivery token.
- *a non-operator caller keeps the sealed refusal on the invoice PDF read* — a
  trade session, the routine, and an absent caller all still get 409
  `sealed_ses_release_required`.
- ***every write, issue, send, void, amend and relink still refuses on a sealed
  card*** — the widening guard. Sixteen sealed money actions, re-run at both the
  invoice and job gates, handed the most privileged caller context that exists.
  This fails if anyone later adds a write to the allow-list or loosens the
  exemption so the caller alone unlocks it.
- *the read exemption is exactly one action and carries no write verb* — pins
  membership and runs the write-verb guard.
- *the invoice PDF read still fails closed on identity it cannot prove*.
- *non-SES invoices read exactly as they did before the ruling*.

`ses_fence_wave2_integration_test.ts` adds a structural check that the exemption
is declared in the fence module, that the route derives its caller from
`authMode`/`authUser.role` rather than request data, and that `get_invoice_pdf`
stays off `ROUTINE_ALLOWED_ACTIONS`.

## The front end: does View PDF work now?

**Yes, on the ops dashboard, with no front-end change required.**

`ops.html` `openInvoicePdfFromXero()` calls
`ops-api?action=get_invoice_pdf` through `opsFetch`, which sends
`x-api-key: SW_API_KEY`. `get_invoice_pdf` is not on the bearer-precedence list
(`_preferBearerForOpsApiAction`), so `x-api-key` wins and the call resolves to
`authMode = 'api_key'` — a privileged operator. All 279 linked invoice rows
carry both a `job_id` and a `xero_invoice_id`, so none is stopped by a remaining
gate.

**Does it stay hidden where no invoice exists?** Yes, already. The button is
rendered only when the card has an invoice with a `xero_invoice_id`, or an
attached invoice document with a public URL — see the `Invoice` panel in
`ops.html`. The 223 SES cards with no ACCREC invoice render "No invoice yet" and
no button.

Two honest residuals, neither caused by the seal and neither in scope here:

1. **69 of the 279 invoices are DELETED (61) or VOIDED (8) in Xero.** The button
   renders for those cards and the request now passes the seal, but Xero may
   answer 404 for a deleted invoice. That is a card-data question (why is a
   deleted invoice still mirrored against a live card), not a permission one.
2. **97 cards fall back to the Xero fetch because no invoice document is
   attached to the job.** That is register row 12's other half — the button is
   offered without a locally attached PDF. It now works via Xero, so the failure
   it described is gone, but attaching the invoice PDF to the card remains the
   better end state and is separate work.

## Register

- **Row 75** ("View PDF is dead on all 22 invoices inspected because the money
  seal refuses even a read") — the seal refusal is removed for reads. Fixed by
  this change.
- **Row 12** ("View PDF is offered on sealed jobs with no attached PDF, and the
  server always refuses it") — the server no longer refuses. The button's
  presence rule was already correct (it requires an invoice), and the
  no-attached-document case is now served by the working Xero fallback. Residual
  1 and 2 above are what is left.

Per the register's own rule, both stay `FIXED-UNVERIFIED` until a different
agent re-verifies them in the live UI.

## Re-running the production measurement

Read-only, Management API `/database/query` with `read_only: true`, SELECT
statements only, no client-identifying column named. The queries are reproduced
in this document's table above; the population predicate matches
`classifySealedSesJob` in `_shared/sealed_ses_money_fence.ts`.
