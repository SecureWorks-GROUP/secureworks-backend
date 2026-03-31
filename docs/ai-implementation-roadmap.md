# SecureWorks AI Implementation Roadmap

**Purpose:** This document is the build spec for layering AI intelligence onto the existing Secure Suite. Hand this to Claude Code and say "build this, in order."

**Constraints:** Everything runs on Supabase edge functions + Anthropic API. No external SaaS (no Sameday AI, no Wisetack, no Hardline). Budget: under $200/month Anthropic API costs at 45 jobs/month. Team of 5-6, not tech-savvy — AI must be invisible or dead simple.

**Current state (as of 16 March 2026):**
- ops-ai: 1,262 lines, 19 tools (9 ops + 7 CEO + 10 intelligence), tool-use loop with Claude Sonnet
- daily-digest: 881 lines, 15 alert rules, AI narrative, weekly pulse
- Tables ready: ai_alerts, weekly_reports, crew_availability (all created today)
- All dashboards live: CEO, Ops, Trade, Sale
- Data: ~1,200 historical jobs, 45 new/month, growing to 80-100

---

## PHASE 1: Run the SQL + Set the API Key (Today)

Before anything else works, run this in the Supabase SQL Editor:

```sql
-- ai_alerts table
CREATE TABLE IF NOT EXISTS ai_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES organisations(id),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  alert_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('red', 'amber')),
  message text NOT NULL,
  recommended_action text,
  financial_impact numeric(12,2),
  detail_json jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX idx_ai_alerts_org ON ai_alerts(org_id);
CREATE INDEX idx_ai_alerts_active ON ai_alerts(org_id) WHERE dismissed_at IS NULL AND resolved_at IS NULL;
ALTER TABLE ai_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view org alerts" ON ai_alerts FOR SELECT USING (true);
CREATE POLICY "Service role manages alerts" ON ai_alerts FOR ALL USING (auth.role() = 'service_role');

-- weekly_reports table
CREATE TABLE IF NOT EXISTS weekly_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES organisations(id),
  week_start date NOT NULL,
  report_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_narrative text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(org_id, week_start)
);
ALTER TABLE weekly_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users view weekly reports" ON weekly_reports FOR SELECT USING (true);
CREATE POLICY "Service role manages weekly reports" ON weekly_reports FOR ALL USING (auth.role() = 'service_role');
```

Then set the Anthropic API key:
```bash
/Users/marninstobbe/.local/bin/supabase secrets set ANTHROPIC_API_KEY="sk-ant-..." --project-ref kevgrhcjxspbxgovpmfl
```

---

## PHASE 2: Fire Prevention — Make the Daily Digest Operational (Week 1)

**What:** The daily-digest edge function is deployed with 15 alert rules and AI narrative. Wire it into the dashboards so Shaun and Marnin actually see the alerts every morning.

**Files to modify:**
- `~/Projects/securedash-temp/ops.html` — Add alerts panel to Today tab
- `~/Projects/securedash-temp/ceo.html` — Add alerts panel to overview

**Build spec:**

### 2a. Alerts Panel in Ops Dashboard
Add to the ops.html Today tab (top of page, before schedule):
- Fetch `daily-digest` on load (cache for 1 hour in sessionStorage)
- Show red alerts as dismissible cards with orange left border
- Show amber alerts below in a collapsible section
- Each card: severity icon, title, detail text, recommended action, "Dismiss" button
- Dismiss calls ops-api to set `dismissed_at` on the ai_alert row
- If zero alerts: show a green "All clear" card with the AI narrative text

### 2b. Alerts Panel in CEO Dashboard
Same pattern but styled for the CEO view. Show the AI narrative prominently as the first thing Marnin reads. Below it, show the alert cards.

