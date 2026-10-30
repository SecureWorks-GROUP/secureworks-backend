# Xero write register (`xero-write-register-v1`)

Every place in `supabase/functions` that can write to Xero, grouped into the rows of the Integrated Job Framework's register (A4 §4.2, ticket INT-33, requirement R-25). Read from `secureworks-backend` `879ca60`, 26 Oct 2026.

- **Source of truth:** `supabase/functions/_shared/xero_write_register.json`. This page is its human copy; the test checks the two agree.
- **The test:** `supabase/functions/_shared/xero_write_register_test.ts` scans every non-test `.ts` file with the TypeScript parser (`_shared/xero_write_sites.ts`) for an `xeroPost` call, a direct PUT, POST or DELETE fetch to a Xero accounting URL, or a call to a xero-sync write action. It fails when a site appears that no row names, or a row names one that is gone. A site's key is `file :: enclosing function or case :: METHOD /Path`, so moving a line does not change it.
- **Owner** is the accountable desk, not the code. The original P1 read-only bookkeeping scope is retained historically; X15 records the separate owner-authorised tracking correction work of 28 October.
- **Confirmed:** the CFO desk confirmed every row's owner and gate on 26 Oct (review on backend #1165, corrections applied). **Marnin approves the register.** A new row, or a change to who passes a gate, is a person's decision (P2, P12).
- **Changes the books:** *draft only* means the write lands as a Xero DRAFT, which posts nothing until a person approves it in Xero. **Sends outside** marks a path that can send to a customer or supplier (a separate gate, P2).
- **Not covered:** writes made outside `supabase/functions` (Jarvis, Railway) reach Xero only through these ops-api actions; Jarvis's own tool gates are INT-19.

**28 October addition:** X15 is a distinct posted-bill tracking correction door, separately authorised by Marnin in the bookkeeping cleanup task. It does not inherit X9's draft-only claim. CFO confirmation of the new register row remains pending (`cfo_confirmed: false`); registration does not approve deployment or additional live operations. The 26 October confirmation above applies to X1–X14.

## The rows

| # | Write | Owner | Gate today | Changes the books | Sends outside |
|---|---|---|---|---|---|
| X1 | Create a customer contact, or patch its address | Sales | Staff session (link_scope, create_invoice); the address sweep is a server job | no | no |
| X2 | Create a Xero quote | Sales | Staff press; an agent send needs approval (Jarvis sw_send_quote) | no | yes |
| X3 | Create a customer invoice (deposit, acceptance, progress, final, per party) | Ops / Bookkeeping | Staff press; invariant Acceptance Deposit Invoice. createInvoice is the one creator: create_invoice, create_invoice_draft, create_deposit_invoice, complete_and_invoice and send_acceptance_invoice all reach it. The caller may ask for AUTHORISED (send_acceptance_invoice does by default), which posts and can email without X4's gate; over MCP the Claude client's permission prompt is the only human gate, by the owner's decision of 27 Oct 2026 | yes when AUTHORISED; a DRAFT posts nothing | yes |
| X4 | Approve, void or email a customer invoice | Bookkeeping | Jarvis durable Xero money gate: ACCREC needs confirm=true or a chat approval tap; ACCPAY needs confirm=true; unknown refuses. createInvoice's email runs only when its caller asks to send | yes | yes |
| X5 | Record a payment against an invoice | Bookkeeping (CFO) | Chat: Jarvis write tool (approval card). MCP: the Claude client's permission prompt only, by the owner's decision of 27 Oct 2026. Legacy SES guard. Marks the invoice paid in Xero, into the first active BANK account unless account_code is given, then lowers our copy's amount_due itself (verification V-07: amount_due, amount_paid and status come from its own arithmetic until the next sync) | yes | no |
| X6 | Push a crew bill (trade invoice), and attach its PDF | Ops (crew pay) / CFO | With the office-review switches off, a crew submit goes straight to a Xero DRAFT bill and the bookkeeper's approval in Xero is the check. With crew_invoice_line_office_review_v1 on, the invoice is held out of Xero | draft only | no |
| X7 | Push an expense bill | CFO | Expense approved (Shaun for a job, Jan for stock); push by admin, owner or ops_manager; DRAFT only | draft only | no |
| X8 | Push or email a purchase order in Xero | Dispatch | Old path. Dispatch never pushes (slice 5 contract). Kept by choice only | no | yes |
| X9 | Draft, update or attach a supplier bill (ACCPAY), or draft a credit note | CFO | Forced to DRAFT (requireDraftStatus). Never authorised, voided or paid | draft only | no |
| X10 | Customer variation invoice draft | Dispatch / Bookkeeping | One Xero DRAFT per variation, refused while customer_variation_xero_draft_v1 is off | draft only | no |
| X11 | Make-safe and SES invoices: authorise, void, update or delete a draft, authorise on send | Make-safe desk | Legacy SES guard; the SES pipeline's own gates (read-only to this framework) | yes | yes |
| X12 | Edit a customer invoice, and email it after the edit | Bookkeeping | Staff session | yes | yes |
| X13 | Find or create a trade's or supplier's Xero contact | CFO | Inside X6, X8 and X9 | no | no |
| X14 | Have Xero email a paid invoice to the customer as a receipt (fencing and patio) **(new: found by INT-33, not in the first register)** | Bookkeeping (new row found by INT-33; the CFO desk takes it) | job_closeout_settings.receipt_sender_mode (off, dry_run, live); server key only (job_receipt_paid, job_receipt_catch_up, posted by xero-sync); one claim per invoice. Contract docs/job-receipt-v1.md. receipt_sender_mode going to live is a send gate for Marnin | no | yes |
| X15 | Correct tracking on existing AUTHORISED/PAID supplier bills | Bookkeeping / CFO | Owner/admin in the default org or dedicated server secret; POST; confirm=true, tenant and snapshot checks; tracking-only preservation and readback | yes (division classification only) | no |
| X16 | Correct tracking and/or line account code on one posted invoice, bill, credit note or spend/receive bank transaction | Bookkeeping / CFO | Owner/admin in the default org or dedicated server secret; POST; confirm=true, tenant and snapshot checks; same-class active P&L account only; amounts, tax, payments, allocations and reconciliation preserved and read back | yes (classification only) | no |

