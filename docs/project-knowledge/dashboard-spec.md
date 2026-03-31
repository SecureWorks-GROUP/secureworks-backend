# Dashboard Implementation Spec (from user brief)

## Tab Priority Order
1. Daily Cockpit (landing page) → Reports → Job P&L → Marketing

## Reports Tab Layout
- Row 1: 4 stat cards — Revenue MTD (with % target + YoY), Gross Margin % (rolling 30d), Cash at Bank, Overdue AR
- Row 2: 12-month revenue trend with GP margin overlay (dual y-axis)
- Row 3: Two half-width — Revenue by Service Type (horiz bar) + Monthly P&L Waterfall
- Row 4: P&L summary table (compact, grouped, budget variance)
- Row 5: Aged receivables (horizontal stacked bar then detail table)

## Job P&L Tab Layout
- Row 1: 4 stat cards — Avg Job Margin %, Jobs Completed MTD, Avg Job Value, Quote Accuracy
- Row 2: Scatter plot (revenue vs margin %, coloured by type, 30% ref line) — hero chart
- Row 3: Margin Distribution histogram + Avg Margin by Job Type bar
- Row 4: Full job table (sortable, filterable, conditional formatting)

## Marketing Tab Layout
- Row 1: 3 stat cards — CPL, CPA (cost per won job), PPAD
- Row 2: Conversion funnel (Clicks → Leads → Quotes → Won → Invoiced)
- Row 3: CPL trend + Lead Source breakdown
- Row 4: Campaign table (sorted by PPAD)

## Key Derived Metrics
- Break-even jobs/month: monthly fixed costs ÷ avg GP per job
- Weighted pipeline forecast: open opps × stage close rate
- Quote aging distribution: 0-7, 8-14, 15-30, 30+ days
- Revenue per crew day: revenue ÷ crew-days
- PPAD (Profit Per Ad Dollar): GP from ad-sourced jobs ÷ ad spend
- Cash flow projection: AR aging + pipeline + committed expenses (8-12 weeks)

## Alert Thresholds (Perth Trades)
- GM < 28% → amber, < 25% → red
- Invoice 30+ days → amber, 60+ days → red
- Cash < 1.5× monthly fixed → amber, < 1× → red
- Pipeline coverage < 2× → amber
- CPL > $120 → investigate
- Quote > 14 days unanswered → action required

## Design Principles
- Newspaper model: headline (stat cards) → story (charts) → detail (tables)
- Never show revenue without margin
- Max 4-5 stat cards per tab
- Exception-based: show problems first
- Forward-looking: 40% of metrics should be pipeline/forecast
- RAG colours: standard traffic light (not brand colours)
- Avoid: pie charts (use doughnut), 3D charts

## Dimensional Filters
- Time period selector per tab
- Business unit (fencing/patios/reno)
- Salesperson (future when GHL has assigned rep data)
