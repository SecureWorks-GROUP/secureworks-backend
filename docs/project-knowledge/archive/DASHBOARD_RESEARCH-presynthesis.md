# Building a unified BI dashboard for a Perth outdoor living company

A custom Supabase-powered dashboard combining Google Ads, GoHighLevel, and Xero can give this business something no off-the-shelf tool provides: **complete attribution from ad click to cash received**. The architecture is straightforward — GHL webhooks for real-time CRM events, pg_cron-scheduled Edge Functions polling Xero and Google Ads, a star schema in PostgreSQL linking everything via a unified contact record, and a vanilla JS frontend with Chart.js. The entire system runs on Supabase's $25/month Pro plan, replacing Fathom's ~$100 AUD/month while adding marketing attribution and operational metrics Fathom never offered. For a business doing 50–100 jobs per year at $3–25k each, the data volumes are trivially small — the real challenge is maintaining the attribution chain across three platforms that weren't designed to talk to each other.

---

## 1. The attribution chain: linking a click to a dollar collected

The single hardest problem in this build is maintaining an unbroken chain from Google Ads click through to paid invoice. The chain has four links: **GCLID → GHL Contact → GHL Opportunity → Xero Invoice**. Break any one link and attribution dies.

### How GCLID flows through the system

GoHighLevel auto-captures GCLID from URL parameters when a visitor submits a native GHL form, survey, calendar booking, or chat widget on the same page they landed on. This is critical — **if the user navigates away from the landing page before submitting, GCLID is lost**. GHL stores GCLID in the contact's attribution data (both "First Attribution" and "Latest Attribution") and includes it in outbound webhook payloads as a standard field alongside `first_name`, `email`, `phone`, and `tags`.

However, GCLID is not easily exportable from GHL's UI — it doesn't appear as a column in contact list views or CSV exports. The workaround is to create a **custom Single Line text field** on the Contact record called "GCLID" and populate it via a hidden form field or workflow action. This makes the value explicitly queryable via the API and extractable via webhooks.

### The unified contact record as primary key

No single identifier works across all three platforms. The correct approach is a **Supabase-managed unified contact record** that stores foreign keys to each system:

```
dim_contact (
  contact_key       UUID PRIMARY KEY,    -- Supabase-generated
  ghl_contact_id    TEXT UNIQUE,         -- GoHighLevel contact ID
  xero_contact_id   TEXT UNIQUE,         -- Xero ContactID (UUID)
  gclid             TEXT,                -- Google Click ID
  email             TEXT,                -- Primary match field
  phone             TEXT,                -- Secondary match field
  full_name         TEXT,
  source            TEXT,                -- 'google_ads', 'referral', 'organic'
  utm_source        TEXT,
  utm_campaign      TEXT
)
```

**Email is the primary matching field** between GHL and Xero. GHL's native Xero integration already matches contacts by email or phone. For the dashboard's Supabase layer, match on email first, then phone, then fuzzy name match with manual review. Once matched, store the `xero_contact_id` permanently — Xero's ContactID is a stable UUID that never changes, unlike contact names which Xero enforces as unique but which can be edited.

### Linking opportunities to invoices

GHL opportunities link to exactly one contact. Xero invoices link to one contact. The join happens through the shared contact record: `fact_opportunity.contact_key → dim_contact.contact_key ← fact_invoice.contact_key`. For a business doing 50–100 jobs per year, manual verification of the opportunity-to-invoice link is feasible and recommended during the first 3–6 months. Over time, automate the match by comparing opportunity value against invoice subtotal, or by storing the GHL opportunity ID in Xero's invoice reference field when creating invoices.

### GCLID validity and the sales cycle

GCLIDs remain valid for **90 days** for offline conversion import. With typical patio/fencing sales cycles of 2–8 weeks, this is adequate. Store GCLIDs as TEXT fields (they can exceed 100 characters) and capture them at form submission time alongside all UTM parameters and the landing page URL. For leads that don't convert within 90 days, GCLID-based conversion upload to Google Ads won't work, but the attribution data remains permanently useful for internal reporting.

---

## 2. The 18 metrics that matter for scaling from founder-led to operator-led

