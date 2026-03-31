# SecureWorks — Definitive Data Architecture Specification

**This is the ground truth. Everything the AI intelligence layer reads from and writes to.**

Hand this document to Claude Code alongside `ai-implementation-roadmap.md` to build from.

**Research basis:** 20+ sources, 3 AI engines (Claude, Gemini via NotebookLM, web research agents), validated against Langfuse patterns, CloudEvents spec, and Palantir Foundry concepts.

**NotebookLM Notebook:** 841ccf86-3cb4-4456-9e78-418324407fdf

**Business context:** SecureWorks WA — Perth construction company, $1.4M revenue, ~45 jobs/month, 5-6 people. Tech stack: Supabase PostgreSQL, Deno edge functions, Anthropic Claude API.

---

## The Six Layers

```
Layer 1: Business Events       — CloudEvents envelope, immutable append-only log
Layer 2: Agent Observability   — Langfuse-inspired 4-table reasoning traces
Layer 3: HITL & Safety         — proposed actions, feedback ledger, action permissions
Layer 4: Financial Intelligence — Xero + ops fusion, materialized views
Layer 5: Supplier Intelligence  — material price ledger, cost trend tracking
Layer 6: Operational Output     — alerts, reports, market intelligence
```

---

## Layer 1: Business Events (CloudEvents Pattern)

One immutable table. Never UPDATE, never DELETE. Uses the CloudEvents envelope with a three-ID correlation pattern (event id, correlation_id for job workflow, causation_id for causal chain).

**Key design decisions:**
- Denormalize context into payload (include client_name, job_type, amounts) to prevent "AI Query Fatigue"
- `job_id` denormalized as a top-level column for fast job-centric queries
- JSONB payload with GIN index for sub-millisecond queries
- `schema_version` for backward compatibility
- RLS: INSERT + SELECT only (enforces immutability)

```sql
CREATE TABLE business_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_number   bigserial UNIQUE,

  -- CloudEvents envelope
  event_type        text NOT NULL,       -- 'job.completed', 'po.created', 'invoice.sent'
  source            text NOT NULL,       -- 'app/field', 'app/office', 'integration/xero'
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  recorded_at       timestamptz NOT NULL DEFAULT now(),

  -- Entity linking
  entity_type       text NOT NULL,       -- 'job', 'purchase_order', 'invoice', 'crew_assignment'
  entity_id         text NOT NULL,

  -- Three-ID correlation pattern
  correlation_id    uuid,                -- all events in one job's lifecycle
  causation_id      uuid,                -- the specific event that caused this one
  job_id            text,                -- denormalized for fast job queries

  -- Flexible payload
  payload           jsonb NOT NULL DEFAULT '{}',
  metadata          jsonb NOT NULL DEFAULT '{}',
  schema_version    text NOT NULL DEFAULT '1.0'
);

CREATE INDEX idx_events_entity ON business_events(entity_type, entity_id);
CREATE INDEX idx_events_job ON business_events(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_events_type ON business_events(event_type);
CREATE INDEX idx_events_correlation ON business_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_events_occurred ON business_events(occurred_at DESC);
CREATE INDEX idx_events_payload ON business_events USING GIN (payload jsonb_path_ops);

ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insert_only" ON business_events FOR INSERT WITH CHECK (true);
CREATE POLICY "select_all" ON business_events FOR SELECT USING (true);

COMMENT ON TABLE business_events IS 'Immutable append-only log of all business operations using CloudEvents envelope';
COMMENT ON COLUMN business_events.correlation_id IS 'Shared UUID linking all events in one job lifecycle workflow';
COMMENT ON COLUMN business_events.causation_id IS 'UUID of the specific event that triggered this one';
COMMENT ON COLUMN business_events.payload IS 'JSONB with entity, changes, financial, related_entities, estimated_vs_actual keys';
```

### Payload Convention

```json
{
  "entity": { "id": "SWP-25042", "name": "Henderson Patio" },
  "changes": { "status": { "from": "in_progress", "to": "completed" } },
  "financial": { "amount": 22000, "currency": "AUD" },
  "related_entities": [
    { "type": "client", "id": "client-uuid", "name": "Henderson" },
    { "type": "crew", "id": "crew-uuid", "name": "Team A" }
  ],
  "estimated_vs_actual": { "estimated": 18000, "actual": 22000, "variance_pct": 22.2 }
}
```

