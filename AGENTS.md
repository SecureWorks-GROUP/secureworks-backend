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
- Only `AUTHORISED` deposits have a payable link — any non-AUTHORISED status means
  an unpayable link, so never chase or send one. `sendPaymentLink` (ops-api
  `send_payment_link`) enforces this with a 409 for any non-AUTHORISED invoice.
  (The `daily-digest` "Unpaid Deposit Chasers" cron that shared this invariant no
  longer runs — see "daily-digest is OFF" below.)

## daily-digest is OFF

Its 6 cron jobs (`daily-digest`, `intraday-nudge-check`, `stale-followup`,
`eod-followup-5pm`, `eod-escalation-7pm`, `shaun-morning-brief`) were unscheduled
in migration `20260715000001`. The morning brief, nudges, stale/EOD follow-ups,
deposit chasers, weekly pulse and CEO brief no longer run.

Nothing was deleted — the function still serves on-demand calls and
`trigger_daily_digest()` still exists — so this is reversible by re-running the
original `cron.schedule()` statements. Do not re-add cron callers without a
decision.

The digest's default path was a kitchen sink carrying work unrelated to digests.
When touching any of this, know:

- **`ai_alerts` is NOT daily-digest-owned.** It has live writers (ops-api trade
  issues, variation approvals, low satisfaction, scoper price updates;
  telegram-bot keyword alerts) and readers (ops-api dismiss/resolve, ops-ai +
  agent-runner `get_ai_alerts`, system-health). Never drop it.
- **Two things together stop system-health Telegram-spamming the admin**, and
  breaking either brings the spam back:
  1. The digest's 7-day auto-resolver was re-homed to `resolve_stale_ai_alerts()`
     on the `ai-alerts-stale-reaper` cron (`20260715000002`). It sets
     `resolved_at` and leaves `dismissed_at` alone (parity with the digest, so
     auto-resolved stays distinguishable from human-resolved).
  2. system-health's stale-alerts count filters `resolved_at IS NULL` as well as
     `dismissed_at IS NULL`. It previously counted only `dismissed_at`, so the
     reaper's work was invisible to it and the check still climbed to `critical`
     at ≥30 alerts >48h, firing an unthrottled Telegram alert every 30 min.
- **`weekly_reports` is orphaned** — the digest was its only writer. system-health's
  "digest not run" check was removed with the digest, since it would alarm forever.
- **The AI graduation-downgrade safety net (`checkGraduationDowngrades()`) is off**
  by decision, and was deliberately not re-homed.
- **Completion packs are not being sent, and were not before either.** The digest's
  sweep (`index.ts:2749`) was the only automated caller of `completion-pack`, and it
  is dormant now the crons are off — but it never worked anyway (see below). Repair
  is deferred to its own task. Anything reviving it must handle: deposit invoices are
  `ACCREC` with `${job_number}-DEP${pct}` references, so a paid *deposit* satisfies a
  naive "final invoice is paid" test; no job carries a `job.completion_pack_sent`
  dedup event, so an unguarded first run would backfill all of history.

## xero_invoices column names

The real columns are `invoice_date`, `invoice_type` and `fully_paid_on` (see
`20250301000003_reporting_schema.sql`). `date`, `type` and `fully_paid_on_date`
have never existed. PostgREST 400s on an unknown column, and callers that ignore
the error read `data` as null — which is how daily-digest's completion-pack sweep
looked healthy while sending nothing for its entire life. `daily-digest/index.ts`
still contains those bogus names; harmless while it is off, but they must be fixed
before it is ever re-enabled. If a `xero_invoices` query mysteriously returns
nothing, check the column names first.

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