These metrics are ordered by the data source they primarily draw from and designed for a business transitioning to 2–3 sales reps with install crews. Every metric includes its calculation, source system, and benchmark where available.

### Marketing efficiency (from Google Ads + Supabase joins)

| # | Metric | Calculation | Source | Target |
|---|--------|------------|--------|--------|
| 1 | **Monthly ad spend** | Sum of daily cost | Google Ads | $2–5k AUD |
| 2 | **Cost per lead (CPL)** | Ad spend ÷ leads generated | Google Ads + GHL | $30–80 AUD for outdoor living |
| 3 | **Cost per acquisition (CPA)** | Ad spend ÷ won jobs | Google Ads + GHL | $500–2,000 AUD |
| 4 | **True ROAS** | Revenue from ad-attributed jobs ÷ ad spend | Xero + GHL + Google Ads | >5:1 |
| 5 | **Lead volume by source** | Count of new contacts by attribution source | GHL | Track trend |

True ROAS is the metric that justifies this entire build. No off-the-shelf tool calculates it correctly for this business because revenue lives in Xero while ad spend lives in Google Ads and lead attribution lives in GHL. The Supabase join across all three sources is the only way to compute it: `SUM(xero_invoice.subtotal WHERE contact.gclid IS NOT NULL) / SUM(google_ads.cost)`.

### Sales performance (from GHL)

| # | Metric | Calculation | Target |
|---|--------|------------|--------|
| 6 | **Lead response time** | Time from lead creation to first human contact | <5 minutes (21× more likely to convert) |
| 7 | **Quote-to-win rate** | Won jobs ÷ quotes sent | 25–40% |
| 8 | **Average deal size** | Revenue ÷ won jobs (split by patio vs fencing) | $15–25k patios, $3–8k fencing |
| 9 | **Pipeline velocity** | (Qualified opps × win rate × avg deal) ÷ avg cycle days | Track trend |
| 10 | **Sales rep comparison** | Win rate, response time, revenue per rep | Relative ranking |

Lead response time becomes the single most important metric when transitioning from founder-led sales. The founder typically responds to enquiries within minutes; new reps may take hours. Track this obsessively. **Pipeline velocity** is the compound metric that captures the entire sales engine's throughput — it degrades when any component (lead volume, win rate, deal size, or cycle time) worsens.

### Operations (from GHL + scheduling data)

| # | Metric | Calculation | Target |
|---|--------|------------|--------|
| 11 | **Active jobs by stage** | Count of opportunities by pipeline stage | Visual pipeline board |
| 12 | **Crew utilisation rate** | Billable hours on jobs ÷ total available hours | 60–80% |
| 13 | **Schedule density** | Booked days ÷ available days per crew per week | >80% signals need for new crew |

For a business with 2–3 install crews doing patio installs (2–5 days each) and fencing (1–2 days each), schedule density directly predicts whether the business can take on more work or needs to hire. At **4–8 completed jobs per week** across all crews, capacity planning is manageable but becomes critical during Perth's September–March peak season.

### Financial health (from Xero)

| # | Metric | Calculation | Target |
|---|--------|------------|--------|
| 14 | **Gross profit margin** | (Revenue – COGS) ÷ Revenue | 25–35% for outdoor living |
| 15 | **Net profit margin** | Net profit ÷ revenue | 10–15% |
| 16 | **Job-level profitability** | Job revenue – (materials + labour + subs) per tracking category | >25% per job |
| 17 | **Aged receivables** | Outstanding invoices by age bucket: 0–30, 30–60, 60–90, 90+ days | Flag anything >30 days |
| 18 | **Weighted pipeline forecast** | Sum of (opportunity value × stage probability) | Forward-looking revenue |

**Job-level profitability** (metric 16) was consistently the #1 most valuable insight cited by trades businesses that implemented custom dashboards. Use Xero tracking categories — create one tracking category called "Job" with an option for each project (e.g., "Smith Patio Install"). Tag every invoice line item, bill, and payment with the job name. The Xero P&L report API accepts `trackingCategoryID` and `trackingOptionID` filters, enabling per-job profit extraction.