### Migration Strategy

`business_events` runs alongside the existing `job_events` table. New code writes to BOTH. AI reads from `business_events`. Dashboards continue reading `job_events`. Migrate dashboard reads over 3-6 months.

---

## Layer 2: Agent Observability (Langfuse 4-Table Pattern)

Four linked tables inspired by Langfuse's trace → observation → score model.

### Table 1: ai_reasoning_traces — one row per AI analysis cycle

```sql
CREATE TABLE ai_reasoning_traces (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  trigger_type              text NOT NULL,  -- 'scheduled', 'event', 'user_query'
  trigger_reference_id      uuid,
  correlation_id            uuid,  -- links to business_events correlation
  model_name                text NOT NULL,  -- 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'
  prompt_template_version   text,
  input_context_snapshot    jsonb NOT NULL,  -- FROZEN copy of all data fed to AI
  input_context_hash        text,  -- SHA-256 for dedup
  reasoning_summary         text,
  reasoning_full            text,  -- archived after 30 days
  confidence_score          numeric(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
  confidence_breakdown      jsonb,  -- {data_quality: 0.8, pattern_strength: 0.9}
  dismissed_hypotheses      jsonb DEFAULT '[]',
  output_result             jsonb NOT NULL,
  output_type               text NOT NULL,  -- 'anomaly_detection', 'cost_estimate', 'schedule_risk', 'financial_narrative'
  input_tokens              integer,
  output_tokens             integer,
  cost_usd                  numeric(10,6),
  latency_ms                integer,
  iteration_count           integer DEFAULT 1,
  max_iterations            integer DEFAULT 10,
  status                    text DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed', 'killed')),
  storage_tier              text DEFAULT 'full' CHECK (storage_tier IN ('full', 'summarized', 'archived')),
  tags                      text[] DEFAULT '{}'
);

CREATE INDEX idx_traces_created ON ai_reasoning_traces(created_at DESC);
CREATE INDEX idx_traces_correlation ON ai_reasoning_traces(correlation_id);
CREATE INDEX idx_traces_output_type ON ai_reasoning_traces(output_type);
CREATE INDEX idx_traces_model ON ai_reasoning_traces(model_name);

COMMENT ON TABLE ai_reasoning_traces IS 'Complete chain-of-thought log for every AI analysis cycle - the master reasoning record';
COMMENT ON COLUMN ai_reasoning_traces.input_context_snapshot IS 'CRITICAL: frozen copy of exact data the AI saw, for debugging wrong recommendations weeks later';
```

### Table 2: ai_decision_links — connects reasoning to outputs

```sql
CREATE TABLE ai_decision_links (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id                uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  decision_type           text NOT NULL,  -- 'alert_generated', 'insight_created', 'price_suggested', 'schedule_proposed'
  decision_reference_id   uuid,
  decision_reference_table text,
  decision_summary        text NOT NULL,
  confidence_at_decision  numeric(4,3),
  priority                text CHECK (priority IN ('critical', 'high', 'medium', 'low', 'info')),
  created_at              timestamptz DEFAULT now()
);

CREATE INDEX idx_decision_links_trace ON ai_decision_links(trace_id);
```

### Table 3: ai_feedback_outcomes — closes the loop

```sql
CREATE TABLE ai_feedback_outcomes (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id                  uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  decision_link_id          uuid REFERENCES ai_decision_links(id),
  human_action              text NOT NULL,  -- 'accepted', 'rejected', 'modified', 'ignored'
  human_action_at           timestamptz,
  human_modification        jsonb,
  human_notes               text,
  actual_outcome            jsonb,  -- filled later when job completes
  outcome_recorded_at       timestamptz,
  prediction_accuracy_score numeric(4,3),
  feedback_category         text,  -- 'true_positive', 'false_positive', 'true_negative', 'false_negative'
  lessons_learned           text,
  created_at                timestamptz DEFAULT now()
);

CREATE INDEX idx_feedback_trace ON ai_feedback_outcomes(trace_id);
CREATE INDEX idx_feedback_category ON ai_feedback_outcomes(feedback_category);

COMMENT ON TABLE ai_feedback_outcomes IS 'Human responses to AI proposals + actual outcomes - the self-improvement data source';
```