**Recorded 27 October, before X15:** Over the SecureSuite MCP connector, Jarvis added its own yes only for X4. For the X2, X3, X5, X7 and X8 tools the Claude client's permission prompt is the only human gate, and that is intended: on 27 Oct 2026 Jan decided that agent tools which move money or write to Xero get no named-person yes, so INT-19's first PR (jarvis #267) is parked and will not merge.

X15 now has separate read-only preview and privileged apply tools. Apply requires `confirm=true`; it is included in the MCP write approval surface.

## Call sites

### X1 · Create a customer contact, or patch its address

- `ghl-proxy/index.ts :: (module) :: POST xero-sync:create_or_find_contact`
- `xero-sync/index.ts :: createOrFindContact :: POST /Contacts`
- `xero-sync/index.ts :: createOrFindContact :: POST /Contacts #2`
- `xero-sync/index.ts :: sweepContactAddresses :: POST /Contacts`
- `ops-api/index.ts :: createInvoice :: POST /Contacts`
- `ops-api/index.ts :: createInvoice :: PUT /Contacts`

### X2 · Create a Xero quote

- `send-quote/index.ts :: createXeroQuote :: PUT /Quotes`

### X3 · Create a customer invoice (deposit, acceptance, progress, final, per party)

- `ops-api/index.ts :: createInvoice :: PUT /Invoices`

### X4 · Approve, void or email a customer invoice

- `ops-api/index.ts :: case void_invoice :: POST /Invoices/{id}`
- `ops-api/index.ts :: case approve_invoice :: POST /Invoices/{id}`
- `ops-api/index.ts :: case send_invoice_email :: POST /Invoices/{id}/Email`
- `ops-api/index.ts :: case approve_and_send_invoice :: POST /Invoices/{id}`
- `ops-api/index.ts :: case approve_and_send_invoice :: POST /Invoices/{id}/Email`
- `ops-api/index.ts :: createInvoice :: POST /Invoices/{id}/Email`

### X5 · Record a payment against an invoice

- `ops-api/index.ts :: reconcilePayment :: PUT /Payments`

### X6 · Push a crew bill (trade invoice), and attach its PDF

- `ops-api/index.ts :: pushTradeInvoiceToXeroAction :: PUT /Invoices`
- `ops-api/index.ts :: case submit_work_order_invoice :: PUT /Invoices`
- `ops-api/index.ts :: case generate_trade_invoice :: PUT /Invoices`
- `ops-api/index.ts :: submitTradeInvoice :: PUT /Invoices`
- `ops-api/index.ts :: case attach_invoice_pdf :: PUT /Invoices/{id}/Attachments/{id}`

### X7 · Push an expense bill

- `ops-api/index.ts :: pushExpenseToXero :: POST /Invoices`

### X8 · Push or email a purchase order in Xero

- `ops-api/index.ts :: pushPOToXero :: PUT /PurchaseOrders`
- `ops-api/index.ts :: emailPO :: POST /PurchaseOrders/{id}/Email`

### X9 · Draft, update or attach a supplier bill (ACCPAY), or draft a credit note

- `ops-api/xero_accpay_books.ts :: createSupplierBill :: PUT /Invoices`
- `ops-api/xero_accpay_books.ts :: updateSupplierBill :: POST /Invoices/{id}`
- `ops-api/xero_accpay_books.ts :: createSupplierCreditNote :: PUT /CreditNotes`
- `ops-api/xero_attachment.ts :: attachPdfToXeroInvoice :: PUT /Invoices/{id}/Attachments/{id}`

### X10 · Customer variation invoice draft

- Via X3: create_customer_variation_xero_draft calls create_invoice_draft, which reaches createInvoice. It has no call site of its own

### X11 · Make-safe and SES invoices: authorise, void, update or delete a draft, authorise on send

- `ops-api/index.ts :: makeSesXeroGateway.authorise :: POST /Invoices/{id}`
- `ops-api/index.ts :: makeSesInvoiceVoidGateway.voidInvoice :: POST /Invoices/{id}`
- `ops-api/index.ts :: updateMakesafeExistingDraftInvoice :: POST /Invoices/{id}`
- `ops-api/index.ts :: deleteMakesafeExistingDraftInvoice :: POST /Invoices/{id}`
- `ops-api/index.ts :: makesafeSendPack :: POST /Invoices/{id}`

### X12 · Edit a customer invoice, and email it after the edit

- `ops-api/index.ts :: updateInvoice :: POST /Invoices/{id}`
- `ops-api/index.ts :: updateInvoice :: POST /Invoices/{id}/Email`

### X13 · Find or create a trade's or supplier's Xero contact

- `ops-api/index.ts :: resolveTradeXeroSupplierContact :: POST /Contacts`
- `ops-api/index.ts :: resolveTradeXeroSupplierContact :: PUT /Contacts`
- `ops-api/index.ts :: pickContactId :: POST /Contacts`
- `ops-api/index.ts :: case submit_work_order_invoice :: PUT /Contacts`
- `ops-api/index.ts :: pushPOToXero :: PUT /Contacts`
- `ops-api/xero_accpay_books.ts :: resolveSupplierContactId :: PUT /Contacts`

### X14 · Have Xero email a paid invoice to the customer as a receipt (fencing and patio)

- `ops-api/job_receipt.ts :: xeroReceiptEmailer :: POST /Invoices/{id}/Email`

### X15 · Correct tracking on existing posted supplier bills

- `ops-api/xero_bill_tracking_corrections.ts :: correctSupplierBillTracking :: POST /Invoices/{id}`
- Preview does not write. Apply requires explicit confirmation and the exact preview hash; it cannot change amounts, tax, account codes, status or payments. Existing X9 draft guards remain intact.
- Gate and limitations: [posted-bill tracking contract](xero-bill-tracking-corrections.md). No send, money movement, deployment or new token authority is granted by adding this row.

### X16 · Correct line coding on posted invoices, credit notes and bank transactions

- `ops-api/xero_line_corrections.ts :: correctXeroLineCoding :: POST {id}/{id}`
- One record per request: an AUTHORISED/PAID invoice (ACCPAY or ACCREC) or credit note, or an AUTHORISED SPEND/RECEIVE bank transaction. Changes are Business Unit tracking and/or the line's account code, never amounts, tax, dates, contact, status, payments or reconciliation.
- Gate and limitations: [line coding contract](xero-line-corrections.md). No send, money movement, deployment or new token authority is granted by adding this row.

### Not writes

- `ops-api/index.ts :: _xeroPostForTest :: POST {path}`: The test-only export of ops-api's xeroPost transport. It forwards its caller's path and makes no call of its own

## Adding or changing a write

Add the new site's key to the row it belongs to, or a new row, in `xero_write_register.json` and on this page, in the same PR. Name the change in the PR so the CFO desk can confirm it and Marnin can approve it. The test prints the key it wants.
