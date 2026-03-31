# Secure Suite — System Context (for AI Strategy Sessions)

> **Owner:** Marnin Stobbe, CEO, SecureWorks WA (Perth, UTC+8)
> **Business:** Residential construction — patios, fencing, decking, renovations
> **Tech stack:** Single-file HTML dashboards + Supabase edge functions + Xero + GoHighLevel (GHL)
> **Date:** 10 March 2026

---

## The Secure Suite

| Module | File / Location | For | Status |
|--------|----------------|-----|--------|
| **Secure Scope** | Patio tool (GitHub Pages), Fencing tool (GitHub Pages) | Estimators | Live & most mature |
| **Secure CEO** | `dashboard/ceo.html` | Marnin (CEO) | Live |
| **Secure Ops** | `dashboard/ops.html` | Shaun (Ops Manager) | Live, data gaps |
| **Secure Trade** | `dashboard/trade.html` | Installers (mobile PWA) | Live |
| **Secure Sale** | Not yet built | Sales team | Planned (bonus) |

Shared code: `cloud.js` (auth, Supabase, offline queue), `brand.js` (colours, PDF helpers)

---

## Data Pipeline

```
Google Ads → GHL Lead → GHL Opportunity
                            │
                  Estimator opens Secure Scope
                  "Load from GHL" → selects opportunity
                            │
                  create_job_for_opportunity (status: draft)
                            │
                  Estimator scopes + prices job
                            │
                  "Link" action (scope complete) ← CRITICAL TRIGGER
                  • Generates job number (SWP/SWF/SWD-25XXX)
                  • Moves GHL pipeline stage
                  • Creates Xero contact
                  • Pushes $ value to GHL
                  • Status → quoted
                            │
                  Client accepts → Shaun manages in Secure Ops
                  accepted → scheduled → in_progress → complete → invoiced
                            │
                  Crew works job via Secure Trade
                  (photos, notes, service report, signature)
                            │
                  All assignments complete → "Complete + Invoice"
                  • Creates Xero invoice from pricing_json
                  • Status → invoiced (atomic action)
```

---

## Backend (Supabase Edge Functions)

| Function | Purpose | Key Actions |
|----------|---------|-------------|
| `ghl-proxy` | GHL API bridge + job sync | `get_opportunities`, `create_job_for_opportunity`, `save_scope`, `link_scope` |
| `ghl-webhook` | Inbound form webhook | Auto-creates jobs + contact attribution |
| `ops-api` | Ops CRUD (~2,100 lines) | Schedule, PO, WO, morning_brief, complete_and_invoice, trade endpoints |
| `reporting-api` | Dashboard data aggregation | `dashboard_summary`, `job_profitability`, `marketing_summary`, `trends` |
| `ops-ai` | Claude Sonnet chat backend | 9 ops tools, 7 CEO tools, tool_use with confirmation cards |
| `xero-sync` | All Xero interactions | Token refresh, invoice/PO/project sync, contact matching |
| `send-quote` | PDF quote generation | Quote distribution + client portal |
| `google-ads-ingest` | Daily ad metrics | Apps Script → Supabase |
| `daily-digest` | Daily health summary | pg_cron scheduled |

**Constraint:** ALL client-side Supabase queries fail due to RLS — everything routes through edge functions.

---

## Secure Ops — Current Architecture (`ops.html`)

### 5 Tabs
1. **Today** — AI morning brief (30-min cache), attention items (clickable with job_ids), today's assignments, upcoming week
2. **Calendar** — Full calendar with crew assignments, drag-to-reschedule, crew utilisation sidebar (green/amber/red)
3. **Jobs** — Job list with filters, slide-out detail panel (assignments, POs, WOs, scope, invoices), status pipeline
4. **Financials** — Job P&L, PO tracking, invoice status, push-to-Xero button
5. **Materials** — PO creation, supplier list, delivery tracking, scope-to-PO extraction

### Key Features
- **AI Chat Sidebar** — Claude Sonnet via `ops-ai`, quick prompts, action cards with Confirm/Cancel
- **Complete + Invoice Cascade** — Atomic: complete job + create Xero invoice in one action
- **Assignment Cascade** — When all crew assignments complete → suggests completing the job
- **Scope-to-PO** — Auto-populate PO line items from scope_json (currently broken — no data)