### Table 4: ai_scores — flexible evaluation

```sql
CREATE TABLE ai_scores (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id  uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  name      text NOT NULL,  -- 'relevance', 'correctness', 'hallucination_check', 'cost_accuracy'
  value     numeric,
  data_type text DEFAULT 'NUMERIC',
  source    text NOT NULL,  -- 'auto_eval', 'human', 'llm_judge'
  comment   text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_scores_trace ON ai_scores(trace_id);
```

### Storage Management

pg_cron job runs monthly to downgrade traces older than 30 days from `full` to `summarized` (nullifies `reasoning_full`, compresses `input_context_snapshot`). Reduces storage ~60%.

---

## Layer 3: HITL & Safety

### ai_proposed_actions — pending state table

```sql
CREATE TABLE ai_proposed_actions (
  proposal_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id          uuid NOT NULL REFERENCES ai_reasoning_traces(id),
  action_type       text NOT NULL,
  action_payload    jsonb NOT NULL,
  confidence_score  numeric(4,3),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'auto_approved', 'approved', 'rejected', 'expired')),
  auto_threshold    numeric(4,3) DEFAULT 0.870,
  ai_processed_at   timestamptz,
  resolved_at       timestamptz,
  resolved_by       uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

### action_permissions — autonomy tiers

```sql
CREATE TABLE action_permissions (
  action_type       text PRIMARY KEY,
  risk_level        text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  autonomy_level    text NOT NULL CHECK (autonomy_level IN ('auto', 'notify', 'approve', 'block')),
  max_dollar_amount numeric(12,2),
  daily_limit       integer,
  description       text
);

-- Seed with initial permissions
INSERT INTO action_permissions VALUES
  ('generate_report', 'low', 'auto', NULL, NULL, 'AI generates reports automatically'),
  ('send_alert', 'low', 'auto', NULL, 50, 'AI sends alerts up to 50/day'),
  ('suggest_price_update', 'medium', 'notify', NULL, NULL, 'AI suggests, human reviews'),
  ('suggest_schedule', 'medium', 'notify', NULL, NULL, 'AI suggests schedule changes'),
  ('send_client_sms', 'high', 'approve', NULL, 10, 'Must be human-approved'),
  ('update_material_price', 'high', 'approve', 5000, NULL, 'Must be human-approved'),
  ('create_invoice', 'high', 'approve', NULL, NULL, 'Must be human-approved'),
  ('approve_change_order', 'critical', 'block', NULL, NULL, 'AI cannot do this');

COMMENT ON TABLE action_permissions IS 'Controls what the AI can do autonomously vs what needs human approval';
```

---

## Layer 4: Financial Intelligence (Xero + Ops Fusion)

### financial_snapshots — pre-computed by pg_cron, narratives by Claude

```sql
CREATE TABLE financial_snapshots (
  snapshot_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  trace_id                uuid,
  period_type             text NOT NULL CHECK (period_type IN ('daily', 'weekly', 'monthly', 'quarterly')),
  period_date             date NOT NULL,
  -- Pre-computed aggregations (SQL, zero AI cost)
  revenue_invoiced        numeric(12,2),
  revenue_collected       numeric(12,2),
  unbilled_revenue        numeric(12,2),
  outstanding_receivables numeric(12,2),
  outstanding_payables    numeric(12,2),
  bank_balance            numeric(12,2),
  upcoming_po_costs       numeric(12,2),
  gross_margin_pct        numeric(5,2),
  jobs_completed          integer,
  jobs_in_progress        integer,
  -- AI-generated narratives
  pnl_narrative           text,   -- explain_pnl: accrual vs job-level reconciliation
  cash_flow_projection    jsonb,  -- 30/60/90 day forecast
  division_stats          jsonb,  -- patio vs fencing vs decking comparison
  cost_trend_alerts       jsonb,  -- material cost creep detection
  executive_summary       text,   -- the single paragraph business status
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, period_type, period_date)
);