All financial metrics should display **GST-exclusive figures** (use Xero's `SubTotal` field, not `Total`), consistent with Australian management accounting conventions. The exception is cash flow tracking, which should be GST-inclusive since GST is actually collected and paid.

---

## 3. Dashboard layout across three timeframes

### Daily view: what needs attention right now

The daily view is an operational dashboard designed to be checked in under 30 seconds, ideally displayed on a wall-mounted TV or tablet in the office. Show **5–7 metrics maximum**:

- New leads today (count + source breakdown)
- Uncontacted leads alert (any lead without response >1 hour, highlighted red)
- Active jobs status board (Fergus-style: red = needs action, amber = waiting, green = on track)
- Today's crew schedule (who's where)
- Bank balance snapshot (pulled from Xero bank summary)

Place the most critical KPI (uncontacted leads) in the **top-left position** — research consistently shows this is where eyes go first. Use traffic-light colour coding throughout. Include a "Last Updated" timestamp since the dashboard refreshes periodically, not in real time.

### Weekly view: are we on track

The weekly view is a tactical dashboard for the Monday morning meeting. It adds trend context and rep-level comparison:

- Leads this week vs weekly target, with source breakdown
- Quotes sent and won this week vs target
- Win rate with week-over-week trend arrows (↑↓→)
- Revenue booked this week
- Aged receivables alert (anything >30 days, with amount)
- Crew utilisation percentage
- Pipeline value change (net new pipeline added minus pipeline closed/lost)

Use **progress bars toward monthly targets** so the team can see mid-month whether they're tracking. Group metrics by function: Marketing → Sales → Operations → Finance. Enable drill-down from any summary number to the underlying records (e.g., clicking "5 quotes sent" shows the list of quotes with values and assigned reps).

### Monthly view: strategic performance

The monthly view replicates what Fathom provided for financials while adding the marketing and sales dimensions Fathom lacks:

- Revenue vs target vs same month last year (bar chart with comparison)
- P&L summary: revenue, COGS, gross profit, overheads, net profit (sparklines showing 12-month trend)
- Gross margin % and net margin % with 12-month trend
- CPL, CPA, ROAS by channel (Google Ads vs organic vs referral)
- Win rate by sales rep (stacked bar chart)
- Weighted pipeline value (forward 30/60/90 days)
- Cash flow projection (invoiced, expected receipts, known outgoings)
- Job profitability scatter plot (job value on X-axis, margin % on Y-axis — instantly reveals which job types are most profitable)

Fathom's approach of showing a "KPI Scorecard" with green ticks and red crosses is worth replicating — a summary panel showing what percentage of KPIs are on target provides an instant health check. Limit the monthly view to **10–12 KPIs** with the ability to drill into each.

---

## 4. Technical architecture: tables, syncs, and Edge Functions

### Database schema: a star schema built for dashboards

The schema follows a dimensional model with **6 dimension tables** and **5 fact tables**, designed for fast aggregation queries that power dashboard widgets.

**Dimension tables** store slowly-changing reference data:

- `dim_contact` — the unified contact record linking GHL, Xero, and GCLID
- `dim_pipeline_stage` — pipeline stages with `is_won` and `is_lost` flags and `stage_order` for funnel analysis
- `dim_campaign` — Google Ads campaign hierarchy (campaign → ad group → keyword)
- `dim_team_member` — sales reps and crew members with roles
- `dim_service` — service types (Patio, Carport, Fencing, Deck)
- `dim_date` — pre-populated date dimension for time-based aggregation

**Fact tables** store transactional events:

- `fact_opportunity` — accumulating snapshot of each deal, with date fields for each pipeline milestone (lead created, site visit, quote sent, won, lost), `estimated_value`, `actual_value`, GCLID, and foreign keys to contact and campaign dimensions
- `fact_invoice` — mirrors Xero invoices with `subtotal` (GST-exclusive), `tax`, `total`, `amount_paid`, `amount_due`, and a foreign key to the opportunity
- `fact_payment` — individual payments against invoices, critical for cash flow tracking
- `fact_ad_spend` — daily Google Ads metrics per campaign: impressions, clicks, cost, conversions
- `fact_stage_change` — records every pipeline stage transition with timestamp and duration, enabling pipeline velocity calculations

