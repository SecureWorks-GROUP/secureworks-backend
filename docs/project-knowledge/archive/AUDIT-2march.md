# Dashboard Gap Analysis & Audit

**Date**: 2 March 2026
**Current State**: Dashboard has 5 tabs (Pipeline, Schedule, Reports, Job P&L, Marketing)
**Target State**: 4 tabs per spec (Cockpit, Reports, Job P&L, Marketing)

---

## TIER 1: DATA FIXES (Nothing else matters if the numbers are wrong)

### 1.1 Reports Tab — Revenue MTD shows $0

**Spec says**: Revenue MTD stat card should show current month revenue (e.g., "$87,000") with YoY comparison, progress bar, sparkline.
**Actually shows**: `$0` with `↓ -100% vs same month LY ($1,529)`

**Root cause**: The `dashboard_summary` action in reporting-api queries `monthly_revenue` view which is built on `xero_invoices` table filtered by `invoice_date` truncated to current month start. If Xero hasn't issued any invoices dated in March 2026 yet (or the Xero sync hasn't pulled them), this returns $0.

**Diagnosis needed**:
1. Check if `xero_invoices` has any rows with `invoice_date` in March 2026
2. Check when `xero-sync` last ran successfully (check `xero_tokens` table)
3. Check if Xero actually has March 2026 invoices

**Fix**: Query the database to check data freshness. If sync is stale, trigger it. If Xero genuinely has no March invoices yet (start of month), show previous month data with clear "No March data yet" label instead of misleading $0.

---

### 1.2 Reports Tab — Gross Profit MTD shows $0, Margin 0%

**Spec says**: Gross Margin % stat card with RAG border (green ≥30%, amber 25-29%, red <25%), sparkline, comparison to rolling average.
**Actually shows**: `$0` GP, `0%` margin with red RAG border saying "Critical — investigate job costs"

**Root cause**: Same as 1.1 — revenue is $0, so GP = $0 and margin = 0/0 = 0%. The margin card correctly shows red RAG but for the wrong reason.

**Fix**: Same as 1.1. Also: when revenue is $0 for current month (start of month is common), show "No data yet for March" instead of triggering false red alerts.

---

### 1.3 Reports Tab — P&L Table shows $0 for Current Month

**Spec says**: P&L Summary Table with columns: Category | MTD Actual | MTD Budget | Variance $ | Variance % | YTD Actual.
**Actually shows**: Income $0, Less Cost of Sales $0, Gross Profit $0, etc. for "Current Month". Previous Month shows real data ($109K income). YTD shows $215K.

**Root cause**: The `xero-sync` function fetches P&L reports using `?reportingPeriod=CURRENT`. If Xero generates this report for March but March has no transactions yet, all values are $0. The P&L report is a Xero-side snapshot, not a live query.

**Fix**:
1. Check if `xero_reports` table has a P&L report for March 2026
2. If the report exists but all values are $0 (start of month), hide the current month column or show "Data pending"
3. Better: also fetch MTD P&L using a date range parameter (`fromDate` / `toDate`) not just `reportingPeriod=CURRENT`

---

### 1.4 Marketing Tab — PPAD shows "Needs Xero data for profit calc"

**Spec says**: PPAD (Profit Per Ad Dollar) is THE hero metric. Should show `$X.XX` with RAG border (green ≥$5, amber $2-5, red <$2), sparkline, comparison to prior 30 days.
**Actually shows**: `—` with subtitle "Needs Xero data for profit calc"

**Root cause**: The `marketing_summary` action calculates PPAD as `gross_profit / ad_spend` where `gross_profit = ACCREC revenue - ACCPAY costs` from `xero_invoices` matched via `contact_matches.job_id`. If:
1. No `contact_matches` rows have both `gclid` (Google Ads) AND `job_id` (Xero match), OR
2. No `xero_invoices` are matched to those jobs

Then `adsRevenue = 0`, `adsCosts = 0`, `adsGrossProfit = 0`, `ppad = 0`.