COMMENT ON TABLE financial_snapshots IS 'Pre-computed financial intelligence combining Xero accrual data with operational job data';
```

### Xero Sync Tables

```sql
-- xero_bank_balances: daily cash position snapshot
CREATE TABLE xero_bank_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  account_id text NOT NULL,
  account_name text NOT NULL,
  balance numeric(12,2) NOT NULL,
  synced_at timestamptz NOT NULL,
  UNIQUE(org_id, account_id, synced_at::date)
);

-- xero_aged_payables: what you owe suppliers
CREATE TABLE xero_aged_payables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  contact_name text NOT NULL,
  amount_due numeric(12,2) NOT NULL,
  age_bucket text NOT NULL,
  synced_at timestamptz NOT NULL
);

-- xero_bank_transactions: reconciled transactions (90-day rolling window)
CREATE TABLE xero_bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_txn_id text NOT NULL,
  txn_date date NOT NULL,
  txn_type text,  -- 'RECEIVE', 'SPEND', 'TRANSFER'
  contact_name text,
  reference text,
  amount numeric(12,2) NOT NULL,
  UNIQUE(org_id, xero_txn_id)
);
```

### 5 Xero AI Tools (add to ops-ai)

1. **`explain_pnl`** — Cross-references Xero P&L against job completions and PO timing. Explains why Xero shows -$20K when every job is profitable (unbilled completed jobs + prepaid supplier costs). **Uses Opus** for complex multi-factor reasoning.
2. **`cash_flow_forecast`** — Combines bank balances + outstanding invoices + confirmed POs + scheduled jobs + historical payment patterns. Projects 30/60/90 days.
3. **`cost_trend_analysis`** — Tracks material cost per unit over time from `material_price_ledger`. Flags creep.
4. **`division_comparison`** — Compares patio vs fencing vs decking on revenue, margin, duration, and revenue per crew-day.
5. **`unbilled_revenue`** — Finds completed jobs without invoices. Calculates total sitting on the table.

---

## Layer 5: Supplier Intelligence

### material_price_ledger — the supplier price capture loop

```sql
CREATE TABLE material_price_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  supplier_name text NOT NULL,
  item_description text NOT NULL,
  material_category text,
  material_code text,
  unit text,
  unit_price numeric(12,2) NOT NULL,
  po_id uuid REFERENCES purchase_orders(id),
  job_id uuid REFERENCES jobs(id),
  trace_id uuid,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  confirmed_by uuid,
  confirmed_at timestamptz,
  dismiss_reason text,
  scope_tool_field text,
  previous_rate numeric(12,2),
  captured_at timestamptz DEFAULT now()
);

COMMENT ON TABLE material_price_ledger IS 'Live supplier pricing database captured from confirmed POs - feeds scope tool accuracy';
```

---

## Layer 6: Operational Output

These tables already exist:
- **ai_alerts** — proactive warnings
- **weekly_reports** — periodic business analysis
- **crew_availability** — crew scheduling
- **daily_digests** — morning briefing
- **market_intelligence** — external world knowledge (monthly scans)

---

## Three-Tier Model Strategy

| Model | Cost/MTok | Monthly Budget | Use For |
|-------|-----------|---------------|---------|
| **Haiku 4.5** | $1/$5 | ~$3/mo | 95% of calls: daily alerts, threshold narration, simple chat responses, PO price extraction |
| **Sonnet 4.6** | $3/$15 | ~$2/mo | Weekly pulse, morning briefs, standard chat interactions, SOP generation |
| **Opus 4.6** | $5/$25 | ~$3-5/mo | Monthly pricing recommendations, quarterly business review, explain_pnl (the -$20K problem), correction-of-error analysis, complex anomaly explanation |

**When to use Opus:** Only for decisions where wrong reasoning costs real money. If the AI incorrectly explains why the P&L looks bad, Marnin makes a wrong business decision. If the AI's pricing recommendation is off, quotes go out wrong for a month. These justify Opus.

**Token optimization:**
- Prompt caching: system prompt cached across all calls (90% input cost reduction after first hit)
- Send only changed fields, not entire records (100-200 tokens vs 2,000+)
- Structured JSON output mode for parseable responses
- Batch API for weekly Sonnet analysis (50% discount for 24-hour async)

---

## Materialized Views (Free Intelligence — 80% of needs)

```sql
-- Job intelligence profile: refreshed every 15 minutes
CREATE MATERIALIZED VIEW job_intelligence AS
SELECT
  j.id, j.job_number, j.client_name, j.type, j.status, j.site_suburb,
  j.created_at, j.quoted_at, j.accepted_at, j.completed_at,
  (j.pricing_json->>'total')::numeric as quoted_total,
  COALESCE(SUM(po.total), 0) as actual_po_cost,
  COALESCE(SUM(inv.amount_due), 0) as amount_invoiced,
  COALESCE(SUM(inv.amount_paid), 0) as amount_collected,
  COUNT(DISTINCT be.id) as event_count,
  MAX(be.occurred_at) as last_activity