**Materialized views** pre-compute dashboard metrics, refreshed every 30 minutes via pg_cron using `REFRESH MATERIALIZED VIEW CONCURRENTLY` (non-blocking). Key views: `mv_dashboard_metrics` (monthly roll-ups), `mv_pipeline_funnel` (current active pipeline), `mv_campaign_roi` (ROAS by campaign). These views are exposed via PostgREST to the frontend but note that **PostgreSQL does not support RLS on materialized views** — gate access through security-definer functions or database-level GRANTs.

### Sync schedule for each data source

| Source | Method | Frequency | Why |
|--------|--------|-----------|-----|
| GHL contacts/opportunities | Webhooks to Edge Function | Real-time | `ContactCreate`, `OpportunityStageUpdate` events fire instantly |
| GHL full reconciliation | pg_cron → Edge Function (API poll) | Daily 2am AWST | Catches missed webhooks; uses paginated `GET /contacts` and `GET /opportunities` |
| Xero invoices + payments | pg_cron → Edge Function with `If-Modified-Since` | Every 15 min | Xero allows 60 calls/min, 5,000/day; incremental sync uses ~50–100 calls/day |
| Xero P&L + Balance Sheet reports | pg_cron → Edge Function | Daily 6am AWST | Reports API returns pre-computed financials; store as JSONB |
| Google Ads campaign metrics | Google Ads Script → Supabase REST API (direct `UrlFetchApp`) | Daily 8am AWST | Google Ads data finalises within 3–15 hours; daily pull is sufficient |
| Google Ads reconciliation | Same script, re-pulling last 7 days | Daily | Conversion data can change for up to 30 days; re-pulling recent data ensures accuracy |
| Materialized view refresh | pg_cron → SQL | Every 30 min | `REFRESH MATERIALIZED VIEW CONCURRENTLY` — non-blocking |
| Xero token refresh | pg_cron → Edge Function | Every 20 min | Access tokens expire in 30 minutes; proactive refresh prevents failures |

### GHL webhook handler pattern

The Edge Function receives GHL webhooks at a public endpoint with JWT verification disabled. It validates the `x-wh-signature` header (SHA256), checks for duplicate delivery using a `webhook_log` table with a UNIQUE constraint on `webhook_id`, then routes by event type. The critical design choice: **return HTTP 200 immediately, then process**. GHL only retries on HTTP 429 (rate limit) — 5xx errors are treated as permanent failures with no retry. Build your own retry logic by queuing failed events in a `sync_queue` table and processing them on a separate cron schedule.

### Google Ads: Scripts beat the API for this use case

The Google Ads API requires a developer token (potentially weeks of approval), OAuth2 infrastructure, and ongoing token management — massive overkill for a single account spending $2–5k/month. **Google Ads Scripts** run directly inside Google Ads, require no developer token, access the same data via GAQL queries, and can push data directly to Supabase using `UrlFetchApp`. A daily-scheduled script pulling campaign-level metrics (clicks, impressions, cost, conversions) and pushing via `POST` to Supabase's REST API with `Prefer: resolution=merge-duplicates` is the simplest, most maintainable approach. The script is ~30 lines of JavaScript, runs on Google's infrastructure, and requires zero external hosting.

### Xero OAuth2 token management

Xero access tokens expire after **30 minutes** and refresh tokens expire after **60 days** (sliding — each use resets the 60-day window). Store both tokens encrypted in Supabase Vault. A dedicated Edge Function triggered every 20 minutes by pg_cron refreshes the access token proactively. After each refresh, immediately store the new refresh token — Xero provides a 30-minute grace period where the old refresh token remains valid, giving a safety net for retries. For maximum simplicity, investigate Xero's **Custom Connections** feature (available for Australian organisations) which uses a `client_credentials` OAuth2 grant requiring no user interaction and no refresh token management.

### Frontend: vanilla JS with Chart.js

The frontend loads `supabase-js` and `Chart.js` from CDN — no build step, no framework, no node_modules. CSS Grid provides responsive layout: `grid-template-columns: repeat(auto-fit, minmax(350px, 1fr))`. Each dashboard card queries Supabase directly using the JS client library, with RLS policies ensuring sales reps only see their own opportunities while the owner sees everything. For live notifications (new lead arrived), subscribe to Postgres changes on the `fact_opportunity` table using Supabase Realtime. Host the static HTML/CSS/JS files on Supabase Storage, Netlify, or Vercel — all free tier.

