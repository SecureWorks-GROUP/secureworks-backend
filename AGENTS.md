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

## Never Select `scope_json` In A List/Feed Query

`jobs.scope_json` (and therefore `calendar_events.scope_json`) is NOT a small
config blob: it averages ~100 kB per row and peaks at 2.6 MB. The bulk is base64
media parked under `scope_json.job.sitePlanImage` and `scope_json.job.checklist`
by the scoping tools. Everything else in the blob totals ~1.6 kB on average.

Selecting it across a range is what killed the ops calendar (`ops-api`
`?action=calendar` → HTTP 546, edge worker OOM): a 9-month window carried 115 MB
of `scope_json` for 157 kB of actually-used keys.

Rules:

- Single-job reads (`job_detail`, invoicing, PO extraction) may select the blob.
- Any query returning MANY rows must project only the keys it needs
  (`select=alias:scope_json->job->someKey`). PostgREST cannot strip keys, and
  `::text` casts are NOT honoured in filters — only projection bounds the payload.
- `calendarEvents` uses `CAL_SCOPE_PROJECTION` for this. Readiness reads scope in
  exactly two places (`evaluateCondition`): `attachment_is_fascia`
  (`scope.attachmentMethod` / `.attachment`) and `scope_mentions_asbestos`
  (the token anywhere in `JSON.stringify(scope)`). Only the asbestos one is live —
  see the `attachment_is_fascia` note below. The projection is a strict
  subset of the blob, so the substring test can never gain a false positive; it
  loses none either — verified across all 2253 live `scope_json` rows, the
  projected slice reproduces the full-blob answer for 69/69 asbestos jobs.
- `attachment_is_fascia` is INERT in production, like the `job_intelligence`
  badges below. It reads top-level `scope.attachmentMethod` / `.attachment`, and
  ZERO of the 2253 live `jobs.scope_json` rows carry either key at any level — the
  real attachment data sits under `scope_json->config` (99 rows contain the
  `fascia` token; 13 more under `scope_json->patios`). So the `engineering_doc`
  badge never fires. This is a PRE-EXISTING bug, not a regression from the
  projection: the old full-blob path and the projection both read `undefined`,
  identically. Rewiring it to `scope_json->config` would make 99 rows start firing
  a badge they don't today — a readiness-output change, so a separate product
  decision, not an incidental fix. `rd_attach_method` / `rd_attach` are retained
  in `CAL_SCOPE_PROJECTION` despite being inert: absent keys project `null` at ~0
  bytes, and they keep the intended semantics if the scoping tools ever emit them.
- If the fencing/patio scoping tools add a new FREE-TEXT key, add it to
  `CAL_SCOPE_PROJECTION` or the asbestos badge will silently miss it.
- `calendar_events` `include_financials=true` enumerates columns
  (`CAL_FINANCIAL_COLUMNS`) rather than `select('*')` for the same reason. Keep it
  in sync with the LIVE `calendar_events` view — check
  `information_schema.columns`, NOT the migrations. The view has drifted ahead of
  this repo: the newest migration defining it
  (`20260330000001_calendar_clock_fields.sql`) declares 41 columns, while live has
  44 — `label`, `visible_to_trades` and `recurrence_group_id` exist in production
  but in no migration here. `CAL_FINANCIAL_COLUMNS` is correct against live and
  includes all three. A maintainer who reconciles it against the migration instead
  would silently drop them from the `include_financials` response. Note the
  tradeoff cuts BOTH ways, and the reverse is the sharper one: `select('*')` was
  drift-proof in both directions, enumeration only in one. Because those three
  columns exist live but in no migration here, any database provisioned from these
  migrations — a fresh `supabase start`, a Supabase preview branch, a CI
  integration env — gets a PostgREST 400 (`column calendar_events.label does not
  exist`) on `include_financials=true` rather than a response. Production is
  unaffected (the columns exist there) and no in-repo code calls
  `include_financials`, which is why this is a documented follow-up and not a
  blocker. The real fix is closing the migration/view drift — a migration that
  recreates `calendar_events` with all 44 columns so the migrations match prod —
  and that is a separate task.

## `job_intelligence` Has No Readiness Columns

`computeReadiness` reads `assignment_count`, `po_count`, `wo_count`,
`deposit_paid`, `all_pos_delivery_confirmed`, `doc_types`, `quoted_amount` and
`job_type` off `job_intelligence`. Those columns do NOT exist: migration
`20260319000002_readiness_engine.sql` put them on a materialized view, and
`20260407000001_job_intelligence.sql` later replaced that MV with a TABLE of
AI-intelligence fields (`risk_level`, `ai_summary`, `financials`, …) that has none
of them. PostgREST 400s if you select them by name.

So today every one of those readiness inputs reads `undefined`: only
`crew_assigned` is real (M4 derives it from the live `assignments[]`), and
`job_type` falls back to the event row. The PO / work-order / deposit / document
badges are inert. This is a known open bug, not something to "fix" incidentally —
restoring it means restoring the columns, and readiness output changes when you do.

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