FROM jobs j
LEFT JOIN purchase_orders po ON po.job_id = j.id AND po.status != 'deleted'
LEFT JOIN xero_invoices inv ON inv.job_id = j.id
LEFT JOIN business_events be ON be.job_id = j.job_number
GROUP BY j.id;

-- AI self-improvement signals: refreshed weekly
CREATE MATERIALIZED VIEW ai_improvement_signals AS
SELECT
  t.output_type,
  t.model_name,
  t.prompt_template_version,
  COUNT(*) as total_traces,
  AVG(t.confidence_score) as avg_confidence,
  COUNT(*) FILTER (WHERE f.feedback_category = 'false_positive') as false_positives,
  COUNT(*) FILTER (WHERE f.human_action = 'rejected') as rejections,
  COUNT(*) FILTER (WHERE f.human_action = 'accepted') as acceptances,
  AVG(f.prediction_accuracy_score) as avg_prediction_accuracy,
  AVG(t.cost_usd) as avg_cost_per_trace
FROM ai_reasoning_traces t
LEFT JOIN ai_feedback_outcomes f ON f.trace_id = t.id
WHERE t.created_at > now() - INTERVAL '30 days'
GROUP BY 1, 2, 3;
```

### Refresh via pg_cron

```sql
SELECT cron.schedule('refresh_job_intelligence', '*/15 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY job_intelligence');
SELECT cron.schedule('refresh_ai_signals', '0 1 * * 1', 'REFRESH MATERIALIZED VIEW CONCURRENTLY ai_improvement_signals');
```

---

## Trigger Architecture: pgmq Queue Pattern

NOT raw database triggers. Use pgmq (message queue built into PostgreSQL) for debouncing and reliability:

```sql
CREATE EXTENSION IF NOT EXISTS pgmq;
SELECT pgmq.create('ai_analysis_queue');

CREATE OR REPLACE FUNCTION queue_ai_analysis()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM pgmq.send('ai_analysis_queue', jsonb_build_object(
    'id', NEW.id,
    'table', TG_TABLE_NAME,
    'operation', TG_OP,
    'priority', CASE WHEN TG_TABLE_NAME = 'purchase_orders' THEN 'high' ELSE 'normal' END
  ));
  RETURN NEW;
