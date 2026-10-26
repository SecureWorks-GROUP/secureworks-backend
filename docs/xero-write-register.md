# Xero write register (`xero-write-register-v1`)

Every place in `supabase/functions` that can write to Xero, grouped into the rows of the Integrated Job Framework's register (A4 §4.2, ticket INT-33, requirement R-25). Read from `secureworks-backend` `879ca60`, 26 Oct 2026.

- **Source of truth:** `supabase/functions/_shared/xero_write_register.json`. This page is its human copy; the test checks the two agree.
- **The test:** `supabase/functions/_shared/xero_write_register_test.ts` scans every non-test `.ts` file with the TypeScript parser (`_shared/xero_write_sites.ts`) for an `xeroPost` call, a direct PUT, POST or DELETE fetch to a Xero accounting URL, or a call to a xero-sync write action. It fails when a site appears that no row names, or a row names one that is gone. A site's key is `file :: enclosing function or case :: METHOD /Path`, so moving a line does not change it.
- **Owner** is the accountable desk, not the code. Bookkeeping's own code calls none of these paths (P1).
- **A new row, or a change to who passes a gate, is a person's decision** (P2, P12). The CFO desk confirms each row's owner and gate (`cfo_confirmed`, all false until it does). Marnin approves the register.
- **Not covered:** writes made outside `supabase/functions` (Jarvis, Railway) reach Xero only through these ops-api actions; Jarvis's own tool gates are INT-19.

## The rows

| # | Write | Owner | Gate today | Changes the books |
|---|---|---|---|---|
| X1 | Create a customer contact, or patch its address | Sales | Staff session (link_scope, create_invoice); the address sweep is a server job | no |
| X2 | Create a Xero quote | Sales | Staff press; an agent send needs approval (Jarvis sw_send_quote) | no |
| X3 | Create a customer invoice (deposit, acceptance, progress, final, per party) | Ops / Bookkeeping | Staff press; invariant Acceptance Deposit Invoice. createInvoice is the one creator: create_invoice, create_invoice_draft, create_deposit_invoice, complete_and_invoice and send_acceptance_invoice all reach it | yes |
| X4 | Approve, void or email a customer invoice | Bookkeeping | Jarvis durable Xero money gate: ACCREC needs confirm=true or a chat approval tap; ACCPAY needs confirm=true; unknown refuses. createInvoice's email runs only when its caller asks to send | yes |
| X5 | Record a payment against an invoice | Bookkeeping (CFO) | Chat: Jarvis write tool (approval card). MCP: no Jarvis yes until INT-19 PR 1 (jarvis #267) is switched to enforce. Legacy SES guard. Marks the invoice paid in Xero, into the first active BANK account unless account_code is given, then lowers our copy's amount_due itself | yes |
| X6 | Push a crew bill (trade invoice), and attach its PDF | Ops (crew pay) / CFO | With the office-review switches off, a crew submit goes straight to a Xero DRAFT bill and the bookkeeper's approval in Xero is the check. With crew_invoice_line_office_review_v1 on, the invoice is held out of Xero | yes |
| X7 | Push an expense bill | CFO | Approval routed to Shaun (job) or Jan (stock) | yes |
| X8 | Push or email a purchase order in Xero | Dispatch | Old path. Dispatch never pushes (slice 5 contract). Kept by choice only | no |
| X9 | Draft, update or attach a supplier bill (ACCPAY), or draft a credit note | CFO | Forced to DRAFT. Never authorised, voided or paid | yes |
| X10 | Customer variation invoice draft | Dispatch / Bookkeeping | One Xero DRAFT per variation, refused while customer_variation_xero_draft_v1 is off | yes |
| X11 | Make-safe and SES invoices: authorise, void, update or delete a draft, authorise on send | Make-safe desk | Legacy SES guard; the SES pipeline's own gates (read-only to this framework) | yes |
| X12 | Edit a customer invoice, and email it after the edit | Bookkeeping | Staff session | yes |
| X13 | Find or create a trade's or supplier's Xero contact | CFO | Inside X6, X8 and X9 | no |
| X14 | Have Xero email a paid invoice to the customer as a receipt (fencing and patio) **(new: found by INT-33, not in the first register)** | Bookkeeping (proposed; found by INT-33, not in the first register) | job_closeout_settings.receipt_sender_mode (off, dry_run, live); server key only (job_receipt_paid, job_receipt_catch_up, posted by xero-sync); one claim per invoice. Contract docs/job-receipt-v1.md | no |

**Over the SecureSuite MCP connector,** Jarvis adds its own yes only for X4 today. INT-19's first PR (jarvis #267, switch `MCP_WRITE_APPROVAL_MODE`, default `warn`) asks a named person's yes for the X2, X3, X5, X7 and X8 tools; until that switch enforces, the Claude client's permission prompt is the only human gate there.

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

### Not writes

- `ops-api/index.ts :: _xeroPostForTest :: POST {path}`: The test-only export of ops-api's xeroPost transport. It forwards its caller's path and makes no call of its own

## Adding or changing a write

Add the new site's key to the row it belongs to, or a new row, in `xero_write_register.json` and on this page, in the same PR. Name the change in the PR so the CFO desk can confirm it and Marnin can approve it. The test prints the key it wants.
