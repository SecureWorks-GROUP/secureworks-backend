# SecureWorks Agent Instructions

## Acceptance Deposit Invoice Invariant

The quote self-accept flow (`send-quote` /accept → `ops-api`
`send_acceptance_invoice`) emails the client a branded "Pay Now" deposit invoice.
For that link to work, the Xero invoice MUST be `AUTHORISED` — a `DRAFT` invoice's
online link cannot take card payment and bank transfers against it land
unreconciled.

Invariants (do not regress):

- `sendAcceptanceInvoice` defaults `xero_status` to `AUTHORISED` when calling
  `createDepositInvoice` (one authoritative place). Do NOT change `createInvoice`'s
  or `createDepositInvoice`'s global `DRAFT` default — make-safe / manual / MCP
  `create_deposit_invoice` paths intentionally create drafts for review.
- The branded Pay Now email/SMS only goes out when the invoice actually came back
  `AUTHORISED` AND the OnlineInvoice URL fetch succeeded (see
  `_acceptanceInvoiceChargeable`). On failure: no client email, a loud
  `acceptance_invoice_authorise_failed` job_event, and a `{ success:false }` return
  that the accept flow handles gracefully (acceptance is still confirmed to the
  client, just without a payment link).
- The debt-followup chase cron (`daily-digest` "Unpaid Deposit Chasers") only acts
  on `AUTHORISED` deposits (positive filter) — any non-AUTHORISED status means an
  unpayable link, never chase. Likewise `sendPaymentLink` (ops-api
  `send_payment_link`) throws a 409 for any non-AUTHORISED invoice, and the cron
  only records "reminder sent" when the send actually succeeded.

## Production Edge Deploy Rule

`ops-api` and `send-quote` are production backend functions. They must have one
deployable reality only.

Production deploys are allowed only from:

- GitHub repo: `SecureWorks-GROUP/secureworks-site`
- Branch: `main`
- Local release worktree: `/Users/marninstobbe/Projects/_release/secureworks-site-main`

Do not deploy these functions from dashboard repos, stale worktrees, feature
branches, temporary folders, or copied source trees.

Allowed local command:

```bash
cd /Users/marninstobbe/Projects/_release/secureworks-site-main
SW_API_KEY=... scripts/deploy-edge-function.sh ops-api
SW_API_KEY=... scripts/deploy-edge-function.sh send-quote
```

Disallowed command from any other folder:

```bash
supabase functions deploy ops-api
supabase functions deploy send-quote
```

If a local Supabase CLI guard is installed, this disallowed command will be
blocked automatically. Do not bypass the guard.

Why this matters: there is one live Supabase function slug, but this Mac has
multiple old local copies. A deploy from a stale folder overwrites production and
can remove live actions used by Ops, Sales, Finance, Evidence, Scope Freeze, and
quote sending.

If you are unsure, do not deploy. Open a PR or run the read-only smoke script:

```bash
SW_API_KEY=... scripts/smoke-edge-functions.sh
```