END;
$$;
```

pg_cron polls the queue every 30 seconds, edge function processes messages in batch. Natural debouncing: if a job is updated 10 times in 5 seconds, the next cron tick processes all messages at once.

---

## Circuit Breakers & Cost Controls

| Mechanism | Where | Config |
|-----------|-------|--------|
| max_iterations cap | ai_reasoning_traces | Default 10, kill at limit |
| ai_processed_at field | ai_proposed_actions | Prevents double-processing |
| RLS INSERT-only | business_events | Enforces immutability |
| Edge function timeout | Deno runtime | 60 seconds |
| Daily budget tracker | Edge function | $2/day cap (~$60/month max) |
| Circuit breaker | Edge function | 3 consecutive API failures → 60s cooldown |
| Confidence threshold | ai_proposed_actions | >0.87 auto-approve, <0.87 human review |
| Acceptance rate monitor | Weekly pulse | If <50% acceptance for a week → disable AI recommendations, fall back to rules |

---

## Cold-Start Progressive Enhancement

| Phase | Trigger | What Happens |
|-------|---------|-------------|
| Phase 1 (Day 1) | Zero AI | Hard-coded rules: "invoice within 24hrs of completion", "PO cost >10% over quote = alert" |
| Phase 2 (50+ completed jobs) | Your actual averages | Replace industry benchmarks with your data |
| Phase 3 (200+ completed jobs) | Claude analyzes patterns | Text analysis of notes, change orders, client communications |
| Phase 4 (500+ jobs with outcomes) | Predictive confidence | AI predicts which quotes will convert, which jobs will overrun |

---

## MCP Readiness: COMMENT ON Everything

```sql
-- Add to ALL existing tables
COMMENT ON TABLE jobs IS 'Central entity - all construction jobs from lead to completion';
COMMENT ON COLUMN jobs.pricing_json IS 'Scope tool output: line items, material costs, labour, total. Keys vary by tool version.';
COMMENT ON COLUMN jobs.created_by IS 'UUID of the salesperson who created the job - used for performance analysis';
COMMENT ON TABLE purchase_orders IS 'Material and labour purchase orders linked to jobs';
COMMENT ON TABLE xero_invoices IS 'Sales invoices and bills synced from Xero accounting';
COMMENT ON TABLE job_assignments IS 'Crew scheduling - links jobs to users with dates and times';
COMMENT ON TABLE job_events IS 'Legacy event log - being superseded by business_events';
-- ... etc for every table and key column
```

---

## What You'll Regret NOT Capturing

1. **PO supplier reason** — optional one-tap on PO creation: Price / Availability / Speed / Relationship / Only option
2. **Lost job reason** — required dropdown when marking lost: Too expensive / Wrong timing / Chose competitor / Project cancelled
3. **AI reasoning traces** — every recommendation with full context snapshot
4. **Denormalized context** in events — include names, amounts, types in the payload
5. **Schema version** on events — backward compatibility as payloads evolve
6. **Before/after values** on every change — not just the new state
7. **Channel/source** on events — was this from the app, the office, Xero sync, or the AI?

---

## Six-Week Implementation Sequence

**Week 1:** Set up pgmq + pg_cron infrastructure. Create `business_events` table. Add `COMMENT ON` to all existing tables. Wire event queue triggers to key tables.

**Week 2:** Build the Deno edge function for queue processing with circuit breaker and daily budget tracker. Create `ai_reasoning_traces` and related tables. Start logging traces on ops-ai interactions.

**Week 3:** Create materialized views for job profitability, budget utilization, and KPIs. Set up 15-minute refresh via pg_cron. Wire into CEO and Ops dashboards.

**Week 4:** Add pg_cron deadline monitoring: missing invoices (24hr), overdue milestones, payment tracking. Implement the `action_permissions` table and autonomy tiers.

**Week 5:** Integrate Claude Haiku with prompt caching for daily AI insights. Deploy `material_price_ledger` and PO price extraction. Build the human confirmation UI in ops.html.

**Week 6:** Add Opus for monthly pricing recommendations and `explain_pnl`. Build the feedback outcome capture into the normal workflow. Deploy the `ai_improvement_signals` materialized view. First weekly pulse with full financial intelligence.

---

## Total Cost

| Component | Monthly Cost |
|-----------|-------------|
| Supabase Pro | $25 |
| Claude Haiku (daily alerts, PO extraction) | ~$3 |
| Claude Sonnet (weekly pulse, chat, briefs) | ~$2 |
| Claude Opus (monthly pricing, explain_pnl, COE) | ~$3-5 |
| **Total** | **$33-35/month** |

---

## Three Critical Mistakes to Avoid

1. **Don't build RAG.** At 10K-50K events, full-context prompting + prompt caching is faster and cheaper than retrieval infrastructure. Anthropic's own docs confirm this.

2. **Don't use multiple databases.** PostgreSQL + pgvector handles all memory types (episodic, semantic, procedural) without a separate vector store until you exceed ~100M vectors. You won't exceed that for decades.

3. **Don't start with complex AI.** Launch with SQL-only intelligence (materialized views + threshold alerts). Add Claude interpretation AFTER the data pipeline is proven reliable. The intelligence is in the data structure, not the model.