---

## 5. What trades businesses learned building custom dashboards

Direct case studies of trades businesses building bespoke BI dashboards combining all three data sources (CRM + accounting + ad spend) are rare — most rely on platform-native reporting or tools like Fathom and Fergus. But clear patterns emerge from adjacent examples.

**Fergus + Xero** is the closest real-world analogue. Fergus (popular among Australian/NZ trades, 20,000+ users) offers a Business Performance Dashboard powered by Xero integration that shows gross profit, net profit, and what-if scenarios. Users report dramatic results: one plumbing company cut office admin time from one day per week to one day per month, and another "smashed an extra 20–30% onto sales through sheer organisational efficiency." The key insight: **job-level profitability** was the single most valued metric. Knowing which specific jobs made money and which eroded margin changed how businesses quoted and scheduled.

**Coupler.io templates** for Power BI and Looker Studio represent the most concrete example of combined CRM + ad spend dashboards. These templates connect Google/Meta Ads + GA4 + CRM (HubSpot/Pipedrive) to visualise the full funnel: Impressions → Clicks → Leads → Opportunities → Won Deals, with spend efficiency analysis comparing advertising costs against actual customer acquisition costs by channel. The pattern is directly applicable to this build, with Supabase replacing the BI tool layer.

**What consistently worked**: automating data collection (eliminating manual spreadsheet entry), displaying job profitability in real time, and showing aged receivables prominently. **What consistently failed**: tracking too many KPIs simultaneously (information overload killed engagement), not connecting ad spend to actual closed revenue (stopping at "leads generated" left the most important question unanswered), and manual data entry dashboards that inevitably fell behind within weeks.

GoHighLevel's community forums reveal persistent frustration with GHL's native reporting: custom fields can't be used in dashboard widgets, there are no math operations for conversion rate calculations, and attribution fields aren't exportable. This frustration is exactly what the custom dashboard solves. Third-party tools like AgencyAnalytics create enhanced GHL dashboards by combining GHL data with Google Ads and Facebook, but still can't incorporate Xero financial data — reinforcing the case for the custom build.

---

## 6. Gotchas that will cost you days if you don't know them

### Attribution gaps that silently destroy your data

GHL captures GCLID only from **native GHL forms, surveys, calendars, and chat widgets** — and only when the form is submitted on the same page the user landed on. If someone lands from an ad, navigates to a different page to fill out a form, the GCLID is gone. Worse, **web chat and Conversation AI do not reliably capture GCLID** — this is a known gap with an active feature request. Google Ads call extensions also produce no GCLID attribution in GHL. Mitigate by: (a) ensuring all lead capture forms are on landing pages, (b) implementing Enhanced Conversions for Leads as a GCLID-free backup using hashed email/phone, and (c) accepting that some leads will have no attribution and building "unknown source" into your reporting.

### GHL API and webhook reliability

GHL webhooks retry only on **HTTP 429** (rate limit), with 6 attempts over ~70 minutes using 10-minute intervals plus jitter. **5xx errors are NOT retried** — they're treated as permanent failures. This means your Edge Function must never return a 500 error for a webhook it intends to process. Return 200 immediately, queue the event, and process asynchronously. API rate limits are **100 requests per 10 seconds** and **200,000 per day** per app per location — generous for a single-account dashboard, but implement exponential backoff and respect `X-RateLimit-Remaining` headers.

### Xero rate limits and the token refresh trap

Xero's limits are strict: **5 concurrent requests, 60 per minute, 5,000 per day** per organisation per app. The 30-minute access token expiry means your token refresh cron must be bulletproof — a failed refresh cascading into multiple retries can eat rate limit budget quickly. The most dangerous edge case: your refresh token expires after 60 days of non-use (e.g., during a holiday shutdown), requiring full re-authorisation. Set up monitoring that alerts if the last successful token refresh was more than 30 days ago.

As of March 2026, Xero is transitioning to a new commercial API pricing model based on egress. However, **bespoke integrations built for a single client are exempt** from the new pricing tiers — this business qualifies as a single-company custom integration.

### Contact deduplication between GHL and Xero