**Diagnosis needed**:
1. Check `contact_matches` table — how many rows have both `gclid` AND `job_id`?
2. Check if any `xero_invoices` have `job_id` values that match ad-sourced jobs
3. The attribution chain: Google Ads click → GHL lead (with GCLID) → contact_match → Xero invoice. Which link is broken?

**Fix**: The whole attribution pipeline needs verification. Likely the `match_contacts` function in xero-sync isn't finding matches because GHL contact emails don't match Xero contact emails, or GCLIDs aren't being captured.

---

### 1.5 Marketing Tab — CPA shows $0

**Spec says**: Cost Per Won Job stat card should show rolling 30-day CPA with comparison to prior 30 days.
**Actually shows**: `$0`

**Root cause**: CPA = total_spend / acquisitions. The `marketing_summary` action counts acquisitions by looking at `contact_matches` where `gclid IS NOT NULL` AND `job_id IS NOT NULL`, then checks if those jobs have status `accepted+`. Since GHL jobs rarely reach `accepted` status (they stay in `draft`/`quoted`/`cancelled`), acquisitions = 0.

**Fix**: Either:
1. Broaden the acquisition definition (any job from an ad-sourced lead counts)
2. Use Xero invoice data instead (if an ad-sourced contact has a paid invoice, that's an acquisition)

---

### 1.6 Marketing Tab — Campaign data limited to current month only

**Spec says**: Campaign Performance Table showing campaigns sorted by PPAD with spend, clicks, leads, CPL, jobs won, CPA, revenue, profit, PPAD columns.
**Actually shows**: Only 2 campaigns for the current period ("Dynamic Search" and "Search | Dynamic") because the `adsMonthly` query in reporting-api filters to `currentMonthStart`. When period filter is 30D, the campaign table SHOULD show 30 days of data aggregated by campaign but was previously using the monthly view.

**Status**: FIXED in this session — changed to aggregate from `daily_data` instead of `adsMonthly` view. Campaign table now respects period filter.

---

### 1.7 Job P&L Tab — Very few jobs have Xero invoice data

**Spec says**: Scatter plot of Revenue vs Margin % for all completed/invoiced jobs, with cost breakdown, quoted vs actual comparison.
**Actually shows**: Most jobs show $0 invoiced/$0 costs because `xero_invoices.job_id` matching is poor (only ~4 exact name matches between GHL and Xero out of 1000+ jobs and 159 invoices).

**Root cause**: Invoice-to-job matching relies on:
1. Reference field parsing (looking for job IDs in invoice references)
2. Contact name matching (GHL name vs Xero contact name)
Both methods have very low match rates because GHL stores phone numbers/emails as client names, and invoice references don't contain job IDs.

**Fix**: User said to use **Xero Projects** as source of truth for per-job P&L. This would be a new data source — need to add Xero Projects API integration to `xero-sync`.

---

### 1.8 Win Rate shows 0%

**Spec says**: Quote-to-Won % with RAG (green ≥35%, amber 25-34%, red <25%).
**Actually shows**: 0% because no GHL jobs reach `accepted` status — they stay in `draft`/`quoted`/`cancelled`.

**Root cause**: GHL pipeline stages don't map to the expected lifecycle. Most opportunities stay in one stage and never progress through accepted → scheduled → complete.

**Fix**: Either recalculate win rate using Xero data (invoiced = won), or fix the GHL pipeline mapping.

---

## TIER 2: STRUCTURAL FIXES (Missing tabs, wrong layouts, missing chart types)

### 2.1 No Daily Cockpit Tab

**Spec says**: Default landing tab with 5 stat cards (Cash, Revenue vs Target, Jobs Active, Pipeline Health, Overdue AR), Attention Items panel, Break-Even Tracker, Cash Flow Mini-Forecast.
**Actually has**: Pipeline tab as default (job status cards, job list, search/filter). No Cockpit tab exists.

**Fix**: Build Cockpit tab as new default landing view per spec.

---

### 2.2 Reports Tab — Missing Revenue & Margin Trend (stacked by service type)

**Spec says**: 24-month chart with revenue bars stacked by service type (Patio orange, Fencing blue, Combo green) + Gross Margin % line on right axis + 30% reference line.
**Actually has**: 6-month "Profitability Trend" bar chart showing Revenue, Direct Costs, and Gross Profit as a line. Not stacked by service type. Not 24 months.

**Fix**: Rebuild chart to match spec — stacked bars by type, 24 months, dual axis with margin line.

---

### 2.3 Reports Tab — Missing P&L Waterfall Chart

**Spec says**: Vertical waterfall chart: Revenue (green) → minus COGS (red) → Gross Profit (blue) → minus Overhead (red) → Net Profit (green/red).
**Actually has**: No waterfall chart at all.

**Fix**: Add Chart.js waterfall chart using floating bars.

---

### 2.4 Reports Tab — P&L Table missing Budget/Variance columns

**Spec says**: Columns: Category | MTD Actual | MTD Budget | Variance $ | Variance % | YTD Actual. With sub-line indentation for revenue/cost categories.
**Actually has**: Category | Current Month | Previous Month | YTD. No budget data, no variance columns, no sub-line breakdown.

**Fix**: Add budget columns. Budget data needs to either come from Xero budgets API or be configurable in `org_config`.

---

### 2.5 Reports Tab — Aged Receivables should be stacked horizontal bar, not buckets

**Spec says**: Horizontal stacked bar chart showing dollar amounts by bucket (green→red gradient), THEN detail table of 30+ day items.
**Actually has**: Grid of bucket cards (Current, 1-30, 31-60, 61-90, 90+) with a detail table below. No stacked bar chart.

**Fix**: Add stacked horizontal bar chart above the detail table.

---

### 2.6 Job P&L Tab — Missing Margin Distribution Histogram

**Spec says**: Bar chart bucketing jobs by margin %: <20%, 20-25%, 25-30%, 30-35%, 35-40%, 40%+. Coloured red (<25%), amber (25-30%), green (30%+).
**Actually has**: No histogram exists.

**Fix**: Add margin distribution histogram chart.

---

### 2.7 Job P&L Tab — Missing Average Margin by Job Type grouped bar

**Spec says**: Grouped bar chart with Quoted Margin (lighter) and Actual Margin (full) per job type. Shows over/under-quoting patterns.
**Actually has**: No such chart exists.

**Fix**: Add grouped bar chart.

---

### 2.8 Job P&L Tab — Missing Quote Accuracy Trend line chart

**Spec says**: 12-month line chart of monthly average (actual margin - quoted margin). Zero line = perfect accuracy. Catches quoting drift.
**Actually has**: No such chart exists.

**Fix**: Add quote accuracy trend chart.

---

### 2.9 Marketing Tab — Missing Conversion Funnel

**Spec says**: Horizontal HTML/CSS funnel: Clicks → Leads → Quotes → Won → Invoiced → Paid with conversion rates between stages. RAG highlighting on rates below benchmarks.
**Actually has**: No funnel visualization.

**Fix**: Build HTML/CSS funnel component.

---

### 2.10 Marketing Tab — Missing CPL & PPAD Dual-Axis Trend

**Spec says**: 18-month dual-axis line chart — CPL (orange, left axis) + PPAD (green, right axis) with reference lines at $100 CPL and $5 PPAD.
**Actually has**: Separate "Ad Spend + Conversions" and "Cost Per Lead Trend" charts (12 months, not 18). No PPAD trend.

**Fix**: Replace with single dual-axis chart per spec.

---

### 2.11 Marketing Tab — Missing Lead Source Performance chart

**Spec says**: Grouped horizontal bar chart. For each source (Google Ads, Organic, Referral, Direct), show two bars: Leads (light) and Profit (dark).
**Actually has**: Doughnut chart of lead sources (count only, no profit data).

**Fix**: Replace doughnut with grouped horizontal bar chart including profit data.

---

### 2.12 Marketing Tab — Campaign Table missing PPAD, Revenue, Profit columns

**Spec says**: Columns: Campaign | Spend | Clicks | Leads | CPL | Jobs Won | CPA | Revenue | Profit | PPAD. Default sort by PPAD descending.
**Actually has**: Campaign | Impressions | Clicks | CTR | Avg CPC | Spend | Conversions | Conv Rate | CPL. Missing Jobs Won, CPA, Revenue, Profit, PPAD columns.

**Fix**: Add missing columns. Requires attribution data (contact_matches linked to campaigns).

---

### 2.13 Marketing Tab — Missing Attribution Detail section

**Spec says**: Collapsible section showing individual ad-click-to-profit trails: GCLID | Campaign | Click Date | Lead Date | Quote Date | Won Date | Invoice Date | Paid Date | Revenue | Costs | Profit | PPAD.
**Actually has**: No attribution trail section.

**Fix**: Add collapsible attribution table. Requires full attribution chain data.

---

### 2.14 Tab Navigation doesn't match spec

**Spec says**: 4 tabs: 🏠 Cockpit | 📊 Reports | 🔨 Jobs | 📣 Marketing. Active tab has orange underline. URL hash updates. localStorage remembers last tab.
**Actually has**: 5 tabs: Pipeline | Schedule | Reports | Job P&L | Marketing. Active tab has orange background (not underline). No URL hash. No localStorage.

**Fix**: Restructure tab bar per spec. Keep Pipeline/Schedule as secondary views if needed.

---

### 2.15 Debt Follow-Up Page (user requested)

**Spec says**: Not in spec, but user explicitly requested a page for debt follow-up with: amount owing per client, invoice breakdown, phone numbers from GHL.
**Actually has**: Nothing.

**Fix**: Build as a section within Reports tab or as a standalone view.

---

## TIER 3: POLISH (RAG colours, sparklines, formatting, responsive, interactions)

### 3.1 Stat cards missing RAG left borders

**Spec says**: Every stat card has 4px solid left border coloured by RAG status (green/amber/red).
**Actually has**: RAG borders exist on some cards (margin, CPL) but not consistently applied. Some use `.rag-green`/`.rag-amber`/`.rag-red` classes but not all cards.

**Fix**: Apply RAG borders consistently to all stat cards per spec thresholds.

---

### 3.2 No sparklines in stat cards

**Spec says**: Stat cards should have optional inline sparklines (13-week/13-month mini charts).
**Actually has**: No sparklines in any stat cards.

**Fix**: Add inline Chart.js sparklines to stat cards (Cash, Revenue, Margin, CPL, PPAD).

---

### 3.3 No progress bars in stat cards

**Spec says**: Revenue vs Target card should show progress bar (e.g., "73% of target").
**Actually has**: No progress bars.

**Fix**: Add progress bar component to stat cards where specified.

---

### 3.4 CSS design system doesn't match spec

**Spec says**: New CSS variables: `--rag-green: #22C55E`, `--rag-amber: #F59E0B`, `--rag-red: #EF4444`, `--bg-secondary: #F8FAFC`, `--text-primary: #1E293B`, etc.
**Actually has**: Old variables: `--sw-green: #27AE60`, `--sw-yellow: #E67E22`, `--sw-red: #E74C3C`, etc.

**Fix**: Update CSS variables to match spec.

---

### 3.5 Data formatting inconsistencies

**Spec says**: Currency `$XX,XXX` (no cents unless <$100). Percentages `XX.X%`. Dates `DD MMM YYYY`. Large numbers `$342K` in stat cards. Negative values red with minus sign.
**Actually has**: Mixed formatting. `fmt$()` uses `Math.round(Number(n)).toLocaleString()` which gives correct thousands separators but no cents handling. Dates in various formats.

**Fix**: Implement consistent `formatCurrency()`, `formatPercent()`, `formatDate()` utilities per spec.

---

### 3.6 Tables not sortable

**Spec says**: All tables sortable by clicking column headers with sort indicator arrow.
**Actually has**: Tables are static, not sortable.

**Fix**: Add click-to-sort with direction indicator.

---

### 3.7 No CSV export

**Spec says**: "Export to CSV" button on each table.
**Actually has**: No export functionality.

**Fix**: Add CSV export function for each table.

---

### 3.8 Chart full-screen toggle missing

**Spec says**: All charts have a "full screen" toggle button.
**Actually has**: No full-screen option.

**Fix**: Add expand/collapse button to chart containers.

---

### 3.9 Stat card click-to-scroll missing

**Spec says**: Clicking any stat card smoothly scrolls to the relevant detail section on the same tab.
**Actually has**: Stat cards are not clickable.

**Fix**: Add click handlers with smooth scroll to detail sections.

---

### 3.10 Responsive design incomplete

**Spec says**: Mobile (<768px): Single column stat cards, full-width charts, scrollable tables, scrollable tab pills. Tablet (768-1024px): 2-column stat grids. Desktop (>1024px): Full row stat cards, side-by-side charts.
**Actually has**: Basic responsive with some media queries but not matching spec breakpoints.

**Fix**: Update responsive CSS per spec breakpoints.

---

### 3.11 No URL hash or localStorage for tabs

**Spec says**: URL hash updates on tab switch (#cockpit, #reports, #jobs, #marketing). Remember last active tab in localStorage.
**Actually has**: Neither implemented.

**Fix**: Add hash routing and localStorage tab memory.

---

### 3.12 Trend arrows direction-aware formatting

**Spec says**: Green ↑ when metric improves (context-dependent: margin up = good, CPL up = bad). Red ↓ when deteriorates.
**Actually has**: Basic trend arrows on some metrics but not consistently direction-aware.

**Fix**: Implement direction-aware trend formatting utility.

---

## DATA VERIFICATION RESULTS (2 March 2026)

### Xero Token: EXPIRED
- `expires_at: 2026-03-02T00:29:01 UTC` — expired ~12 hours ago
- Token was last refreshed at `00:00:01 UTC` on March 2
- pg_cron token refresh job may have stopped working

### Xero Invoices: No March ACCREC data
- 47 total ACCREC (sales) invoices synced
- **ZERO ACCREC invoices dated March 2026** — this is why Revenue MTD = $0
- March literally just started (2nd) — there may genuinely be no invoices yet
- Several ACCPAY (bills) in March but in DRAFT status
- One anomalous ACCREC invoice dated Nov 2026 (future-dated?)

### Xero Reports: Latest is March 1
- P&L for March 2026 exists (created Mar 1) — but March has $0 data
- P&L for Feb 2026 exists — shows real data ($109K income)
- YTD P&L exists (Jan 1 - Mar 1) — $215K
- Aged receivables report exists (Mar 1)

### Google Ads: Data through March 1
- Two active campaigns: "Search | Dynamic" and "Dynamic Search"
- Latest data: March 1, 2026
- Data looks healthy (clicks, spend, conversions present)

### Contact Matches: COMPLETELY EMPTY (0 rows)
- **This is the root cause of PPAD, CPA, and attribution all being broken**
- The `match_contacts` xero-sync action either never ran or found 0 matches
- Without contact_matches, there's no Google Ads → GHL → Xero attribution chain

### Jobs: All in early pipeline stages
- 562 cancelled, 282 draft, 156 quoted
- **ZERO** accepted, scheduled, in_progress, complete, or invoiced
- All 1000 jobs from GHL sync — GHL pipeline doesn't track beyond "quoted"
- Win Rate = 0% because no jobs ever reach "accepted"

### Root Cause Summary
1. **Revenue $0**: March just started, genuinely no invoices yet. Dashboard should show last complete month.
2. **PPAD/CPA broken**: contact_matches table empty — attribution chain never established.
3. **Win Rate 0%**: GHL jobs never progress past "quoted" — lifecycle incomplete.
4. **Xero token expired**: pg_cron refresh may have stopped.

---

## TIER 1 FIX RESULTS (2 March 2026)

### T1.1: Revenue MTD $0 — FIXED
- reporting-api now falls back to previous month when current month has $0 revenue
- Feb 2026: $22,724 revenue, $31,512 costs, -39% margin (real Xero data)
- UI labels update to show "February 2026 (final)" when using fallback

### T1.2: Contact Matches Backfill — FIXED
- Created 548 contact_matches rows from existing GHL jobs (359 + 189 execution pipeline)
- 124 matched to Xero contacts (by email + name matching)
- 15 ACCREC invoices linked to jobs + many more from execution pipeline matches

### T1.3: Win Rate 0% — FIXED
- Root cause: only syncing from GHL Sales pipelines, not Execution pipelines
- Added Fencing Execution + Patios Execution pipeline sync with full stage mapping
- 221 new jobs created from execution pipelines (136 complete, 16 in_progress, 15 accepted, 10 scheduled, 10 invoiced)
- Win Rate now: **54%** overall, 30-60% per month (was 0%)
- Also fixed: PostgREST 1000-row limit was silently truncating queries — added `fetchAll` pagination

### T1.4: CPA $0 — FIXED
- Broadened acquisition definition: uses Xero invoiced jobs as "won" signal (not just GHL accepted)
- CPA now: **$42** (blended — rolling 90d spend / won jobs)
- PPAD now: **$19.37** (profit per ad dollar)
- ROAS now: **19.4x** (note: ads_costs = $0 because supplier bills not matched to jobs yet)

### T1.5: Xero Projects + Tracking Categories Integration — FIXED
- Added `xero_projects` table (migration 006) — stores per-project financial data
- Added `sync_projects` action to xero-sync — pulls all 171 Xero Projects
  - 108 matched to internal jobs via xero_contact_id → contact_matches → job_id
  - Per-project: revenue invoiced + expenses logged = real per-job P&L
- Added `sync_tracking_pl` action — pulls P&L by "Business Unit" tracking category
  - 12 months of data synced (Apr 2025–Mar 2026)
  - Revenue breakdown: Fencing, Patios, Renovations, Insurance Work, Other
- Updated `jobProfitability()` in reporting-api:
  - Xero Projects data used as primary source for per-job costs (102 jobs matched)
  - Falls back to ACCPAY invoice matching for unmatched jobs
  - Overall margin: **42%** (was 0% when relying on bill matching only)
  - Data source breakdown: 102 xero_projects, 898 none (no Xero project linked)
- Updated `dashboardSummary()` with:
  - `revenue_by_type`: Feb 2026 → Patios $43K, Fencing $42K, Reno $11K
  - `stacked_revenue`: 12-month stacked bar data for Fencing/Patios/Reno/Other
- **Note**: Xero Projects expense data quality is low (bookkeepers not matching receipts).
  Purchase orders integration planned to improve this.

## PRIORITY EXECUTION ORDER

### Phase 2: Tier 1 Data Fixes
1. Fix Revenue MTD $0 (1.1, 1.2, 1.3) — verify Xero sync, handle start-of-month
2. Fix PPAD attribution chain (1.4) — diagnose broken link
3. Fix CPA $0 (1.5) — broaden acquisition definition
4. Fix Win Rate 0% (1.8) — use Xero invoiced as "won" signal
5. Improve job-to-invoice matching (1.7) — investigate Xero Projects API

### Phase 3: Tier 2 Structural Fixes
1. Build Daily Cockpit tab (2.1)
2. Rebuild Reports tab charts (2.2, 2.3, 2.5)
3. Add P&L budget/variance columns (2.4)
4. Build Job P&L charts (2.6, 2.7, 2.8)
5. Build Marketing funnel + charts (2.9, 2.10, 2.11, 2.12, 2.13)
6. Update tab navigation (2.14)
7. Build Debt Follow-Up (2.15)

### Phase 4: Tier 3 Polish
1. CSS design system update (3.4)
2. RAG borders everywhere (3.1)
3. Sparklines (3.2) + progress bars (3.3)
4. Data formatting consistency (3.5)
5. Sortable tables (3.6) + CSV export (3.7)
6. Interactive features (3.8, 3.9, 3.11)
7. Responsive refinement (3.10)
8. Trend arrows (3.12)