---

## Known Data Quality Issues (as of 3 March 2026)

| Issue | Impact | Root Cause |
|-------|--------|------------|
| `site_suburb` / `site_address` NULL on 100% of jobs | Location features broken | GHL lacks structured address fields; scoping tool doesn't require it |
| `scope_json` empty on all jobs | Scope-to-PO extraction non-functional | Legacy Tradify imports lack scope; scoping tool may not be saving correctly |
| `pricing_json` has GHL totals only (no line items) | Xero invoices are single-line items | Scoping tool line items not flowing through |
| `ops-ai` disabled | Entire AI chat sidebar non-functional | ANTHROPIC_API_KEY not set as Supabase secret |
| No GHL → Supabase stage sync | Pipeline status can drift | Sync is pull-based only (triggered by scoping tool actions) |
| No Xero payment → job status sync | Paid invoices don't update job status | xero-sync pulls data but doesn't write back to jobs |

**1,221 jobs in database** | 65% contact match | $109K Feb revenue | 59% repeat rate

---

## Secure Scope — What It Produces

The scoping tools (patio + fencing) are the most mature part of the system. They generate:
- **scope_json** — Dimensions, style, materials, special requirements
- **pricing_json** — Line items with quantities, unit prices, totals
- **Site photos** — Uploaded via signed URL flow
- **PDF quotes** — Generated via `send-quote` edge function

The tools run on iPad Safari primarily. Single-file HTML (~19,000 lines for patio). They authenticate via Supabase magic link and use `cloud.js` for all backend communication.

**Critical question:** Are the scoping tools actually saving scope_json and pricing_json to Supabase, or is the data getting lost somewhere in the pipeline?

---

## Integration Points

| From | To | How | Status |
|------|-----|-----|--------|
| Google Ads → GHL | Lead creation | Native integration | Working |
| GHL → Supabase | Job creation | `ghl-proxy` edge function (pull-based) | Working |
| Secure Scope → Supabase | Scope + pricing data | `ghl-proxy?action=save_scope` | **Needs verification** |
| Supabase → Xero | Contacts, invoices, POs | `xero-sync` edge function | Working |
| Supabase → Dashboards | Reporting data | `reporting-api` + `ops-api` | Working |
| GHL stage changes → Supabase | Pipeline sync | **NOT IMPLEMENTED** | Gap |
| Xero payments → Supabase | Payment status | **NOT IMPLEMENTED** | Gap |

---

## Technical Constraints

- **Single-file HTML** — No build step, CDN dependencies (Chart.js, Supabase JS)
- **PostgREST 1000-row limit** — Must use fetchAll() with .range() pagination
- **Xero rate limit** — 60 req/min, batch with pauses
- **Xero token expiry** — 30 minutes, auto-refresh via pg_cron
- **Xero date format** — `/Date(ms)/` needs parseXeroDate()
- **Edge function WORKER_LIMIT** — Batch heavy operations
- **iPad Safari** — Primary device for scoping tools, touch targets ≥44px

---

## Brand & Design

- Orange `#F15A29` | Dark Blue `#293C46` | Mid Blue `#4C6A7C`
- No pure black — use Dark Dusty Blue for headings
- Single orange accent per view
- Font: SF Pro Display / Inter / system fallback
- Radius: 12px consistent | Shadows: two-level opacity
- Responsive: 768px mobile, 1024px tablet breakpoints
- Dashboard design follows "newspaper model": headline stats → charts → detail tables

---

## Today's Focus: Secure Ops

We're spending today's development session on Secure Ops. The key strategic question is:

**Given the data pipeline gaps (scope_json empty, pricing_json incomplete, addresses missing, AI disabled), what are the 3-5 highest-impact fixes that unblock the most downstream features?**

The scoping tools are live and mature — so fixing the data flow FROM Secure Scope INTO Secure Ops may be the highest-leverage work, rather than building new ops features on top of empty data.