### 2c. Schedule the Daily Digest
Set up pg_cron to trigger daily-digest at 7am AWST (11pm UTC previous day):
```sql
SELECT cron.schedule(
  'daily-digest-7am',
  '0 23 * * *',
  $$SELECT net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
  )$$
);
```
(May need pg_net extension — check if it's enabled. If not, use Supabase's built-in cron or an external trigger.)

### 2d. Weekly Pulse Schedule
Same approach, trigger `daily-digest?action=weekly_pulse` every Monday at 7am AWST.

**API cost estimate:** Daily digest = ~2K input tokens + 300 output tokens for narrative = ~$0.01/day. Weekly pulse = ~4K + 500 = ~$0.02/week. Monthly total: ~$0.40.

**ROI:** Catches uninvoiced jobs (the "completed not invoiced" alert alone protects $15-25K per occurrence), material ordering delays, stale quotes. Conservative estimate: prevents 2-3 missed invoices per month = $30-50K/year protected.

---

## PHASE 3: Supplier Price Intelligence — The Data Moat (Week 2-3)

**What:** A live supplier pricing database that grows automatically from every confirmed PO. The scope tool's hardcoded material rates stay current with real supplier pricing instead of going stale. This is the moat — competitors can copy the UI but not 1,200+ jobs of real supplier pricing data.

**Two systems:**

### System A — Supplier Price Capture (the core loop)

**The loop:**
```
PO confirmed with supplier quote attached
  → AI reads the PO line items and maps each to the scope tool's material database
    → AI flags price differences: "CMI now charges $48/m for 100x50x2mm SHS — scope tool has $42/m"
      → Human reviews the comparison and confirms/dismisses each item
        → Confirmed items update the scope tool's supplier price database
          → Next scope uses current real pricing from actual supplier quotes
```

**Critical safeguard:** AI SUGGESTS, never auto-applies. Every price change requires human confirmation because:
- Sometimes it's not apples-to-apples (different gauge, finish, one-off pricing)
- Supplier quotes may include volume discounts that aren't standard
- The scope tool line item naming may not exactly match the PO line item naming

**What to build:**

### 3a. Material Price Ledger Table
A living database of supplier prices captured from confirmed POs:
```sql
CREATE TABLE IF NOT EXISTS material_price_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  supplier_name text NOT NULL,
  item_description text NOT NULL,
  -- Normalised identifiers for matching to scope tool
  material_category text, -- steel, roofing, flashings, concrete, fixings, guttering
  material_code text, -- e.g. "SHS-100x50x2", "SOLARSPAN-75", "POST-100x100"
  unit text, -- m, ea, m2, bag, sheet, length
  unit_price numeric(12,2) NOT NULL,
  -- Source tracking
  po_id uuid REFERENCES purchase_orders(id),
  job_id uuid REFERENCES jobs(id),
  captured_at timestamptz DEFAULT now(),
  -- Confirmation workflow
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz,
  dismiss_reason text,
  -- Scope tool mapping
  scope_tool_field text, -- which field in the scope tool this maps to (e.g. "steelPricePerM")
  previous_rate numeric(12,2), -- what the scope tool had before
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_price_ledger_supplier ON material_price_ledger(supplier_name);
CREATE INDEX idx_price_ledger_material ON material_price_ledger(material_code);
CREATE INDEX idx_price_ledger_pending ON material_price_ledger(status) WHERE status = 'pending';
```

### 3b. PO Price Extraction (edge function action)
Add an action to ops-api: `extract_po_pricing`
- Triggered when a PO status changes to 'confirmed' (or manually from the PO detail view)
- Reads the PO's `line_items` JSONB array
- For each line item, attempts to map it to a known material_code using fuzzy matching:
  - "100x50x2.0 SHS @ 6.0m" → material_code: "SHS-100x50x2", unit: "length", price: $X
  - "SolarSpan 75mm 8.1m" → material_code: "SOLARSPAN-75", unit: "sheet", price: $X
  - Items that can't be mapped go into the ledger as `material_code: null` for manual classification