Xero enforces unique contact names but not unique emails or phones. GHL does not enforce uniqueness on any field. This creates several failure modes: a customer "John Smith" might exist as "John Smith" in Xero but "John" in GHL; a returning customer might create a new GHL contact via a different form submission while their Xero contact already exists. Implement a `contact_match_status` field on your unified contact record: `auto_matched` (email matched), `manual_review` (fuzzy name match needs confirmation), `unmatched` (no match found). For a business with <500 total contacts, monthly manual review of unmatched records is feasible.

### Perth timezone: simpler than you'd think, but easy to get wrong

Perth operates on **AWST (UTC+8) with no daylight saving time**, which actually simplifies things — the offset never changes. Store all timestamps in `TIMESTAMPTZ` (timezone-aware) in PostgreSQL. Xero API returns timestamps in UTC. GHL webhook timestamps come in UTC (ISO 8601). Google Ads data uses the account timezone (likely set to AWST). The gotcha: **pg_cron runs in UTC by default on Supabase**. A cron job scheduled for "2am AWST" must be set to `0 18 * * *` (6pm UTC). Display all dashboard times in AWST using JavaScript's `Intl.DateTimeFormat` with `timeZone: 'Australia/Perth'`.

### GST: the subtotal trap

Every number on the dashboard must clearly indicate whether it's GST-inclusive or exclusive. Xero invoices have both `SubTotal` (GST-exclusive) and `Total` (GST-inclusive). Use `SubTotal` for all revenue and profitability metrics — this matches Xero's P&L report which is inherently GST-exclusive. Use `Total` only for cash flow projections and bank balance reconciliation. Track estimated **GST payable for the current BAS period** as a liability metric: `SUM(GST collected on income) - SUM(GST paid on expenses)`. Quarterly BAS is due on the 28th of the month following each quarter (Feb, May, Aug, Nov).

### Google Ads data finality

Google Ads metrics are not immediately final. Clicks and impressions stabilise within 3 hours, but **conversion data can change for up to 30 days** depending on the attribution model and conversion window. Data-driven attribution conversions may take up to 15 hours to appear at all. The dashboard should re-pull the last 7 days of data on every daily sync and the last 30 days weekly. Display a note on any metric using Google Ads data: "Ad data may adjust for up to 30 days."

### Statistical significance with low volume

With **50–100 jobs per year** and 10–50 leads per month, per-campaign or per-keyword statistical comparisons are meaningless in any given month. Google's Smart Bidding needs a minimum of 30 conversions per month to optimise effectively — this business is borderline for lead-based bidding and well below the threshold for value-based bidding on won jobs alone. Design the dashboard to show **rolling 90-day or 12-month metrics** for marketing efficiency rather than monthly snapshots. Use "Maximise Conversions" bidding optimising for form submissions (higher volume signal), while using offline conversion data for internal reporting and manual optimisation rather than algorithmic bidding.

---

## Conclusion: build sequentially, not all at once

The most important architectural decision is not technical — it's sequencing. Build in four phases, each delivering immediate value:

**Phase 1 (Week 1–2)**: GCLID capture on website forms, Google Ads Script pushing daily campaign metrics to Supabase, basic marketing dashboard showing CPL by campaign. This alone answers "are my ads working?" — a question the business currently can't answer.

**Phase 2 (Week 3–4)**: GHL webhook integration for real-time lead and opportunity tracking. Pipeline board, lead response time tracking, rep comparison. This is the operational dashboard the team will check daily.

**Phase 3 (Month 2)**: Xero integration for financial data. Job profitability via tracking categories, aged receivables, P&L metrics. This replaces Fathom and adds the Xero-to-GHL contact matching that enables true ROAS calculation.

**Phase 4 (Month 3)**: Forecasting (weighted pipeline × conversion rate), offline conversion upload back to Google Ads, Enhanced Conversions for Leads as attribution backup, and role-based access for the team.

Each phase is independently useful. If the founder builds Phase 1 and stops, the business still gains marketing attribution it never had. The total infrastructure cost is **~$25/month** (Supabase Pro) versus $100+/month for Fathom alone, without marketing attribution, without operational metrics, and without the unified view that connects a Google Ads click to a collected payment sitting in the bank.