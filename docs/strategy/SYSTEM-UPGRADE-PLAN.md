# SecureWorks System Upgrade Plan

**Version:** 1.0 — 9 March 2026
**Authors:** Marnin Stobbe + [Friend's name]
**Status:** Draft — ready for review and editing
**Context:** This plan synthesises two rounds of deep research (23 sources across JobTread, Fergus, ServiceTitan, CompanyCam, Paidnice, GHL MCP, and construction AI trends) into a buildable architecture for the existing GHL → Supabase → Xero custom stack.

---

## How This System Compounds

This isn't a feature list — it's three interlocking flywheels where each layer creates the data the next layer needs. Build out of order and you waste time. Build in sequence and each phase pays for itself.

```
FLYWHEEL 1: COST & MARGIN
Fix Data → PO Workflow → Per-Job P&L → Predictive Estimating

FLYWHEEL 2: CASH FLOW
Photo AI → Auto-Complete → Same-Day Invoice → AR Automation

FLYWHEEL 3: REVENUE
Clean Addresses → Cross-Sell Triggers → Neighbourhood Marketing → Voice Agent
```

---

## Current System (What Exists)

### Stack
- **Frontend:** Vanilla HTML/JS dashboards — CEO (`dashboard/index.html`), Ops (`dashboard/ops.html`), Trade (`dashboard/trade.html`), Sales (`dashboard/sales.html` — Phase 4)
- **Backend:** Supabase Edge Functions (Deno/TypeScript) — 9 functions
- **Database:** Supabase Postgres (15 migrations, RLS enabled)
- **CRM:** GoHighLevel — sales + execution pipelines, contacts, opportunities
- **Accounting:** Xero — invoices, P&L, projects, contacts, POs
- **Scoping Tools:** Patio + Fencing tools on GitHub Pages
- **AI:** ops-ai edge function (Claude claude-sonnet-4-6 with tool_use, CEO + Ops views)

### What Works
- Job number generation (SWP/SWF/SWD-25XXX)
- GHL ↔ Supabase sync (sales + execution pipelines)
- Xero contact matching (65% match rate, was 22%)
- Invoice sync with auto-reference matching (316 linked)
- Xero Projects matched (108/171 — real per-job P&L data)
- P&L reports by business unit
- Google Ads ingest and marketing metrics
- CEO/Ops/Trade dashboards all functional
- Trade app: PWA, receipts, GPS check-in, signatures, service reports

### Critical Data Gaps (MUST FIX FIRST)
| Gap | Current State | Impact |
|-----|--------------|--------|
| `site_address` | NULL on 100% of jobs | Nav buttons, suburb labels, neighbourhood marketing — all broken |
| `scope_json` | Empty on all jobs | Can't auto-generate POs, can't do itemised invoicing |
| `pricing_json` | Totals only (no line items) | Xero invoices are single-line, can't track cost categories |
| `INITIAL_SESSION` bug | `cloud.js` only handles `SIGNED_IN` | Login unreliable on all dashboards |
| Channel attribution | Mostly "Unknown" | Can't track marketing ROI per channel |

### Architecture Debt
| Issue | Risk | Fix |
|-------|------|-----|
| `ops-api` at 2,100 lines | Single point of failure, hard to maintain | Break into modular functions |
| No audit trail | Can't track who changed what | Database triggers for change logging |
| RLS blocks all client queries | Everything routes through edge functions | By design, but adds latency |

---

## Phase 1: Plug the Bleed (Weeks 1-4)

**Goal:** Fix broken data, start collecting cash, enforce same-day invoicing.
**ROI:** Immediate cash flow improvement + data foundation for everything else.

### Week 1: Data Integrity + AR Automation

#### 1.1 Fix INITIAL_SESSION Bug [FIX]
**File:** `tools/shared/cloud.js`
**Change:** `onAuthStateChange` callback must handle `INITIAL_SESSION` event, not just `SIGNED_IN`.
```
// Current (broken):
onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN') { ... }
})

// Fixed:
onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') { ... }
})
```
**Test:** Open each dashboard in incognito → magic link login → confirm session persists on refresh.

#### 1.2 Fix site_address Sync [FIX]
**Where:** GHL webhook handler (`supabase/functions/ghl-webhook/`) and/or `ghl-proxy` sync logic.
**Change:** When creating/updating jobs from GHL opportunity data, map address fields:
```sql
-- Jobs table already has site_address column
UPDATE jobs SET
  site_address = ghl_opportunity.contact.address,
  site_suburb = ghl_opportunity.contact.city
WHERE ghl_opportunity_id = $1;
```
**Backfill:** Write a one-off edge function that iterates all jobs with NULL site_address, fetches the GHL contact via API, and writes the address. Use pagination (1000-row limit).

#### 1.3 Connect Paidnice [BUY — $39/mo]
**What:** Paidnice plugs directly into Xero. No custom code needed.
**Setup:**
1. Sign up at paidnice.com → connect Xero account
2. Configure escalation sequence:
   - 3 days before due: friendly email reminder
   - Due date: email + SMS with payment link
   - 3 days overdue: firmer email + SMS
   - 7 days overdue: statement + late fee warning
   - 14 days overdue: auto-apply late fee ($50 or 2%)
   - 21 days overdue: final notice before collections
3. Enable customer portal (branded, one-click payment)
4. Set up Stripe or Pinch Payments for card processing

**Expected results:** DSO from 28 → ~17 days. 90+ AR from $19K → <$10K within 2 months. Users report recovering $90K in unpaid invoices within 2 months.

### Week 2: Scope & Pricing Line Items

#### 2.1 Fix scope_json Population [FIX]
**Where:** Scoping tools (`~/Projects/patio-tool/index.html`, `decking.html`, fence-designer)
**Change:** When scope is saved via `cloud.js` → `ghl-proxy` → `save_scope` action, ensure `scope_json` includes full line items:
```json
{
  "items": [
    {
      "category": "roofing",
      "description": "SolarSpan 75mm Surfmist",
      "quantity": 24,
      "unit": "m²",
      "unit_cost": 180,
      "total": 4320,
      "supplier": "Bondor"
    },
    {
      "category": "steel",
      "description": "100x100 SHS posts x 2.7m",
      "quantity": 6,
      "unit": "ea",
      "unit_cost": 95,
      "total": 570,
      "supplier": "CMI"
    }
  ],
  "totals": {
    "materials": 12400,
    "labour": 4800,
    "margin": 3200,
    "total_ex_gst": 20400,
    "total_inc_gst": 22440
  }
}
```

#### 2.2 Fix pricing_json Line Items [FIX]
**Where:** Same scoping tools, `save_scope` / `link` action in `ghl-proxy`.
**Change:** `pricing_json` must mirror the line items, not just totals. This enables itemised Xero invoices later.

#### 2.3 Auto-Create Xero Project on Job Win [BUILD]
**Where:** `ghl-proxy` → `link` action (runs when scope is completed).
**New step in the `link` flow:**
1. ✅ Move GHL stage
2. ✅ Add GHL note
3. ✅ Generate job number (next_job_number())
4. ✅ Create Xero contact
5. ✅ Push $ to GHL
6. **NEW:** `POST /api.xro/2.0/projects` → create Xero Project with job number as name
7. **NEW:** Store `xero_project_id` on the jobs table

```sql
ALTER TABLE jobs ADD COLUMN xero_project_id TEXT;
```

### Week 3: Stage Duration Tracking

#### 3.1 Create job_stage_history Table [BUILD]
```sql
CREATE TABLE job_stage_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  stage_name TEXT NOT NULL,
  entered_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  exited_at TIMESTAMPTZ,
  duration_hours NUMERIC GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (COALESCE(exited_at, now()) - entered_at)) / 3600
  ) STORED,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001'
);

CREATE INDEX idx_stage_history_job ON job_stage_history(job_id);
CREATE INDEX idx_stage_history_stage ON job_stage_history(stage_name);
```

#### 3.2 Log Stage Changes [BUILD]
**Where:** `ghl-proxy` sync logic — wherever job status is updated.
**Logic:** On every status change:
1. Close previous stage: `UPDATE job_stage_history SET exited_at = now() WHERE job_id = $1 AND exited_at IS NULL`
2. Open new stage: `INSERT INTO job_stage_history (job_id, stage_name) VALUES ($1, $2)`

#### 3.3 Stage Duration Targets [BUILD]
```sql
INSERT INTO org_config (org_id, key, value) VALUES
('00000000-0000-0000-0000-000000000001', 'stage_targets', '{
  "quoted_to_accepted": 7,
  "accepted_to_materials_ordered": 2,
  "materials_ordered_to_received": 5,
  "scheduled_to_installed": 14,
  "completed_to_invoiced": 0.5,
  "invoiced_to_paid": 14
}');
```

#### 3.4 Dashboard: Bottleneck Alerts [BUILD]
**Where:** Ops dashboard (`dashboard/ops.html`)
**Display:** Red-flag jobs exceeding target days per stage. Show as attention items in the Daily Huddle view.

### Week 4: Same-Day Invoicing Engine

#### 4.1 Auto-Invoice on Completion [BUILD]
**Trigger:** When job status changes to `complete` in GHL → webhook → edge function.
**New edge function action** in `ops-api` (or new dedicated function):

```
action: 'complete_and_invoice'
1. Mark job complete in Supabase
2. Close stage duration entry
3. Read pricing_json line items
4. POST /api.xro/2.0/Invoices → create itemised ACCREC invoice
   - Tag with xero_project_id (from Week 2)
   - Set DueDate = today + 14 days
   - Include payment link (Paidnice portal URL)
5. Update jobs.status = 'invoiced'
6. Send SMS to customer via GHL API: "Your project is complete! Invoice sent to your email."
```

**Note:** `ops-api` already has a `complete_and_invoice` action stub — flesh it out with real Xero API calls using the itemised pricing_json.

---

## Phase 2: Cost Control (Weeks 5-8)

**Goal:** Stop margin leakage through automated purchasing and live cost tracking.
**ROI:** $50K-$100K/year in material savings + $275K/year in margin leak prevention.

### Week 5: Material BOM & PO Auto-Generation

#### 5.1 Extend Suppliers Table [BUILD]
The `suppliers` table already exists (synced from Xero). Add mapping fields:
```sql
ALTER TABLE suppliers ADD COLUMN material_categories TEXT[];
-- e.g. ['roofing', 'insulation'] for Bondor, ['steel', 'fabrication'] for CMI
```

#### 5.2 Auto-Generate POs from scope_json [BUILD]
**New action in ops-api:** `scope_to_po`
**Logic:**
1. Read `scope_json.items` for the job
2. Group items by `supplier`
3. For each supplier group:
   - Create `purchase_orders` row in Supabase (PO number from `po_number_seq`)
   - POST to Xero API: `POST /api.xro/2.0/PurchaseOrders`
   - Tag with `xero_project_id`
   - Link PO back to job
4. Update job with `materials_status = 'ordered'`

**Note:** `ops-api` already has a `scope_to_po` action stub.

#### 5.3 PO Approval Threshold [BUILD]
```sql
INSERT INTO org_config (org_id, key, value) VALUES
('00000000-0000-0000-0000-000000000001', 'po_approval_threshold', '5000');
```
POs over $5,000 require CEO approval (flag in dashboard, don't auto-send to Xero).

### Week 6: Materials Readiness Gate

#### 6.1 Materials Status on Jobs [BUILD]
```sql
ALTER TABLE jobs ADD COLUMN materials_status TEXT DEFAULT 'not_ordered'
  CHECK (materials_status IN ('not_ordered', 'ordered', 'partial', 'received', 'n/a'));
```

#### 6.2 Two-Way PO Sync [BUILD]
**Where:** `xero-sync` → `sync_purchase_orders` action (already runs every 30 min).
**Enhancement:** When a PO status changes in Xero to "BILLED" or a custom "RECEIVED" status:
1. Update `purchase_orders.status` in Supabase
2. Check if ALL POs for the job are received
3. If yes → `UPDATE jobs SET materials_status = 'received'`
4. If partial → `UPDATE jobs SET materials_status = 'partial'`

#### 6.3 Scheduling Gate [BUILD]
**Where:** `ops-api` → scheduling logic.
**Rule:** When creating a `job_assignment` (scheduling a job), check:
```
IF job.materials_status NOT IN ('received', 'n/a')
  THEN return error: "Cannot schedule — materials not yet received"
```
**UI:** Ops dashboard shows warning icon on jobs where materials aren't ready. Allow manual override with confirmation ("Schedule anyway — materials not confirmed").

### Week 7: Per-Job P&L Dashboard

#### 7.1 Enhanced Xero Projects Sync [BUILD]
**Where:** `xero-sync` → `sync_projects` (already runs daily at 4am UTC).
**Enhancement:** Pull detailed project financials:
```
GET /api.xro/2.0/projects/{projectId}
→ totalInvoiced, totalExpense, estimate, status
```
Store in `xero_projects` table with breakdown fields.

#### 7.2 Per-Job Profitability View [BUILD]
**Where:** CEO dashboard (`dashboard/index.html`)
**New section or tab:** Job Profitability

| Column | Source |
|--------|--------|
| Job # | jobs.job_number |
| Client | jobs.client_name |
| Quoted | pricing_json.totals.total_ex_gst |
| Material POs | SUM(purchase_orders.amount) for job |
| Xero Expenses | xero_projects.totalExpense |
| Invoiced | xero_projects.totalInvoiced |
| Projected Margin | (Quoted - Expenses) / Quoted × 100 |
| Status | 🟢 on track / 🟡 watch / 🔴 over budget |

**Variance alert:** If (Expenses / Quoted) > 0.85 → flag as 🔴 on CEO dashboard.

#### 7.3 Reporting API Enhancement [BUILD]
**Where:** `reporting-api` → new action `job_profitability_detail`
**Returns:** Array of jobs with quoted, PO totals, Xero project financials, calculated margins.

### Week 8: Daily Huddle + Weekly Scorecard

#### 8.1 Daily Huddle — Default Ops View [BUILD]
**Where:** `dashboard/ops.html` — make this the default tab/view Shaun sees.

**Layout:**
```
┌─────────────────────────────────────────────┐
│ TODAY: [date]                               │
├─────────────────┬───────────────────────────┤
│ YESTERDAY        │ TODAY                     │
│ 3 jobs completed │ 4 jobs scheduled          │
│ $24,500 invoiced │ Crew A: Smith patio       │
│ 2 payments recv  │ Crew B: Jones fence       │
│                  │ Crew C: Park deck         │
│                  │ Unassigned: 1 job         │
├─────────────────┴───────────────────────────┤
│ ⚠️  ATTENTION ITEMS                         │
│ • SWP-25043: 12 days in "accepted" (target 7)│
│ • SWF-25061: Materials not received (sched  │
│   for Thursday)                              │
│ • 3 invoices 30+ days overdue ($11,178)     │
│ • SWP-25038: 18% over material budget       │
└─────────────────────────────────────────────┘
```

#### 8.2 Weekly Scorecard [BUILD]
**Where:** CEO dashboard — new tab or section.

| Metric | This Week | Last Week | Target | Status |
|--------|-----------|-----------|--------|--------|
| Leads | 12 | 15 | 15+ | 🟡 |
| Quotes sent | 6 | 8 | 8+ | 🔴 |
| Quotes accepted | 4 | 3 | 4+ | 🟢 |
| Jobs scheduled | 5 | 4 | 4+ | 🟢 |
| Jobs completed | 3 | 4 | 4+ | 🟡 |
| Revenue invoiced | $28K | $25K | $25K+ | 🟢 |
| Revenue collected | $22K | $18K | $20K+ | 🟢 |
| AR 30+ days | $22K | $24K | <$20K | 🟡 |
| Avg job value | $9.2K | $8.1K | $8K+ | 🟢 |
| DSO | 19 | 22 | <30 | 🟢 |

**EOS 2-week rule:** If any metric shows 🔴 for 2 consecutive weeks → automatically add to an "IDS Issues" list that surfaces in the weekly L10 meeting view.

```sql
CREATE TABLE scorecard_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  week_start DATE NOT NULL,
  metric_name TEXT NOT NULL,
  value NUMERIC,
  target NUMERIC,
  on_track BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, week_start, metric_name)
);

CREATE TABLE ids_issues (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  title TEXT NOT NULL,
  source TEXT, -- 'scorecard', 'stage_duration', 'manual'
  source_metric TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

---

## Phase 3: AI Multipliers (Weeks 9-12)

**Goal:** Leverage clean data to generate new revenue and automate field workflows.
**ROI:** 10-15% revenue increase + operational efficiency gains.

### Week 9: Cross-Sell Automation

#### 9.1 Cross-Sell Fields on Forms [BUILD]
**Where:** Trade app completion form + scoping tool.
**Add fields:**
- Scope form: "What else could this customer use?" (dropdown multi-select: fencing, decking, screening, lighting, outdoor kitchen)
- Completion form: "Additional opportunities spotted on site" (same dropdown)

**Store in:** `jobs.cross_sell_json`
```sql
ALTER TABLE jobs ADD COLUMN cross_sell_json JSONB DEFAULT '{}';
-- e.g. {"scope_opportunities": ["fencing", "lighting"], "completion_opportunities": ["decking"]}
```

#### 9.2 Service Gap Detection [BUILD]
**New reporting-api action:** `cross_sell_opportunities`
**Logic:** Query contact_matches → find customers with only one division:
```sql
SELECT cm.client_name, cm.ghl_contact_id,
  array_agg(DISTINCT j.type) as services_used,
  CASE
    WHEN NOT 'fencing' = ANY(array_agg(j.type)) THEN 'fencing'
    WHEN NOT 'patio' = ANY(array_agg(j.type)) THEN 'patio'
    WHEN NOT 'decking' = ANY(array_agg(j.type)) THEN 'decking'
  END as missing_service
FROM contact_matches cm
JOIN jobs j ON j.ghl_contact_id = cm.ghl_contact_id
WHERE j.status IN ('complete', 'invoiced')
GROUP BY cm.client_name, cm.ghl_contact_id
HAVING COUNT(DISTINCT j.type) < 3;
```

#### 9.3 GHL Workflow Triggers [BUILD]
**Where:** GHL workflow builder (no code — configure in GHL UI).
**Triggers:**
1. Job completed + 6 months → SMS: "It's been 6 months since your [patio]. Time to think about [fencing/decking]?"
2. Cross-sell field populated → create new GHL opportunity in relevant pipeline
3. Job completed → SMS to customer asking for Google review (wait until invoice paid)

### Week 10: GHL MCP Server Integration

#### 10.1 Generate Private Integration Token [BUY/BUILD]
**Where:** GHL Settings → Private Integrations → Create new.
**Scopes needed:**
- contacts.readonly, contacts.write
- conversations.readonly, conversations.write
- opportunities.readonly, opportunities.write
- calendars.readonly
- payments.readonly

**MCP endpoint:** `https://services.leadconnectorhq.com/mcp/`
**Config:**
```json
{
  "url": "https://services.leadconnectorhq.com/mcp/",
  "headers": {
    "Authorization": "Bearer pit-XXXXX",
    "locationId": "YOUR_LOCATION_ID"
  }
}
```

#### 10.2 Connect to AI Assistant [BUILD]
**Where:** `ops-ai` edge function — add MCP tools alongside existing Supabase tools.
**Capability:** AI can now directly read/write GHL contacts, conversations, pipeline stages, calendar events — without routing through `ghl-proxy` for many operations.

**Use cases:**
- "Show me all stuck deals" → AI queries GHL pipeline via MCP
- "Send John a follow-up" → AI sends SMS via MCP conversations endpoint
- "Book a site visit for Friday" → AI creates calendar event via MCP

### Week 11: Neighbourhood Marketing + Customer Timeline

#### 11.1 Neighbourhood Marketing Agent [BUILD]
**Trigger:** Job status → "complete" AND site_address is populated.
**Logic:**
1. Query Supabase: find all contacts within same suburb or street
2. Filter to leads (not existing customers)
3. Draft personalised SMS: "We just completed a [patio/fence] on [Street Name]. Would you like a free quote for your property?"
4. Send via GHL MCP `conversations_send-a-new-message` or GHL API
5. Log in `webhook_log` for audit

#### 11.2 Customer Project Timeline [BUILD]
**What:** Shareable link showing project progress photos + milestones.
**Where:** New lightweight HTML page (similar to service report share links).
**URL pattern:** `/dashboard/timeline.html?token={share_token}`
**Data:** Pull from `job_media` (scope/in_progress/completion phases) + `job_stage_history` timestamps.
**Share:** Auto-text timeline link to customer when first in_progress photo is uploaded.

### Week 12: Technical Debt + Audit Trail

#### 12.1 Break Up ops-api [FIX]
**Current:** 2,100 lines handling ops + trade + AI/automation endpoints.
**Target:** Split into logical modules:
- `ops-api` → scheduling, POs, WOs, pipeline views
- `trade-api` → my_jobs, upload_photo, service_report, GPS check-in
- Keep shared Supabase client helper as imported module

**Risk:** Coordinate deploy carefully — both old and new functions must be deployed, and dashboard code updated to point to new endpoints.

#### 12.2 Audit Trail [BUILD]
```sql
CREATE TABLE audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  user_id UUID,
  user_email TEXT,
  action TEXT NOT NULL, -- 'update_job', 'create_po', 'move_stage', etc.
  entity_type TEXT NOT NULL, -- 'job', 'purchase_order', 'assignment', etc.
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_date ON audit_log(created_at);
```

**Implementation:** Add audit logging to every write operation in edge functions. Log the before/after state.

---

## Claude — The Intelligence Layer

### The Big Idea

Claude isn't a chatbot sitting in the corner of each dashboard. It's the **nervous system** running through the entire operation — reading call transcripts, analysing photos, detecting patterns, pushing actions, and learning from every job.

The data flows through GHL, Supabase, and Xero. Claude sits on top of ALL of it and makes it smart.

### What Already Exists
- `ops-ai` edge function — deployed, uses Claude claude-sonnet-4-6 with `tool_use`
- **CEO view** (7 tools) — revenue, pipeline, customers, marketing
- **Ops view** (9 tools) — scheduling, jobs, POs, crew, stage tracking
- `morning_brief` action already built — AI generates daily summary

### The Data Claude Can Read

```
GHL Call Recordings → Transcripts → Claude reads every conversation
GHL SMS/Email → Conversation history → Claude reads all comms
Supabase Jobs → scope_json, pricing_json, stage_history → Claude sees the full lifecycle
Xero → Invoices, POs, P&L → Claude sees the money
Job Photos → Completion images → Claude verifies quality
Weather API → 7-day forecast → Claude factors into scheduling
Time Entries → Labour hours → Claude calculates real costs
```

**This is what makes it genuinely different from any off-the-shelf tool.** ServiceTitan has AI. Fergus has AI. But none of them can read YOUR call recordings, cross-reference with YOUR Xero data, and proactively push actions into YOUR GHL pipeline.

### Call Transcript Intelligence (Game-Changer)

GHL already records calls and generates transcripts. Claude can process every single one.

**How it works:**
1. Customer calls → GHL records + transcribes
2. Webhook fires to Supabase edge function with transcript
3. Claude analyses the transcript and extracts:

```
┌─────────────────────────────────────────────────┐
│  CALL ANALYSIS — Williams, 14 Mar 10:23 AM      │
│                                                  │
│  Intent:        New patio enquiry                │
│  Hot/Warm/Cold: HOT — wants to start before      │
│                 winter, mentioned budget $15-20K  │
│  Property:      4 bed, established, Joondalup    │
│  Scope clues:   "L-shaped around the pool",      │
│                 "maybe insulated", "hate the rain │
│                 noise on our current tin roof"    │
│  Objections:    Concerned about council approval  │
│                 timeframe                         │
│  Cross-sell:    Mentioned "the fence is falling   │
│                 down too" — FLAG for fencing quote│
│  Action:        Site visit booked Fri 14 Mar 2pm  │
│  Sentiment:     Positive, engaged, ready to move  │
│                                                  │
│  → Auto-created GHL note with summary            │
│  → Auto-tagged: hot_lead, cross_sell_fencing     │
│  → Auto-populated scope hints for assessor       │
└─────────────────────────────────────────────────┘
```

4. Claude pushes actions:
   - Creates structured note on GHL contact (assessor reads before site visit)
   - Tags opportunity with `hot_lead` and `cross_sell_fencing`
   - Pre-populates scope hints so assessor knows what to look for
   - Flags to CEO dashboard: "Hot lead with cross-sell potential"

**Edge function:** `call-analysis` (new)
```
Trigger: GHL webhook on call recording complete
1. Fetch transcript from GHL API
2. Send to Claude with analysis prompt
3. Extract: intent, temperature, scope clues, objections, cross-sell signals, sentiment
4. Write structured summary to job_events table
5. Update GHL contact notes via API
6. Tag opportunity with extracted signals
7. If cross-sell detected → create flag in Supabase for CEO dashboard
```

```sql
CREATE TABLE call_analyses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  ghl_contact_id TEXT,
  ghl_call_id TEXT,
  transcript TEXT,
  analysis JSONB NOT NULL, -- {intent, temperature, scope_clues, objections, cross_sell, sentiment, summary}
  actions_taken JSONB, -- what Claude auto-did: notes created, tags added, etc.
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_call_analyses_contact ON call_analyses(ghl_contact_id);
CREATE INDEX idx_call_analyses_job ON call_analyses(job_id);
```

### How Claude Works In Each View

#### CEO Dashboard — Strategic Intelligence
**Prompt focus:** Financial health, trends, decisions, people performance.
**Tools:** reporting-api + call_analyses + scorecard_history + cross_sell data

**What Claude does proactively (not just when asked):**
- Morning digest pushed to dashboard: "3 hot leads overnight, Williams has cross-sell potential, AR reduced by $4K yesterday"
- Weekly scorecard commentary: "Quotes sent dropped 25% this week — check if assessor is overloaded"
- Margin alerts: "SWP-25043 is 18% over material budget — here's why from the PO data"

**What you can ask:**
- "Why did we lose the Henderson quote?" → reads call transcripts + stage duration + price comparison
- "Which salespeople are converting best this month?" → win rate by assigned user
- "What's the real margin on patios vs fencing?" → aggregates Xero Projects data by job type
- "Show me all the cross-sell opportunities from this week's calls" → queries call_analyses
- "Are we on track for Q2?" → pipeline weighted forecast + conversion trend

#### Ops Dashboard — Operational Intelligence
**Prompt focus:** What needs doing, what's blocked, what's coming, who needs what.
**Tools:** ops-api + weather + stage_history + materials_status

**What Claude does proactively:**
- Morning brief (already built): today's jobs, blocked items, materials status, weather warnings
- Stage alerts: "3 jobs stuck in 'accepted' for >7 days — might need a scheduling push"
- Weather-aware: "Rain Thursday — the Park deck pour should move to Friday, Jones fence is fine under cover"

**What Shaun can ask:**
- "Can I schedule Williams for next week?" → checks materials_status + crew availability + weather
- "What's blocking the most jobs right now?" → analyses stage durations, groups by blocker type
- "Give me Thursday's crew plan" → assignments + materials readiness + weather
- "Which POs are we still waiting on?" → cross-references Xero PO status

#### Trade App — Invisible AI (No Chatbot)
**Design rule:** No chat interface. Trades don't want it. AI works invisibly.

**Where Claude helps without the trade knowing:**
1. **Voice-to-notes** (already built) — trade speaks, text appears, Claude cleans up grammar/clarity
2. **Auto-draft completion report** — trade uploads 5 photos, Claude analyses them and pre-fills the service report checklist. Trade just reviews and signs. Saves 10 min per job.
3. **Smart timer reminders** — if a trade hasn't started their timer by 7:30 AM on a scheduled day, push notification: "Don't forget to start your timer for the Smith patio"

**What Claude does NOT do on trade app:**
- No chatbot
- No popup suggestions
- No "AI insights" cards
- Nothing that adds friction or drains battery

#### Sales — Claude in GHL (Not a Separate Dashboard)

> **SecureSale dashboard is on the backburner.** When scaling to a Jim's-style franchise model, a dedicated sales platform makes sense. For now, keep salespeople in GHL and let Claude add value there.

**What Claude does for sales (via GHL + Supabase, no separate dashboard):**

1. **Call transcript → pre-visit brief:** Before the assessor drives to a site visit, Claude has already summarised the customer's call — what they want, their budget signals, objections to address, and cross-sell opportunities. Pushed as a GHL contact note.

2. **Post-scope margin check:** When a quote is saved via scoping tool, Claude runs the numbers and flags to the CEO: "Williams quote is at 22% margin — below 30% target. Materials are $X, suggest adjusting labour rate."

3. **Follow-up nudges via GHL workflow:** Claude analyses stage duration data and triggers GHL workflows:
   - Scoped >3 days, no quote sent → GHL task created for salesperson
   - Quote sent >7 days, no response → GHL auto-SMS to customer: "Hi [Name], just checking in on your patio quote..."
   - These are GHL workflows, not custom code — just configured with the right triggers from Supabase data

4. **Win/loss learning:** When a quote is lost, Claude reads the last call transcript and any notes to understand why. Aggregates patterns over time:
   - "Fencing quotes lost 40% of the time due to price — competitors are $15/m cheaper"
   - "Patio quotes won 65% when insulation benefits were discussed on the call"
   - This feeds into the CEO dashboard as sales intelligence

**For the Jim's-style future (Phase 5+):**
When you have multiple sales teams and want to franchise the model, SecureSale becomes a dedicated dashboard with personal pipelines, leaderboards, AI coaching, and margin trackers. The data architecture built in Phases 1-3 supports this — no rework needed.

### The Claude Data Flywheel

```
More calls recorded → more transcripts → Claude gets smarter about your customers
More jobs completed → more scope vs actual data → Claude improves margin predictions
More time entries → better labour cost estimates → Claude quotes more accurately
More photos analysed → better quality checklists → Claude auto-verifies faster
More cross-sells detected → more revenue → more data → smarter cross-sells

Every job makes the system more intelligent.
The competitors using spreadsheets can't catch up.
```

### Implementation Sequence for Claude

| When | What | Effort |
|------|------|--------|
| **Already done** | ops-ai with CEO (7 tools) + Ops (9 tools) views | Done |
| **Already done** | morning_brief action | Done |
| **Phase 2 (Week 7-8)** | Add per-job P&L tools + scorecard tools to ops-ai | Low — new tool definitions pointing at new reporting-api actions |
| **Phase 2 (Week 8)** | Add weather-aware scheduling tools | Low — read from cached weather data |
| **Phase 3 (Week 9)** | Add cross-sell detection tools | Medium — new queries against job + contact data |
| **Phase 3 (Week 10)** | Connect GHL MCP → Claude can read/write GHL directly | Medium — MCP server config + new tools |
| **Phase 3 (Week 11)** | Call transcript analysis edge function | Medium — new function, Claude prompt engineering, GHL webhook |
| **Phase 3 (Week 11)** | AI auto-draft completion reports from photos | Medium — Claude vision API on uploaded photos |
| **Phase 4+** | Win/loss pattern analysis | Low — reads from call_analyses table |
| **Phase 5+** | SecureSale dashboard with AI sales coach | High — new dashboard build |

---

## Bonus Features (Woven Into Phases)

These features stack on top of the core phases and should be built alongside them — they're low-effort, high-impact additions that make the whole system feel polished and professional.

### B1. BOM Weather Forecast on Dashboard + Trade App [BUILD — Phase 2]

**API:** Open-Meteo BOM API (free, no auth, no rate limits for non-commercial)
**Endpoint:**
```
https://api.open-meteo.com/v1/forecast?latitude=-31.95&longitude=115.86&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,weathercode&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=Australia%2FPerth
```

**Where it shows up:**

1. **Ops Dashboard — Daily Huddle view (Week 8):**
   - 7-day forecast strip at the top of the Today view
   - Rain probability > 60% on a scheduled day → amber warning icon next to that job
   - Shaun sees at a glance: "Thursday has 80% rain — the Jones deck pour is scheduled"
   - Link to action: "Reschedule" button pre-fills move to next dry day

2. **Trade App — My Jobs tab:**
   - Today's weather summary at top: temp, wind, rain chance
   - Per-job weather badge if rain is likely during their scheduled window
   - Outdoor jobs (patios, fencing, decking) get weather alerts; indoor jobs (renos) don't

3. **Predictive scheduling (Phase 4+):**
   - Once you have weather + crew + materials data, AI can auto-suggest optimal scheduling
   - Rain forecast → auto-suggest rescheduling outdoor jobs → text customers

**Implementation:** Single fetch call cached in Supabase (pg_cron every 6 hours → store in `org_config` key `weather_forecast_7day`). All dashboards read from cache, not the API directly.

```sql
-- Add to pg_cron (via edge function or direct)
-- Fetch every 6 hours, store JSON response
INSERT INTO org_config (org_id, key, value) VALUES
('00000000-0000-0000-0000-000000000001', 'weather_forecast_7day', '{}');
```

### B2. Customer "On My Way" SMS Portal [BUILD — Phase 2, Week 6]

**What:** When a tradesperson starts heading to a job, customer gets an automated text with a live ETA-style message and a link to a mini-portal.

**Flow:**
1. Tradesperson opens job in trade app → taps "On My Way" button
2. System sends SMS to customer via GHL API:
   > "Hi [Name]! Your SecureWorks installer [Crew Name] is on the way to [Address]. Expected arrival: ~[Time]. Track progress: [link]"
3. Link goes to a lightweight public page: `/dashboard/customer.html?token={share_token}`

**Customer Portal Page shows:**
- Status: "Installer en route" / "Work in progress" / "Complete"
- Installer name + photo (optional)
- Estimated arrival (based on `started_at` timestamp + average travel time, or just "within 30 minutes")
- Live photo feed once work starts (from `job_media` in_progress photos)
- Contact button (calls the office, not the tradesperson's personal number)

**Trade App UI:**
```
┌──────────────────────────────┐
│ 📍 Smith Patio — SWP-25043  │
│ 14 Elm St, Joondalup         │
│                              │
│  [ 🚗 On My Way ]           │  ← taps this, SMS fires
│  [ ▶️ Start Job  ]           │  ← starts timer
│  [ ⏹️ End Job    ]           │  ← stops timer
│                              │
│  Today: 34°C ☀️  Wind: 12km/h│
└──────────────────────────────┘
```

**Backend:** Add to `ops-api` (or new `trade-api`):
```
action: 'on_my_way'
- Update job_assignment.status = 'en_route'
- Log stage change to job_stage_history
- Send SMS via GHL API to customer contact
- Include customer portal link with share_token
```

### B3. Job Timer + One-Tap Weekly Invoice [BUILD — Phase 1-2]

**Design philosophy:** Trades won't use anything that feels like admin. The timer needs to be TWO TAPS total across a whole day — start and stop. No GPS drain, no location tracking, no extra fields. Just a clock.

**What already exists:**
- `job_assignments` has `started_at` and `completed_at` columns (migration 013)
- Trade app already has a live timer that ticks every 30s when status is `in_progress`
- Assignment status buttons already exist: Confirm → On Site → Complete

**What to simplify:**
- Remove GPS check-in from status changes (battery drain, overkill, trades won't trust it)
- Simplify to just **Start** / **Stop** — two massive buttons, impossible to miss
- Running timer shows elapsed: `2h 34m` in large text, updates every 30s (already built)
- Timer runs client-side from `started_at` — no battery drain, no background processes
- End of day: stop button saves `completed_at` and that's it

**Trade App Timer UX (dead simple):**
```
┌──────────────────────────────────┐
│                                  │
│          2h 34m                  │  ← big, central, unmissable
│                                  │
│    [ ⏹  Stop Timer ]            │  ← one button, full width
│                                  │
│  Smith Patio · SWP-25043         │
│  Started 7:12 AM                 │
└──────────────────────────────────┘
```

When no timer is running:
```
┌──────────────────────────────────┐
│                                  │
│    [ ▶  Start Timer ]            │  ← one button, full width
│                                  │
│  Next job: Jones Fence · 14 Elm  │
└──────────────────────────────────┘
```

**Multi-Day Jobs — Time Entries Table:**
Most jobs span multiple days. Each day gets its own time entry — tap start in the morning, stop when you leave.

```sql
CREATE TABLE time_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  assignment_id UUID REFERENCES job_assignments(id),
  user_id UUID REFERENCES users(id) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) / 60
  ) STORED,
  notes TEXT,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_time_entries_job ON time_entries(job_id);
CREATE INDEX idx_time_entries_user ON time_entries(user_id);
CREATE INDEX idx_time_entries_date ON time_entries(started_at);
```

#### B3.1 One-Tap Weekly Timesheet → Invoice [BUILD — Week 6]

**The killer feature for hourly-rate trades.** End of the week, they tap one button and get a clean, branded invoice generated from their time entries.

**Flow:**
1. Trade opens "My Week" view (accessible from My Jobs tab — toggle at top: "Today / This Week")
2. Sees a clean summary of the past 7 days:

```
┌──────────────────────────────────┐
│  THIS WEEK                 26h28m│
│                                  │
│  Mon 3 Mar                       │
│  ├ Smith Patio · SWP-25043       │
│  │ 7:12 AM → 3:45 PM · 8h 33m   │
│  │ 14 Elm St, Joondalup          │
│                                  │
│  Tue 4 Mar                       │
│  ├ Smith Patio · SWP-25043       │
│  │ 7:00 AM → 4:10 PM · 9h 10m   │
│  ├ Jones Fence · SWF-25061       │
│  │ 4:30 PM → 6:00 PM · 1h 30m   │
│                                  │
│  Wed 5 Mar                       │
│  ├ Jones Fence · SWF-25061       │
│  │ 7:15 AM → 2:30 PM · 7h 15m   │
│                                  │
│  ─────────────────────────────── │
│  Total: 26h 28m                  │
│  Rate: $55/hr                    │
│  Amount: $1,456.07 + GST         │
│                                  │
│  [ Generate Invoice ]            │
└──────────────────────────────────┘
```

3. Tap "Generate Invoice" → system creates a branded invoice:

```
┌──────────────────────────────────────┐
│  [SecureWorks Logo]                  │
│                                      │
│  TAX INVOICE                         │
│                                      │
│  From: Henry's Installations         │
│  ABN: XX XXX XXX XXX                 │
│  Date: 7 March 2026                  │
│  Invoice #: HI-2026-012             │
│                                      │
│  To: SecureWorks WA Pty Ltd          │
│  ABN: 64 689 223 416                │
│                                      │
│  Date    Job          Address    Hrs │
│  ─────────────────────────────────── │
│  3 Mar   SWP-25043    14 Elm St  8.5 │
│          Smith Patio   Joondalup     │
│  4 Mar   SWP-25043    14 Elm St  9.2 │
│  4 Mar   SWF-25061    8 Park Rd  1.5 │
│          Jones Fence   Duncraig      │
│  5 Mar   SWF-25061    8 Park Rd  7.3 │
│  ─────────────────────────────────── │
│  Total Hours:              26.47     │
│  Rate:                     $55.00/hr │
│  Subtotal:                 $1,455.85 │
│  GST (10%):                $145.59   │
│  TOTAL:                    $1,601.44 │
│                                      │
│  Payment Details:                    │
│  BSB: XXX-XXX  Acc: XXXXXXXX        │
│  Due: 14 days                        │
└──────────────────────────────────────┘
```

4. Trade reviews → taps **Send** → invoice goes to Marnin's email + appears in ops dashboard
5. Auto-creates as Xero ACCPAY bill (draft) so bookkeeper just approves

**Backend:**
```
action: 'generate_weekly_invoice'
1. Query time_entries WHERE user_id = $1 AND started_at >= (now - 7 days)
2. Group by job_id → include job.job_number, job.client_name, job.site_address
3. Look up trade's hourly rate + ABN + business name from trade_profiles
4. Calculate totals + GST
5. Generate branded HTML invoice (reuse service report share_token pattern)
6. Return as shareable link + downloadable PDF
7. Push to Xero as draft ACCPAY bill tagged to each job's xero_project_id
```

**Database:**
```sql
CREATE TABLE trade_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) UNIQUE NOT NULL,
  business_name TEXT,
  abn TEXT,
  hourly_rate NUMERIC NOT NULL DEFAULT 55,
  bank_bsb TEXT,
  bank_account TEXT,
  bank_name TEXT,
  email TEXT,
  phone TEXT,
  invoice_prefix TEXT DEFAULT 'INV',
  invoice_seq INTEGER DEFAULT 0,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE trade_invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) NOT NULL,
  invoice_number TEXT NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  total_hours NUMERIC NOT NULL,
  hourly_rate NUMERIC NOT NULL,
  subtotal NUMERIC NOT NULL,
  gst NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  line_items JSONB NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'approved', 'paid')),
  xero_bill_id TEXT,
  share_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**Why this matters:**
- Trades currently write invoices manually (or don't, and chase payment)
- This gives them a reason to actually use the timer — it makes THEM money faster
- Labour cost per job flows into per-job P&L (Week 7): Materials (POs) + Labour (timer) vs Quoted
- Crew utilisation = total hours worked / available hours → scorecard KPI (target 80%+)
- Trade invoices auto-push to Xero as ACCPAY → bookkeeper just approves → clean books
- Ops dashboard shows: "Crew A — on site 2h 15m" with green dot + pending invoices for approval

### B4. Trade App as Installable PWA [ENHANCE — Phase 2]

**Current state:** Trade app (`dashboard/trade.html`) is already built as a PWA with a manifest. But needs polishing for real daily use.

**Enhancements needed:**
1. **App icon + splash screen** — branded SecureWorks icon so it looks professional on their home screen
2. **Offline support** — cache current job list + job detail data in localStorage/IndexedDB. Photos queue for upload when back online.
3. **Push notifications** (Phase 4+) — "New job assigned" / "Schedule changed" / "Materials arrived"
4. **Install prompt** — on first login, prompt tradesperson to "Add to Home Screen" with instructions

**The install flow:**
1. Tradesperson gets magic link SMS
2. Opens in Safari/Chrome
3. Logs in → sees their jobs
4. Banner: "Install SecureWorks to your home screen for quick access"
5. After install: opens like a native app, no browser chrome

**Manifest updates needed:**
```json
{
  "name": "SecureWorks Trade",
  "short_name": "SW Trade",
  "start_url": "/dashboard/trade.html",
  "display": "standalone",
  "background_color": "#293C46",
  "theme_color": "#293C46",
  "icons": [
    { "src": "/assets/sw-icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/assets/sw-icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### How Bonus Features Stack Together

```
Timer start/stop (B3) → time_entries → one-tap weekly invoice (B3.1)
    → auto-push to Xero as ACCPAY bill → bookkeeper approves
    → labour data feeds per-job P&L (Week 7) → crew utilisation scorecard
    → trades WANT to use it because it generates THEIR invoices

"On My Way" tap (B2) → customer SMS with portal link → live photos
    → job completes → same-day invoice (Week 4) → review request

Weather forecast (B1) → rain warnings on outdoor jobs in Daily Huddle
    → Shaun reschedules proactively → customer auto-texted
    → no wasted travel, crew rerouted to covered work

PWA install (B4) → zero friction → timer + photos = zero admin
    → better data = better P&L = better scheduling = better margins
```

**Key insight: The weekly invoice is what makes trades USE the timer.** Without it, the timer is admin they'll skip. With it, the timer is how they get paid — adoption becomes automatic.

---

## What to BUY vs BUILD

| Decision | Approach | Why |
|----------|----------|-----|
| AR automation | **BUY** Paidnice ($39/mo) | No code needed, proven results, Xero App of Year 2025 |
| Photo storage/documentation | **BUILD** into existing trade app | Already have job_media table + signed URL upload flow |
| AI photo quality scoring | **BUILD LATER** (Phase 4+) | CompanyCam costs $19/user/mo but custom triggers are the real value |
| PO workflow | **BUILD** (custom) | Off-the-shelf can't enforce your specific materials gate + GHL pipeline rules |
| Per-job P&L | **BUILD** on top of Xero Projects API | Already syncing 108 projects — just need better UI |
| Cross-sell automation | **BUILD** triggers in GHL + Supabase | Only you know your multi-division cross-sell logic |
| GHL MCP | **BUY** (free, GHL-hosted) | Just connect — no custom code for the server itself |
| AI voice agent | **DEFER** to Phase 4+ | Evaluate after cross-sell triggers are generating leads |
| Predictive scheduling | **DEFER** to Phase 4+ | Need weather API + more crew data first |
| Weather forecast | **BUILD** (free Open-Meteo BOM API) | No cost, no auth, cache every 6 hours |
| Customer SMS portal | **BUILD** into trade app | Lightweight page + GHL SMS — huge customer experience win |
| Job timer | **BUILD** into trade app | Columns already exist (migration 013) — just UI work + time_entries table |
| PWA enhancements | **BUILD** | Already a PWA — needs icon, offline, install prompt |

---

## Database Migrations Summary

All new tables/columns needed (create as migration 016+):

```sql
-- Migration 016: System Upgrade Phase 1
ALTER TABLE jobs ADD COLUMN xero_project_id TEXT;
ALTER TABLE jobs ADD COLUMN materials_status TEXT DEFAULT 'not_ordered'
  CHECK (materials_status IN ('not_ordered', 'ordered', 'partial', 'received', 'n/a'));
ALTER TABLE jobs ADD COLUMN cross_sell_json JSONB DEFAULT '{}';

CREATE TABLE job_stage_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  stage_name TEXT NOT NULL,
  entered_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  exited_at TIMESTAMPTZ,
  duration_hours NUMERIC GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (COALESCE(exited_at, now()) - entered_at)) / 3600
  ) STORED,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001'
);

CREATE TABLE scorecard_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  week_start DATE NOT NULL,
  metric_name TEXT NOT NULL,
  value NUMERIC,
  target NUMERIC,
  on_track BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, week_start, metric_name)
);

CREATE TABLE ids_issues (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  title TEXT NOT NULL,
  source TEXT,
  source_metric TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  user_id UUID,
  user_email TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE time_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID REFERENCES jobs(id) NOT NULL,
  assignment_id UUID REFERENCES job_assignments(id),
  user_id UUID REFERENCES users(id) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_minutes NUMERIC GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) / 60
  ) STORED,
  notes TEXT,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE trade_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) UNIQUE NOT NULL,
  business_name TEXT,
  abn TEXT,
  hourly_rate NUMERIC NOT NULL DEFAULT 55,
  bank_bsb TEXT,
  bank_account TEXT,
  bank_name TEXT,
  email TEXT,
  phone TEXT,
  invoice_prefix TEXT DEFAULT 'INV',
  invoice_seq INTEGER DEFAULT 0,
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE trade_invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) NOT NULL,
  invoice_number TEXT NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  total_hours NUMERIC NOT NULL,
  hourly_rate NUMERIC NOT NULL,
  subtotal NUMERIC NOT NULL,
  gst NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  line_items JSONB NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'approved', 'paid')),
  xero_bill_id TEXT,
  share_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  org_id UUID DEFAULT '00000000-0000-0000-0000-000000000001',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_stage_history_job ON job_stage_history(job_id);
CREATE INDEX idx_stage_history_stage ON job_stage_history(stage_name);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_date ON audit_log(created_at);
CREATE INDEX idx_scorecard_week ON scorecard_history(week_start);
CREATE INDEX idx_time_entries_job ON time_entries(job_id);
CREATE INDEX idx_time_entries_user ON time_entries(user_id);
CREATE INDEX idx_time_entries_date ON time_entries(started_at);
```

---

## Edge Function Changes Summary

| Function | Changes |
|----------|---------|
| `ghl-proxy` | Add site_address mapping on sync; add Xero Project creation in `link` action; log stage changes to `job_stage_history` |
| `ghl-webhook` | Map address fields from GHL form submissions |
| `ops-api` | Flesh out `scope_to_po` and `complete_and_invoice` stubs; add materials gate check on scheduling; add cross-sell field handling |
| `xero-sync` | Enhanced `sync_projects` with detailed financials; PO status → materials_status sync |
| `reporting-api` | New actions: `job_profitability_detail`, `cross_sell_opportunities`, `weekly_scorecard` |
| **NEW: `trade-api`** | Split from ops-api: my_jobs, upload_photo, service_report, start/stop timer, on_my_way SMS, generate_weekly_invoice |
| **NEW: `weather-cache`** | pg_cron every 6 hours → fetch Open-Meteo BOM API → store in org_config |
| `ops-api` (Phase 4) | Add sales actions: my_pipeline, my_stats, follow_up_list — or split to `sales-api` later |
| `ops-ai` | Already has CEO (7 tools) + Ops (9 tools) views. Add Sales view with conversion-focused prompt + quote/margin tools |

---

## Projected P&L Impact (Day 90)

| Category | Mechanism | Annual Impact |
|----------|-----------|---------------|
| Cash flow | Paidnice + same-day invoicing → DSO 28→17, 90+ AR <$10K | Cash unlock |
| Material savings | PO workflow + materials gate → eliminate 5-10% waste | $50,000-$100,000 |
| Margin protection | Per-job P&L + variance alerts → catch 5% leak | $275,000 |
| Cross-sell revenue | Automated triggers → 10-15% top-line increase | $550,000-$825,000 |
| **Total** | | **$875,000-$1,200,000** |

**Cost to implement:** $39/mo (Paidnice) + developer time. No new platform subscriptions.

---

## Future Phases (Post-90 Days)

These become viable once Phase 1-3 data is flowing:

| Feature | Depends On | Estimated Impact |
|---------|-----------|-----------------|
| AI Photo Quality Scoring | Clean completion photo flow + checklist data | Automated QA, fewer callbacks |
| AI Voice Agent (inbound) | GHL MCP + calendar integration | 60% fewer missed calls |
| Predictive Weather Scheduling | Weather cache (B1) + site_address + crew assignments | Eliminate rain day scramble — weather data already flowing |
| Predictive Estimating | 6+ months of scope_json vs actual PO data | Auto-calibrating quotes |
| Customer Portal | Xero Projects + job_media + timeline | Premium customer experience |
| Route Optimisation | site_address data + multiple crew assignments | Labour efficiency gains |
| **SecureSale Platform** | scope_json + pricing_json + stage_duration data | Personal quote tracker, margin checker, AI sales coach — see full spec above |

---

## Notes for Collaborators

1. **Supabase CLI path:** `/Users/marninstobbe/.local/bin/supabase` (NOT npx)
2. **Deploy command:** `/Users/marninstobbe/.local/bin/supabase functions deploy <name> --project-ref kevgrhcjxspbxgovpmfl`
3. **Functions needing `--no-verify-jwt`:** ghl-proxy, reporting-api, ops-api, ops-ai
4. **RLS is on:** ALL client-side queries fail — route everything through edge functions
5. **PostgREST 1000-row limit:** Use fetchAll() with .range() pagination for bulk queries
6. **Xero rate limit:** 60 req/min — batch operations with pauses
7. **Perth timezone:** AWST = UTC+8, no daylight saving
8. **Other people edit scoping tools repos** — always `git pull` before working on patio-tool or fence-designer