- Uses Claude Sonnet to do the fuzzy matching (PO line items vary wildly in format across suppliers)
- Inserts rows into `material_price_ledger` with status='pending'

### 3c. Price Review UI in Ops Dashboard
Add a section to ops.html (or a new tab):
- Shows pending price captures: "3 new supplier prices detected from PO-042 (CMI)"
- Each item shows: supplier, description, new price, current scope tool rate, % difference
- Green highlight if price went down, red if it went up
- Two buttons per item: "Confirm" (updates ledger status + marks scope_tool_field for update) and "Dismiss" (with reason dropdown: wrong item match / one-off pricing / bulk discount / other)
- Batch confirm button for when all items in a PO look correct

### 3d. Scope Tool Price Sync
- When prices are confirmed, they DON'T auto-update the scope tool (the scope tools are standalone HTML files on GitHub Pages)
- Instead, generate a "Price Update Report" that lists exactly what to change:
  - "Update STEEL.SHS_100x50x2.pricePerM from $42.00 to $48.00 (based on 3 confirmed POs from CMI, last: 14 March 2026)"
- Show in the CEO dashboard as an actionable card
- Future enhancement: the scope tool could fetch current prices from a Supabase table on load, eliminating the manual update step entirely

### System B — Broad Quote vs Actual Comparison (aggregate view)

This is the higher-level view that compares total quoted material cost vs total PO cost per job:
- Already exists as `estimate_accuracy_report` tool in ops-ai
- Add a CEO dashboard section showing:
  - Overall material cost ratio (actual PO total as % of quoted material total)
  - Breakdown by job type: patio, fencing, combo
  - Trend over time (rolling 90-day average — are we getting more or less accurate?)
  - Top 5 worst underquotes with job numbers and dollar amounts
  - Confidence indicator: 10-25 jobs = "Low", 25-50 = "Medium", 50+ = "High"

This aggregate view answers "are our quotes accurate overall?" while System A answers "are our individual material rates current?"

### Labour Estimation (NOT in scope — informational only)
Labour duration feedback (comparing estimated hours to actual hours) is excluded from the core loop because:
- Not all trades log time (Isaac isn't in the system)
- Time logging accuracy is unreliable (bugs, forgotten clock-outs, travel time mixed in)
- Too many variables affect duration (weather, site access, soil conditions, crew experience)

If clean time data emerges naturally over 6+ months, the AI can surface loose observations like "patio jobs over 40m2 seem to average 3 days, not 2" — but these should be labelled as low-confidence observations, not pricing recommendations. No one should change labour rates based on this data without significant manual validation.

**API cost:** Claude Sonnet for PO line item matching = ~1K tokens per PO × 45 POs/month = ~$0.20/month. Price review UI = zero (database queries). Monthly aggregate report = ~$0.05/month. **Total: ~$0.25/month.**

**ROI:** At $1.4M revenue, materials are roughly 40% of job cost = $560K/year in material spend. If supplier prices drift 5% and you don't catch it, that's $28K/year in margin erosion. Plus, current pricing accuracy improvement from the aggregate loop = another $30-50K/year. **Conservative total: $50-70K/year in margin protection, growing as job volume increases.**

---

## PHASE 4: Event-Driven Intelligence — Real-Time Triggers (Week 3-4)

**What:** Instead of waiting for the daily digest to catch problems, trigger AI checks in real-time when key events happen. The system reacts, not just reports.

**Architecture:** Add a lightweight `ai-trigger` edge function (or add actions to ops-api) that runs specific checks when events occur.

### Trigger Map

| Event | Trigger Source | AI Check | Action |
|-------|---------------|----------|--------|
| Job status → 'accepted' | ops-api update_job_status | Is there a PO for this job? If not, start a 3-day countdown alert | Insert ai_alert if no PO after 3 days |
| PO created | ops-api create_po | Does total PO cost exceed quoted materials by >10%? | Insert amber ai_alert with financial impact |
| Job status → 'complete' | ops-api update_job_status | Has an invoice been created? Start 24-hour countdown | Insert red ai_alert if no invoice after 24 hours |
| Quote sent (quoted_at set) | ops-api update_job_status | Start 7-day follow-up countdown | Insert amber ai_alert if no status change after 7 days |
| Assignment created | ops-api create_assignment | Is crew marked unavailable on that date? | Insert red ai_alert immediately |
| Invoice overdue 14 days | Daily digest check | Escalation level | Insert/upgrade ai_alert severity |

### Implementation
Add these as lightweight checks at the end of existing ops-api actions. Not a separate function — just 5-10 lines appended to `update_job_status`, `create_po`, `create_assignment`.

Example for job → complete:
```typescript
// At end of updateJobStatus, after the main logic:
if (newStatus === 'complete') {
  // Schedule a check: is there an invoice within 24 hours?
  // For now, the daily-digest catches this. Future: pg_cron job-specific check.
  console.log(`[ops-api] Job ${jobId} completed — invoice check will run in daily digest`)
}
```

For the crew availability conflict (immediate):
```typescript
// In createAssignment, after insert:
if (data.scheduled_date) {
  const { data: avail } = await client.from('crew_availability')
    .select('status').eq('user_id', userId).eq('date', data.scheduled_date).maybeSingle()
  if (avail && avail.status !== 'available') {
    await client.from('ai_alerts').insert({
      org_id: DEFAULT_ORG_ID,
      job_id: jobId,
      alert_type: 'scheduling_conflict',
      severity: 'red',
      message: `Crew scheduled on ${data.scheduled_date} but marked as ${avail.status}`,
      recommended_action: 'Reassign or update crew availability',
    })
  }
}
```

**API cost:** Zero — these are database checks, no LLM calls.

**ROI:** Prevents scheduling conflicts (~$500/incident in wasted crew time), catches uninvoiced jobs within 24 hours instead of 3+ days, flags margin erosion at PO creation time instead of after job completion.

---

## PHASE 5: AI Chat Enhancements — Proactive Intelligence (Week 4-5)

**What:** Make the ops-ai chat genuinely useful as a daily tool, not just a novelty. The AI should feel like a business analyst who knows the company.

**Files:** `~/Projects/secureworks-site/supabase/functions/ops-ai/index.ts`

### 5a. Morning Brief Command
When Shaun types "morning brief" or "what should I focus on today?", the AI should:
1. Pull today's schedule (get_schedule)
2. Pull active ai_alerts (get_ai_alerts)
3. Pull jobs needing attention (get_attention_items)
4. Synthesize into a prioritized briefing

This already works via the tool-use loop — the system prompt tells it to do this. But test it and refine the prompt if the output isn't actionable enough.

### 5b. Natural Language Job Search
Make the search smarter. When Marnin says "show me the Henderson job" or "what's happening with the Smith patio", the AI should:
1. Search by client name, suburb, or job number
2. Pull full detail if one match
3. Auto-run profitability check on that job
4. Flag any alerts related to that job

### 5c. Conversational Forecasting
When Marnin asks "are we going to hit target this month?" or "what's the revenue forecast?":
1. Pull revenue_forecast tool
2. Pull current MTD from dashboard_summary
3. Calculate: $180K target - current MTD = gap, pipeline weighted value vs gap
4. Generate a specific answer: "You're at $112K with 12 days left. Pipeline has $89K weighted. You need to close 2 of the 4 pending quotes to hit target."

### 5d. SOP Generation
When anyone types "generate SOP for [process]", the AI:
1. Pulls actual job flow data via generate_sop tool
2. Generates a markdown SOP with steps, timing benchmarks, responsible person
3. Returns it in the chat for copy/paste

**API cost:** Each chat interaction = ~3-5K input tokens + 500-1K output tokens = ~$0.02-0.04 per interaction. At 20 interactions/day = ~$0.60/day = ~$18/month.

---

## PHASE 6: Self-Improving Feedback Loops (Month 2-3)

**What:** The system that makes itself smarter. This is the moat.

### 6a. Decision Logging
Every AI-suggested action that gets confirmed or rejected should be logged:
```sql
CREATE TABLE IF NOT EXISTS ai_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  decision_type text NOT NULL, -- 'schedule', 'pricing', 'alert', 'communication'
  ai_suggestion jsonb NOT NULL,
  human_action text, -- 'accepted', 'modified', 'rejected'
  human_modification jsonb, -- what they changed
  outcome_json jsonb, -- what actually happened (filled in later)
  created_at timestamptz DEFAULT now()
);
```

When the AI suggests scheduling a job and the user confirms → log it. When the AI flags a quote as stale and the user dismisses it → log it. Over time, this data shows which AI suggestions are useful and which are noise.

### 6b. Alert Quality Tracking
Track which alerts get dismissed without action vs which lead to action:
- If >50% of a specific alert type gets dismissed → reduce its severity or frequency
- If an alert type consistently leads to action → it's valuable, keep it
- Monthly report: "Your most acted-on alerts are 'uninvoiced jobs' (92% action rate). Your most dismissed are 'stale drafts' (34% action rate)."

### 6c. Correction of Error (COE) Pattern Detection
Monthly automated analysis (add to weekly pulse):
1. Pull all ai_decisions where human_action = 'modified' or 'rejected'
2. Group by decision_type
3. Identify patterns: "Schedule suggestions were modified 40% of the time — most modifications were crew changes, not date changes. Consider factoring crew preferences into scheduling suggestions."
4. Store the insight, surface it to Marnin

### 6d. Quote Accuracy Tracking Over Time
Add to the weekly/monthly reports:
- Rolling 90-day quote accuracy trend (are we getting better or worse?)
- Break down by salesperson (Nathan quotes patio jobs 5% more accurately than Khairo)
- Break down by job size band ($10-20K vs $20-40K vs $40K+)

**API cost:** Monthly COE analysis = ~5K tokens = ~$0.03. Decision logging = zero (database only).

**ROI:** This is where the compounding happens. Year 1 ROI is modest (~$20-30K from better pricing accuracy). Year 2+ accelerates as the data compounds. By job #2,000, the system should be quoting within 5% accuracy consistently.

---

## PHASE 7: MCP-Ready Architecture (Month 3+, but design NOW)

**What:** Don't build MCP servers now, but structure everything so MCP adoption is seamless later.

### Design Principles (follow these in all builds above):
1. **Every AI capability should be a callable function, not embedded logic.** The intelligence tools in ops-ai are already structured this way — each is a function that takes params and returns JSON. An MCP server would just expose these same functions.

2. **Data queries should be parameterized and documented.** Each tool's input_schema defines what it accepts. This maps directly to MCP tool definitions.

3. **Auth should be token-based, not session-based.** Edge functions already use service role keys. MCP servers will use the same pattern.

4. **Store AI outputs in structured tables, not just chat logs.** ai_alerts, weekly_reports, pricing_recommendations — all queryable by future MCP servers.

### Future MCP Architecture (don't build, just be aware):
```
Claude Desktop / AI IDE
  ├── Supabase MCP Server (already exists) → direct DB access
  ├── Xero MCP Server (already exists) → invoices, contacts, payments
  ├── GHL MCP Server (exists, expanding) → contacts, opportunities, conversations
  └── SecureWorks MCP Server (future) → exposes ops-ai tools as MCP tools
```

The SecureWorks MCP Server would literally be a thin wrapper around the existing ops-ai tool functions. The architecture is already MCP-compatible.

---

## COST MODEL

### Current Volume (45 jobs/month)

| Capability | Trigger | Calls/Month | Tokens/Call | Model | Monthly Cost |
|-----------|---------|------------|------------|-------|-------------|
| Daily digest narrative | Scheduled (daily) | 30 | 2.5K in, 300 out | Sonnet | $0.36 |
| Weekly pulse narrative | Scheduled (weekly) | 4 | 5K in, 500 out | Sonnet | $0.05 |
| Chat interactions | On-demand | 600 (20/day) | 4K in, 800 out | Sonnet | $11.64 |
| Monthly COE analysis | Scheduled (monthly) | 1 | 8K in, 1K out | Sonnet | $0.04 |
| Pricing recommendations | Scheduled (monthly) | 1 | 5K in, 500 out | Sonnet | $0.02 |
| **Total** | | | | | **~$12/month** |

### Target Volume (100 jobs/month)

| Capability | Calls/Month | Monthly Cost |
|-----------|------------|-------------|
| Daily digest | 30 | $0.50 |
| Weekly pulse | 4 | $0.08 |
| Chat interactions | 900 (30/day) | $17.46 |
| COE + pricing | 2 | $0.10 |
| **Total** | | **~$18/month** |

**Well under the $200/month budget.** Even at 10x the chat volume, you'd be at ~$120/month.

### Model Selection
- **Sonnet 4.6 for everything.** At $3/$15 per million tokens, it's 5x cheaper than Opus and fast enough for all these use cases.
- **Opus only if:** You add complex multi-step reasoning tasks like contract analysis or regulatory compliance checks. Not needed for current capabilities.
- **Haiku 4.5 for:** Alert rule evaluation if you move to real-time event triggers that fire hundreds of times per day. At $1/$5, it's 3x cheaper than Sonnet. Not needed yet.

---

## WHAT NOT TO BUILD

| Capability | Why Skip (for now) |
|-----------|-------------------|
| **AI Voice Agent** (Sameday AI) | External SaaS, $500/month. Evaluate separately — it's a buy decision, not a build decision. High ROI but independent of the intelligence layer. |
| **Photo-to-Estimate** (Handoff AI, CountBricks) | Requires training data you don't have in the right format. Your scope_json is the estimation engine. Focus on making scope_json more accurate via the closed loop, not replacing it with vision AI. Revisit when Handoff AI matures. |
| **Embedded Financing** (Wisetack) | Business decision, not a tech decision. Evaluate ROI separately. Doesn't interact with the AI layer. |
| **Computer Vision Progress Detection** | Needs consistent photo angles, lighting, framing. Your crew takes ad-hoc photos. The data quality isn't there. Revisit when you have a standardized photo capture process in Trade app. |
| **Multi-Agent Orchestration** (Claude Agent SDK, CrewAI) | Over-architected for current scale. Your single ops-ai function with 19 tools IS your agent. Adding orchestration frameworks adds complexity without proportional value at 45 jobs/month. Revisit at 200+ jobs/month. |
| **Digital Twin / Monte Carlo Simulation** | Not enough historical data for reliable simulation. Need 3+ years of clean financial data. You have ~1 year. Revisit mid-2027. |
| **Self-Evolving Meta-Agents** (ADAS, EvoAgentX) | Research-grade, not production-ready. The COE pattern detection in Phase 6 is the practical version of this. Build the feedback loops first, automate them later. |
| **SaaS Multi-Tenant** | Business model decision. Don't architect for multi-tenancy until you've validated demand. Current single-tenant architecture is correct for now. |

---

## RESEARCH COMPARISON — REALITY CHECK

| Brief Claim | Reality at SecureWorks Scale |
|------------|---------------------------|
| **AI voice agent: 391% conversion lift** | The 391% figure is from speed-to-lead research (responding in 1 minute vs industry average). Legitimate data point but assumes your current response time is poor. If Nathan already responds within 5 minutes, the lift is maybe 50-80%, not 391%. Still worth evaluating Sameday AI separately — but it's a $500/month external tool, not part of this build. |
| **Photo-to-estimate within $100 of manual** | Handoff AI's claim. Probably true for standardized residential (roofing, siding). Patios are more custom — attachment methods, roof styles, site conditions matter. Your scope tool with human input + closed-loop accuracy improvement will outperform generic photo estimation within 12 months. |
| **Embedded financing: 4.5x job size** | Wisetack data from across all home services. For patios specifically, the lift is likely 1.5-2x (clients add extras like lighting, fans, blinds when they can finance). Still significant but not 4.5x. Worth evaluating as a separate business decision. |
| **Voice-first field docs: 80% admin reduction** | Benetics AI claim. Plausible for companies drowning in paperwork. SecureWorks crew already use the Trade app with minimal typing. The admin reduction would be maybe 30-40% — still valuable but not transformational. Build voice-to-job-event as a Phase 7+ feature in Trade app. |
| **Predictive scheduling: 17% schedule reduction** | ALICE Technologies data from large commercial projects (hospitals, airports). For residential patio builds that take 1-3 days, scheduling optimization saves maybe 5-8% — one fewer wasted day per month. The crew availability + weather integration you already have captures most of this value. |
| **Autonomous procurement: 15% lower spend** | Zepth/Fairmarkit data from enterprise procurement. For 3 suppliers (CMI, Metroll, Bondor) in Perth, there's limited competition to exploit. The real value is in not forgetting to order, not in price optimization. The daily-digest "no PO raised" alert captures 80% of this value at zero cost. |
| **Computer vision progress: 230% task completion** | Buildots data from commercial construction with thousands of tasks. Residential patios have ~10 tasks. Vision AI adds marginal value here. Focus on the simple "crew marks stage complete" flow in Trade app. |
| **Multi-agent orchestration: $300-500K ROI** | At enterprise scale with 500+ employees. At 5-6 people, a single well-prompted AI agent (which you now have) delivers 90% of the value. The orchestration overhead isn't justified until you hit 20+ concurrent users of the AI system. |

---

## BUILD SEQUENCE SUMMARY

| Phase | What | When | API Cost | ROI |
|-------|------|------|----------|-----|
| 1 | Run SQL + set API key | Today | $0 | Enables everything |
| 2 | Wire alerts into dashboards + schedule digest | Week 1 | $0.40/mo | $30-50K/yr protected |
| 3 | Supplier price intelligence + quote accuracy | Week 2-3 | $0.25/mo | $50-70K/yr margin protection |
| 4 | Event-driven triggers (real-time alerts) | Week 3-4 | $0 | $15-25K/yr prevented waste |
| 5 | AI chat refinement + morning brief | Week 4-5 | $12-18/mo | Operational efficiency |
| 6 | Self-improving feedback loops | Month 2-3 | $0.10/mo | Compounding (unmeasurable) |
| 7 | MCP-ready architecture | Ongoing | $0 | Future-proofing |

**Total monthly API cost at full build: ~$15-20/month.**
**Total estimated ROI: $115-145K/year in protected margin + prevented waste.**
**The closed-loop estimating moat compounds indefinitely.**

---

## FILES REFERENCE

| File | What |
|------|------|
| `~/Projects/secureworks-site/supabase/functions/ops-ai/index.ts` | AI chat with 19 tools (deployed) |
| `~/Projects/secureworks-site/supabase/functions/daily-digest/index.ts` | 15 alert rules + AI narrative + weekly pulse (deployed) |
| `~/Projects/secureworks-site/supabase/functions/ops-api/index.ts` | Ops backend — add event triggers here |
| `~/Projects/securedash-temp/ops.html` | Ops dashboard — add alerts panel here |
| `~/Projects/securedash-temp/ceo.html` | CEO dashboard — add alerts + pricing accuracy here |
| `~/Projects/secureworks-site/supabase/migrations/` | All SQL migrations |
