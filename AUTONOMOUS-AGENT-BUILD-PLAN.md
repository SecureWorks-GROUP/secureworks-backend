# SecureWorks Autonomous Agent Build Plan v2

> From reactive AI assistant to self-improving autonomous operations.
> Updated with codebase cross-reference corrections, Claude Agent SDK native patterns, and competitive moat strategies.

---

## CORRECTIONS FROM V1

Before reading the plan, here's what changed from v1 and why:

1. **ops-ai stays independent.** v1 said agent-orchestrator replaces ops-ai as the entry point. Wrong — ops-ai is called by daily-digest, dashboard, telegram-bot, and has 3,290 lines of deeply integrated logic. agent-orchestrator is a PARALLEL system that calls ops-ai when it needs decisions, not a replacement.

2. **Use `action_permissions` table for thresholds.** v1 hardcoded confidence > 0.95. Your existing `action_permissions` table (from 20260316000005_intelligence_layer.sql) already has `auto_threshold` set to 0.870. Use the table, not hardcoded values.

3. **Use `staff_personas` database table, not hardcoded TypeScript map.** v1 had a `STAFF_AGENTS` constant with 7 bot tokens as env vars. Your existing code uses dynamic `resolveRole()`. Staff config belongs in the database.

4. **Don't rebuild existing cron jobs.** stale-followup (9am), eod-followup-5pm, eod-escalation-7pm, and shaun-morning-brief already exist in 20260322000012_phase2_cron_jobs.sql. Orchestrate them, don't duplicate.

5. **Reuse existing tables.** `ai_reasoning_traces`, `ai_proposed_actions`, `ai_feedback_outcomes`, `action_permissions`, `business_events` already exist. Extend them with workflow context columns instead of creating parallel tables.

6. **Use Agent SDK native features.** The SDK has built-in session persistence, error handling, retries, human-in-the-loop hooks, subagents, and context compaction. ~40% of v1's custom code is unnecessary.

7. **Use existing Telegram approval card pattern.** telegram-bot.ts already has `inline_keyboard` with confirm/reject callbacks. Reuse that UI pattern.

---

## Architecture Overview

SecureSuite is the highway. The Claude Agent SDK sits alongside ops-ai as the persistent brain for multi-step workflows. External agents connect via MCP.

```
┌──────────────────────────────────────────────────────────────┐
│                     SecureSuite Platform                       │
│                                                                │
│  ┌────────────────────┐    ┌──────────────────────────────┐   │
│  │  ops-ai (EXISTING)  │    │  agent-orchestrator (NEW)     │   │
│  │  Single-turn brain  │◄───│  Claude Agent SDK              │   │
│  │  3,290 lines        │    │  Multi-step persistent loops   │   │
│  │  70+ tools          │    │                                │   │
│  │  5-gate auto-exec   │    │  ┌──────────┐  ┌───────────┐  │   │
│  │  Haiku/Sonnet route  │    │  │  memory  │  │  self-mod  │  │   │
│  └────────────────────┘    │  │  bank    │  │  engine    │  │   │
│           ▲                 │  └──────────┘  └───────────┘  │   │
│           │ HTTP calls      └──────────────────────────────┘   │
│           │                              │                      │
│  ┌────────┴──────┐  ┌───────────────┐  ┌──────────────────┐   │
│  │ daily-digest   │  │  personal-    │  │  MCP Server      │   │
│  │ telegram-bot   │  │  agent        │  │  (external       │   │
│  │ send-quote     │  │  (Telegram    │  │   agents)        │   │
│  │ (ALL EXISTING) │  │   DM bots)   │  │                  │   │
│  └───────────────┘  └───────────────┘  └──────────────────┘   │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                 Supabase (PostgreSQL)                      │ │
│  │  EXISTING: ai_reasoning_traces, ai_proposed_actions,      │ │
│  │  ai_feedback_outcomes, action_permissions, business_events │ │
│  │  NEW: agent_workflows, agent_memory, staff_personas,      │ │
│  │  sop_registry, code_modifications, pattern_observations   │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Key difference from v1: ops-ai and agent-orchestrator are peers. ops-ai handles single-turn queries (dashboard, Telegram group, direct questions). agent-orchestrator handles multi-step workflows (debt chase sequences, quote follow-up chains, completion pack pipelines). The orchestrator calls ops-ai as one of its tools.

---

## Phase 1: Agent SDK Integration (Weeks 1–4)

### Goal
Stand up the Claude Agent SDK as a parallel orchestration layer that can run persistent multi-step workflows, calling existing edge functions (including ops-ai) as tools.

### 1.1 — New Edge Function: `agent-orchestrator/index.ts`

```typescript
// supabase/functions/agent-orchestrator/index.ts
//
// ARCHITECTURE RULES:
// - This function is a PEER of ops-ai, not a replacement
// - ops-ai continues handling: dashboard queries, Telegram group, direct questions
// - agent-orchestrator handles: multi-step workflows, cron-triggered sequences, proactive outreach
// - Both share the same database and can read each other's outputs
//
// USES AGENT SDK NATIVE FEATURES:
// - Session persistence (SDK built-in, not custom table)
// - Error handling + retries (SDK built-in)
// - Human-in-the-loop (SDK PermissionRequest hooks → wired to Telegram)
// - Subagents for personal staff agents (SDK built-in)
// - Context compaction for long conversations (SDK built-in)

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Tools the agent can use:
const AGENT_TOOLS = [
  // CALL EXISTING OPS-AI (not replacing it — calling it)
  {
    name: "execute_ops_query",
    description: "Send a query to the existing ops-ai brain and get a response. Use this for any single-turn business question or action.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query for ops-ai" },
        caller_id: { type: "string", description: "Staff member context for role-based routing" },
      },
      required: ["query"]
    }
  },

  // CALL EXISTING EDGE FUNCTIONS DIRECTLY
  {
    name: "call_edge_function",
    description: "Call any existing SecureSuite edge function directly (send-quote, completion-pack, xero-sync, etc.)",
    input_schema: {
      type: "object",
      properties: {
        function_name: { type: "string", enum: ["send-quote", "completion-pack", "xero-sync", "reporting-api", "send-po-email", "daily-digest"] },
        action: { type: "string", description: "The action parameter for the edge function" },
        payload: { type: "object", description: "The request body" }
      },
      required: ["function_name"]
    }
  },

  // DEEP MEMORY (new capability)
  {
    name: "memory_recall",
    description: "Recall everything the system knows about an entity — client history, suburb knowledge, supplier patterns, staff preferences",
    input_schema: {
      type: "object",
      properties: {
        entity_type: { type: "string", enum: ["client", "job", "staff", "supplier", "suburb", "process"] },
        entity_id: { type: "string" },
        context: { type: "string", description: "What kind of information you need" }
      },
      required: ["entity_type", "context"]
    }
  },
  {
    name: "memory_store",
    description: "Store a new observation or learned fact in the memory bank",
    input_schema: {
      type: "object",
      properties: {
        entity_type: { type: "string" },
        entity_id: { type: "string" },
        memory_type: { type: "string", enum: ["episodic", "semantic", "procedural", "strategic"] },
        content: { type: "string" },
        confidence: { type: "number", description: "0-1" },
        source: { type: "string" }
      },
      required: ["content", "confidence", "source"]
    }
  },

  // WORKFLOW STATE (persists multi-step progress)
  {
    name: "workflow_update",
    description: "Update the current workflow step, save state, record results",
    input_schema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        step: { type: "number" },
        status: { type: "string", enum: ["running", "paused", "awaiting_approval", "completed", "failed"] },
        result: { type: "object" },
        next_action: { type: "string" }
      },
      required: ["workflow_id", "step", "status"]
    }
  },

  // APPROVAL VIA TELEGRAM (reuses existing inline_keyboard pattern)
  {
    name: "request_approval",
    description: "Send an approval card to a staff member via Telegram DM using existing inline_keyboard UI",
    input_schema: {
      type: "object",
      properties: {
        staff_id: { type: "string" },
        summary: { type: "string" },
        details: { type: "string" },
        actions: { type: "array", items: { type: "object", properties: { label: { type: "string" }, callback: { type: "string" } } } }
      },
      required: ["staff_id", "summary"]
    }
  },

  // SOP CHECK (new capability)
  {
    name: "sop_check",
    description: "Check if a proposed action complies with registered SOPs. Returns compliance status and any required adjustments.",
    input_schema: {
      type: "object",
      properties: {
        action_type: { type: "string" },
        action_details: { type: "object" }
      },
      required: ["action_type"]
    }
  },

  // SELF-MODIFICATION PROPOSAL (Phase 2, schema defined now)
  {
    name: "propose_code_change",
    description: "Propose a code modification based on observed patterns. Creates a pending review for Marnin.",
    input_schema: {
      type: "object",
      properties: {
        target_file: { type: "string" },
        rationale: { type: "string" },
        expected_improvement: { type: "string" },
        evidence: { type: "object" }
      },
      required: ["target_file", "rationale", "expected_improvement"]
    }
  },

  // SEND TELEGRAM MESSAGE (to any staff member's personal bot)
  {
    name: "send_staff_message",
    description: "Send a proactive message to a staff member via their personal Telegram bot",
    input_schema: {
      type: "object",
      properties: {
        staff_id: { type: "string" },
        message: { type: "string" },
        parse_mode: { type: "string", enum: ["HTML", "Markdown"], default: "HTML" }
      },
      required: ["staff_id", "message"]
    }
  }
];

// APPROVAL LOGIC: Uses existing action_permissions table, NOT hardcoded thresholds
async function shouldAutoExecute(supabase: any, actionType: string, confidence: number): Promise<boolean> {
  // Check action_permissions table (already exists from intelligence_layer migration)
  const { data: permission } = await supabase
    .from('action_permissions')
    .select('autonomy_level, auto_threshold, requires_approval_from')
    .eq('action_type', actionType)
    .single();

  if (!permission) return false;
  if (permission.autonomy_level === 'auto' && confidence >= permission.auto_threshold) return true;
  if (permission.autonomy_level === 'block') return false;
  return false; // 'approve' or 'notify' → needs human
}

// HOW THE AGENT CALLS EXISTING OPS-AI (HTTP, not import)
async function callOpsAI(query: string, callerId: string): Promise<any> {
  const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ops-ai`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      caller_id: callerId,
      channel: 'agent_orchestrator'
    })
  });
  return response.json();
}

// HOW THE AGENT CALLS ANY EXISTING EDGE FUNCTION
async function callEdgeFunction(functionName: string, body: any): Promise<any> {
  const response = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return response.json();
}
```

### 1.2 — Database Changes

**EXTEND existing tables (don't create parallel ones):**

```sql
-- migration: XXXXXX_agent_orchestrator.sql

-- Add workflow tracking columns to existing ai_reasoning_traces
ALTER TABLE ai_reasoning_traces
  ADD COLUMN IF NOT EXISTS workflow_id UUID,
  ADD COLUMN IF NOT EXISTS workflow_step INTEGER,
  ADD COLUMN IF NOT EXISTS auto_executed BOOLEAN DEFAULT false;

-- Multi-step workflow state (NEW — nothing like this exists)
CREATE TABLE agent_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type TEXT NOT NULL,               -- debt_chase, quote_followup, completion_pack, pattern_analysis
  triggered_by TEXT NOT NULL,                -- cron, webhook, user_request, pattern_detection
  trigger_data JSONB DEFAULT '{}',           -- the event that started this workflow
  current_step INTEGER DEFAULT 0,
  total_steps INTEGER NOT NULL,
  step_definitions JSONB NOT NULL,           -- what each step does
  step_results JSONB DEFAULT '[]',           -- outcomes of completed steps
  state JSONB DEFAULT '{}',                  -- working state carried between steps
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'paused', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  approval_gates INTEGER[],                  -- step numbers needing human sign-off
  approved_by TEXT,
  error_log JSONB DEFAULT '[]',
  tokens_used INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  org_id TEXT DEFAULT 'secureworks'
);

-- Staff personas (replaces hardcoded STAFF_AGENTS map)
-- Uses same role system as existing resolveRole() in ops-ai
CREATE TABLE staff_personas (
  staff_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  telegram_user_id TEXT,                     -- their personal Telegram user ID
  telegram_bot_token TEXT,                   -- encrypted, their personal bot token
  role TEXT NOT NULL CHECK (role IN ('crew', 'lead_installer', 'division_ops', 'sales', 'admin')),
  tools_allowed TEXT[] DEFAULT '{}',         -- which agent tools they can access
  persona_prompt TEXT,                       -- personality/tone for their personal agent
  proactive_triggers TEXT[] DEFAULT '{}',    -- what events trigger outreach to them
  morning_brief_time TIME,                   -- when they get their personalised brief
  model_preference TEXT DEFAULT 'haiku',     -- haiku or sonnet for their queries
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed with current team (matches existing resolveRole() mapping)
INSERT INTO staff_personas (staff_id, display_name, role, tools_allowed, persona_prompt, proactive_triggers, morning_brief_time, model_preference) VALUES
  ('marnin', 'Marnin Stobbe', 'admin', ARRAY['*'], 'Strategic advisor. Surface insights, decisions needed, anomalies. Be direct and concise.', ARRAY['revenue_anomaly', 'code_modification_pending', 'weekly_patterns', 'cash_flow_alert'], '07:00', 'sonnet'),
  ('shaun', 'Shaun', 'division_ops', ARRAY['execute_ops_query', 'call_edge_function', 'memory_recall', 'workflow_update', 'sop_check', 'request_approval'], 'Efficient ops partner. Proactive about bottlenecks. Short and actionable.', ARRAY['scheduling_conflict', 'po_missing', 'crew_issue', 'debt_approval_needed'], '06:45', 'haiku'),
  ('nathan', 'Nathan', 'sales', ARRAY['execute_ops_query', 'memory_recall', 'send_staff_message'], 'Sales coach. Track conversion patterns, suggest next actions. Motivating.', ARRAY['quote_viewed', 'stale_quote', 'pipeline_gap', 'conversion_opportunity'], '07:15', 'haiku'),
  ('khairo', 'Khairo', 'sales', ARRAY['execute_ops_query', 'memory_recall', 'send_staff_message'], 'Sales coach tailored to Khairo style and client base.', ARRAY['quote_viewed', 'stale_quote', 'pipeline_gap'], '07:15', 'haiku'),
  ('henry', 'Henry', 'lead_installer', ARRAY['execute_ops_query', 'memory_recall'], 'Site assistant. Brief and practical. Proactive about missing info.', ARRAY['job_assigned', 'material_delivery', 'completion_pack_reminder'], '06:30', 'haiku'),
  ('isaac', 'Isaac', 'lead_installer', ARRAY['execute_ops_query', 'memory_recall'], 'Site assistant. Brief and practical.', ARRAY['job_assigned', 'material_delivery', 'completion_pack_reminder'], '06:30', 'haiku'),
  ('jan', 'Jan', 'admin', ARRAY['execute_ops_query', 'memory_recall'], 'Concise financial summary. Flag only what needs attention.', ARRAY['cash_flow_alert', 'compliance_due', 'monthly_close'], '07:00', 'haiku');

-- Deep memory bank (NEW — extends beyond learned_rules + ai_feedback_outcomes)
CREATE TABLE agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,         -- client, job, staff, supplier, suburb, process
  entity_id TEXT,                    -- FK reference (nullable for general observations)
  memory_type TEXT NOT NULL,         -- episodic, semantic, procedural, strategic
  content TEXT NOT NULL,
  context JSONB DEFAULT '{}',        -- structured metadata
  confidence NUMERIC(3,2) NOT NULL,
  source TEXT NOT NULL,              -- which tool/workflow created this
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMPTZ,
  decay_factor NUMERIC(3,2) DEFAULT 1.0,
  superseded_by UUID REFERENCES agent_memory(id),
  org_id TEXT DEFAULT 'secureworks',
  staff_scope TEXT,                  -- NULL = visible to all, 'nathan' = only Nathan's agent sees this
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agent_memory_entity ON agent_memory(entity_type, entity_id);
CREATE INDEX idx_agent_memory_type ON agent_memory(memory_type, confidence DESC);
CREATE INDEX idx_agent_memory_scope ON agent_memory(staff_scope) WHERE staff_scope IS NOT NULL;

-- Memory types:
-- EPISODIC: "Mrs. Johnson negotiated 10% off and paid same day" (specific event)
-- SEMANTIC: "Balcatta council requires 150mm setback for boundary fences" (factual knowledge)
-- PROCEDURAL: "Stratco deliveries to northern suburbs take 3 days, not 2" (process knowledge)
-- STRATEGIC: "Q1 is always slow for patios, push fencing marketing in Jan-Feb" (business intelligence)
```

### 1.3 — First Three Autonomous Workflows

**IMPORTANT: These orchestrate existing cron jobs and edge functions. They do NOT replace them.**

#### Workflow 1: Debt Chase (orchestrates existing eod-followup cron)
```
Trigger: Hooks into existing 'stale-followup' cron (9:00 AM AWST) via new action parameter
         OR agent-orchestrator detects overdue invoice during any query

Steps:
  1. Call reporting-api → get aged receivables (existing endpoint)
  2. For each overdue invoice:
     a. memory_recall('client', client_id, 'payment history and communication style')
     b. call_edge_function('reporting-api', { action: 'job_profitability', job_id })
     c. Classify: anomaly vs pattern based on memory + data
     d. Check action_permissions table for 'send_debt_reminder' autonomy level
     e. Draft message matching escalation stage (uses existing debt-escalation.md SOP)
     f. shouldAutoExecute() → true? Send via existing ops-ai send_sms/send_email tool
     g. shouldAutoExecute() → false? request_approval to Shaun via Telegram inline_keyboard
  3. Log to ai_reasoning_traces WITH workflow_id (extended column)
  4. Store payment behaviour observation in agent_memory
  5. Schedule follow-up via pg_cron or workflow_update with next check date
```

#### Workflow 2: Quote Follow-Up (orchestrates existing stale-followup cron)
```
Trigger: Hooks into existing 'stale-followup' cron (9:00 AM AWST)
         OR ghl-webhook detects quote viewed event

Steps:
  1. Query quotes with status 'sent' older than 48 hours (existing ops-api endpoint)
  2. For each stale quote:
     a. Check GHL webhook data for view events (existing ghl-webhook function logs these)
     b. memory_recall('client', client_id, 'purchase intent signals')
     c. Identify assigned salesperson from quote data
     d. Look up salesperson in staff_personas table
     e. Send personalised recommendation to their personal bot via send_staff_message
  3. If quote viewed 3+ times → flag as high intent, send with urgency
  4. memory_store: conversion pattern observation (what follow-up timing works)
```

#### Workflow 3: Completion Pack (orchestrates existing completion-pack edge function)
```
Trigger: Job status changed to 'completed' (business_events webhook)
         OR install lead messages in Telegram "job done" (existing telegram-bot detection)

Steps:
  1. call_edge_function('completion-pack', { action: 'check_readiness', job_id })
  2. If missing data → send_staff_message to install lead asking for photos/sign-off
  3. Wait for response (workflow_update status: 'paused', resume on Telegram callback)
  4. call_edge_function('completion-pack', { action: 'generate', job_id })
  5. Draft client thank-you message
  6. Check action_permissions for 'send_completion_pack' → auto or approve
  7. memory_store: completion quality observations
  8. Schedule 48-hour follow-up for review request
```

### 1.4 — Existing Cron Integration

**Do NOT create new cron jobs for these workflows.** Instead, add a new action parameter to existing crons:

```sql
-- EXISTING (keep as-is):
-- stale-followup: daily 9am AWST → daily-digest?action=stale_followup
-- eod-followup-5pm: weekdays 5pm AWST → daily-digest?action=eod_followup
-- eod-escalation-7pm: weekdays 7pm AWST → daily-digest?action=eod_followup
-- shaun-morning-brief: daily 7:30am AWST → daily-digest?action=shaun_brief

-- NEW (add these):
SELECT cron.schedule(
  'agent-workflow-trigger',
  '5 1 * * *',  -- 9:05 AM AWST (5 min after stale-followup, so data is fresh)
  $$SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/agent-orchestrator',
    body := '{"trigger": "morning_workflows", "workflows": ["debt_chase", "quote_followup"]}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
  )$$
);

SELECT cron.schedule(
  'agent-personal-briefs',
  '30 22 * * *',  -- 6:30 AM AWST (before first staff brief at 6:30)
  $$SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/agent-orchestrator',
    body := '{"trigger": "morning_briefs"}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
  )$$
);

SELECT cron.schedule(
  'agent-pattern-analysis',
  '0 6 * * 0',  -- Every Sunday 2:00 PM AWST
  $$SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/agent-orchestrator',
    body := '{"trigger": "pattern_analysis", "scope": "weekly"}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
  )$$
);
```

---

## Phase 2: Self-Improving Loop (Weeks 5–8)

### Goal
The agent observes patterns, generates SOPs, proposes code changes, and continuously improves itself — all with human approval gates.

### 2.1 — Pattern Detection Engine

Triggered by weekly cron (Sunday 2pm AWST). The agent analyses:
- `ai_feedback_outcomes` — what worked, what didn't (EXISTING, currently unpopulated)
- `ai_reasoning_traces` — decision patterns (EXISTING, extended with workflow_id)
- `business_events` — operational patterns from Telegram, webhooks (EXISTING)
- Xero sync data — financial patterns (EXISTING via xero-sync)
- `jobs` / `quotes` — conversion and completion patterns (EXISTING)

```sql
CREATE TABLE pattern_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_type TEXT NOT NULL,       -- timing, behaviour, financial, quality, process
  description TEXT NOT NULL,
  evidence JSONB NOT NULL,          -- statistical backing
  sample_size INTEGER NOT NULL,
  confidence NUMERIC(3,2) NOT NULL,
  recommendation TEXT,
  status TEXT DEFAULT 'observed' CHECK (status IN ('observed', 'sop_generated', 'code_proposed', 'implemented', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**IMPORTANT: Start populating `ai_feedback_outcomes` and `ai_reasoning_traces` NOW.** These tables exist but are empty. The pattern engine needs 4-6 weeks of data before it can detect meaningful patterns. Sprint 1 should include wiring the agent-orchestrator to log every decision to these tables.

### 2.2 — SOP Auto-Generation and Enforcement

Extends the existing `generate_sop` tool already in ops-ai:

```sql
CREATE TABLE sop_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  process_name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  steps JSONB NOT NULL,
  compliance_rules JSONB NOT NULL,
  metrics JSONB DEFAULT '{}',
  auto_enforce BOOLEAN DEFAULT false,
  source_pattern_id UUID REFERENCES pattern_observations(id),
  approved_by TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sop_compliance_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_id UUID REFERENCES sop_registry(id),
  action_type TEXT NOT NULL,
  compliant BOOLEAN NOT NULL,
  deviation_details TEXT,
  coaching_sent BOOLEAN DEFAULT false,
  coaching_channel TEXT,             -- telegram_dm, dashboard
  staff_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 2.3 — Self-Modification Pipeline

```sql
CREATE TABLE code_modifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_file TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_pattern_id UUID REFERENCES pattern_observations(id),
  change_spec TEXT NOT NULL,          -- what to change, in plain English (sent to Claude Code)
  diff_content TEXT,                  -- the actual diff (returned by Claude Code)
  plain_english_summary TEXT,         -- what Marnin sees in Telegram
  expected_improvement TEXT,
  status TEXT DEFAULT 'drafting' CHECK (status IN ('drafting', 'pending_review', 'approved', 'testing', 'deployed', 'rolled_back', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  test_results JSONB,
  rollback_diff TEXT,
  deployed_at TIMESTAMPTZ,
  before_metrics JSONB,
  after_metrics JSONB,
  rejection_reason TEXT,             -- stored so agent learns what NOT to propose
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**Guardrails (updated):**
- Max 3 proposals per day
- Can only modify: tool definitions, system prompts, threshold values in `action_permissions`, workflow configs
- Cannot modify: auth, database schema, infrastructure, billing, edge function core logic
- Every change has a rollback diff
- Kill switch: existing `org_settings.ai_paused` flag halts everything
- Rejection reasons stored → agent learns what changes get rejected and stops proposing similar ones

---

## Phase 3: Personal Staff Agents (Weeks 9–12)

### Goal
Individual Telegram bots per staff member. All configured via `staff_personas` database table (not hardcoded).

### 3.1 — New Edge Function: `personal-agent/index.ts`

Single edge function handles ALL personal agent messages. Reads config from `staff_personas` table:

```typescript
// supabase/functions/personal-agent/index.ts
//
// Entry point for all personal Telegram bot messages.
// Each bot token is registered as a separate webhook URL pointing here.
// The bot token in the request identifies which staff member.

// 1. Extract bot token from webhook
// 2. Look up staff_personas WHERE telegram_bot_token = token
// 3. Load their role, tools_allowed, persona_prompt, model_preference
// 4. Initialise Agent SDK session scoped to this staff member
// 5. Process message with role-appropriate tools
// 6. Persist session for next interaction

// For approval callbacks (inline_keyboard responses):
// 1. Parse callback_data (format: "approve:{workflow_id}" or "reject:{workflow_id}")
// 2. Update agent_workflows.status accordingly
// 3. Resume the paused workflow in agent-orchestrator
```

### 3.2 — Proactive Outreach

The agent reaches out when it detects relevant events. Triggers are configured per-staff in `staff_personas.proactive_triggers`:

```typescript
// Event routing logic (in agent-orchestrator):
async function routeProactiveEvent(supabase: any, eventType: string, eventData: any) {
  // Find all staff who want to know about this event type
  const { data: staff } = await supabase
    .from('staff_personas')
    .select('*')
    .contains('proactive_triggers', [eventType])
    .eq('active', true);

  for (const person of staff) {
    // Generate personalised message using their persona
    const message = await generateProactiveMessage(person, eventType, eventData);
    await sendTelegramDM(person.telegram_bot_token, person.telegram_user_id, message);
  }
}
```

### 3.3 — Personalised Morning Briefs

Triggered by `agent-personal-briefs` cron (6:30 AM AWST). For each staff member, generates a role-specific brief:

- **Marnin (admin):** Revenue vs target, decisions needed, code mods pending review, strategic anomalies
- **Shaun (division_ops):** Today's schedule, PO status, material deliveries, debt chases pending, crew issues
- **Nathan/Khairo (sales):** Pipeline status, hot leads (quotes viewed 3+), conversion trends, suggested actions
- **Henry/Isaac (lead_installer):** Today's job details, material status, weather, previous suburb/client notes from memory
- **Jan (admin):** Cash flow summary, compliance deadlines, flags only

The existing `shaun-morning-brief` cron continues working. The new personal briefs supplement it — Shaun gets both (existing group brief + personal DM brief).

---

## Phase 4: MCP Exposure & A2A Readiness (Weeks 13–16)

### Goal
Upgrade existing secureworks-ops MCP plugin (517 lines, 27 tools) into a full MCP server.

### 4.1 — Upgrade Path

The current plugin at `/secureworks-ops/servers/index.js` already wraps 5 edge function groups. Upgrade to:

- Expose agent-orchestrator tools via MCP (memory, workflows, SOPs)
- Add OAuth layer for external agent authentication
- Add rate limiting per connected agent
- Add SSE event streaming for real-time updates
- Add schema discovery so connecting agents auto-learn capabilities

### 4.2 — What This Enables

- Marnin's Claude (Cowork/Claude Code) queries SecureSuite directly via MCP
- Future accountant AI connects to financial data without custom integration
- Franchise operators (future) plug their own agent into the central system
- Any MCP-compatible tool can interact without writing integration code

---

## Competitive Moat Strategies

These are baked into the architecture, not bolted on later:

### Moat 1: Suburb Intelligence Network

Every job teaches the system about that suburb. After 50+ jobs in a suburb, the agent knows:
- Council requirements (setbacks, permits, heritage overlays)
- Soil type (sandy = deeper post holes = +15% labour)
- Typical property layouts and access issues
- Neighbour dynamics (shared fencing patterns)
- Delivery logistics (which suppliers deliver fastest to which areas)

**Implementation:** `agent_memory` with `entity_type = 'suburb'` and `memory_type = 'semantic'`. Populated automatically after every job completion. A competitor starting today is 1,200+ jobs behind on suburb knowledge.

### Moat 2: Supplier Price Intelligence

Track every price from Stratco, Metroll, Bondor across time, quantities, delivery windows:
- Which supplier gives better pricing at which volumes
- Which reps respond fastest
- Seasonal price patterns (steel price cycles, availability windows)
- Automated "best price" recommendation per material, per job size, per location

**Implementation:** Extends existing `material_price_ledger` table. Pattern detection engine analyses pricing trends weekly. Memory stores supplier behaviour observations.

### Moat 3: Prediction Engine (Future Product)

Once the agent can predict with statistical accuracy:
- Job duration (by type, suburb, crew, season)
- Material cost variance (actual vs quoted)
- Quote conversion probability (by follow-up pattern, client type, price point)
- Client lifetime value (by referral source, suburb, communication style)

This model becomes licensable. Other fencing/patio companies would pay for "what should I quote for a 30m Colorbond fence in Morley?"

**Implementation:** Pattern observations + memory bank accumulate the training data. No separate ML pipeline needed initially — the agent's context window IS the inference engine.

### Moat 4: Client Lifetime Value Scoring

Score every new lead on predicted lifetime value:
- Referral source quality (which channels produce repeat customers?)
- Suburb correlation (some suburbs = high-value repeat clients)
- Communication style signals (responsive clients = higher satisfaction = more referrals)
- Property type (multi-property owners, developers, body corps)

**Implementation:** `agent_memory` with `entity_type = 'client'` and `memory_type = 'strategic'`. Sales agents see the score when handling leads — prioritise high-CLV prospects.

### Moat 5: The Franchise Brain

If SecureWorks licenses the model or expands:
- New operator plugs in, gets 3,000+ jobs of accumulated intelligence from day one
- The agent IS the franchise manual, but it's alive and adapting
- SOPs are auto-enforced, not in a binder collecting dust
- Quality standards maintained by AI, not by franchisor audits

**Implementation:** Multi-tenancy on `agent_memory` (org_id column already in schema). New franchisees get a copy of suburb/supplier/process memories, but not client-specific data.

---

## Updated Build Order (Sprint-by-Sprint Claude Code Prompts)

### Sprint 1 (Week 1–2): Foundation

**Prompt 1 for Claude Code:**
```
Read the existing codebase:
- supabase/functions/ops-ai/index.ts (understand the AI brain, tools, CallerContext, resolveRole)
- supabase/migrations/20260316000005_intelligence_layer.sql (understand existing tables)
- supabase/migrations/20260322000012_phase2_cron_jobs.sql (understand existing crons)
- AUTONOMOUS-AGENT-BUILD-PLAN.md (the full plan)

Then:
1. Create migration file with: agent_workflows, staff_personas (with seed data), agent_memory tables
2. ALTER ai_reasoning_traces to add workflow_id, workflow_step, auto_executed columns
3. Create edge function: supabase/functions/agent-orchestrator/index.ts
   - Use @anthropic-ai/sdk (Claude Agent SDK)
   - Implement the agent loop with the tools defined in the plan
   - Wire execute_ops_query to call ops-ai via HTTP (same pattern as daily-digest calls ops-ai)
   - Wire call_edge_function as a generic edge function caller
   - Wire memory_recall and memory_store to read/write agent_memory table
   - Wire workflow_update to read/write agent_workflows table
   - Wire request_approval to send Telegram messages using the EXISTING inline_keyboard pattern from telegram-bot.ts
   - Use action_permissions table for auto-execution decisions (NOT hardcoded thresholds)
   - Log every decision to ai_reasoning_traces with workflow context

Acceptance criteria:
- Can receive a POST request and run a multi-turn agent loop
- Can call ops-ai and get a response
- Can store and recall memories
- Can create and update workflow state
- Logs all reasoning to ai_reasoning_traces
```

**Prompt 2 for Claude Code:**
```
Wire the agent-orchestrator to handle Telegram approval callbacks.

Read:
- supabase/functions/telegram-bot/index.ts (find the inline_keyboard and callback_query handling pattern)
- supabase/functions/agent-orchestrator/index.ts (what you just built)

Add:
1. A callback handler in agent-orchestrator that receives approval/rejection from Telegram
2. When approved: resume the paused workflow (update agent_workflows.status = 'running')
3. When rejected: cancel the workflow, log reason
4. Send confirmation message back to the staff member

Use the SAME inline_keyboard button format as telegram-bot.ts already uses.
```

### Sprint 2 (Week 3–4): Autonomous Workflows

**Prompt 3 for Claude Code:**
```
Read:
- AUTONOMOUS-AGENT-BUILD-PLAN.md (the workflow definitions in Phase 1.3)
- supabase/functions/agent-orchestrator/index.ts
- supabase/functions/reporting-api/index.ts (find the aged receivables and job profitability endpoints)
- supabase/functions/daily-digest/index.ts (find the stale_followup and eod_followup action handlers)
- docs/project-knowledge/edge-functions.md (API reference)

Implement the debt_chase workflow in agent-orchestrator:
1. Query aged receivables from reporting-api
2. For each overdue invoice:
   - Call memory_recall for client payment history
   - Classify as anomaly vs pattern
   - Check action_permissions for 'send_debt_reminder'
   - Draft message matching escalation stage
   - Auto-send if shouldAutoExecute() returns true
   - Otherwise request_approval to Shaun
3. Log everything to ai_reasoning_traces with workflow context
4. Store payment behaviour observation in agent_memory

Add the agent-workflow-trigger cron job (9:05 AM AWST, 5 min after existing stale-followup).

Acceptance criteria:
- Workflow runs end-to-end on test data
- Approval cards appear in Telegram with correct inline_keyboard
- All steps logged with workflow_id
- Memories stored for client payment patterns
```

**Prompt 4 for Claude Code:**
```
Implement quote_followup and completion_pack workflows using the same pattern as debt_chase.

Read the workflow definitions in AUTONOMOUS-AGENT-BUILD-PLAN.md Phase 1.3.

For quote_followup:
- Hook into GHL webhook events (check ghl-webhook/index.ts for quote_viewed events)
- Route recommendations to the assigned salesperson's future personal bot (for now, use existing Telegram group)

For completion_pack:
- Trigger on job status change to 'completed'
- Call existing completion-pack edge function
- Handle the "missing data" pause → resume flow via Telegram callbacks
```

### Sprint 3 (Week 5–6): Memory + Patterns

**Prompt 5 for Claude Code:**
```
Read:
- AUTONOMOUS-AGENT-BUILD-PLAN.md (Phase 2.1 Pattern Detection Engine)
- supabase/functions/agent-orchestrator/index.ts

1. Create migration: pattern_observations table
2. Implement the weekly pattern analysis workflow:
   - Query ai_feedback_outcomes for the past week
   - Query ai_reasoning_traces for decision patterns
   - Query business_events for operational patterns
   - Use Claude to analyse and identify recurring patterns
   - Store observations in pattern_observations
   - If confidence > 0.8, flag for SOP generation
3. Add the agent-pattern-analysis cron job (Sunday 2pm AWST)
4. CRITICAL: Start populating ai_feedback_outcomes from all agent-orchestrator actions
   - After every workflow step, log the outcome
   - After every approval/rejection, log the human action

Seed initial memories into agent_memory from existing data:
- Client payment patterns from xero sync history
- Suburb knowledge from completed jobs (group by suburb, extract patterns)
- Supplier delivery times from PO history
```

### Sprint 4 (Week 7–8): Self-Improvement

**Prompt 6 for Claude Code:**
```
Read:
- AUTONOMOUS-AGENT-BUILD-PLAN.md (Phase 2.2 and 2.3)

1. Create migration: sop_registry, sop_compliance_log, code_modifications tables
2. Extend agent-orchestrator with:
   - SOP generation: when pattern_observations.status = 'observed' and confidence > 0.8, generate SOP using ops-ai's existing generate_sop tool, store in sop_registry
   - SOP enforcement: sop_check tool validates actions against active SOPs before execution
   - Non-compliance coaching: send private Telegram message to staff member (not public)
3. Implement propose_code_change tool:
   - Generates a change specification from pattern evidence
   - Stores in code_modifications with status 'pending_review'
   - Sends Marnin a Telegram message with: what changed, why, evidence, [Approve] [Reject] buttons
   - If rejected, stores rejection_reason for future learning
4. Rate limit: max 3 code modification proposals per day

DO NOT implement the actual Claude Code API call yet (that's a future integration).
For now, the propose_code_change tool creates the spec and notifies Marnin. Actual code generation is manual.
```

### Sprint 5 (Week 9–10): Personal Agents Phase 1

**Prompt 7 for Claude Code:**
```
Read:
- AUTONOMOUS-AGENT-BUILD-PLAN.md (Phase 3)
- supabase/functions/telegram-bot/index.ts (existing Telegram patterns)
- The staff_personas table schema and seed data

1. Create edge function: supabase/functions/personal-agent/index.ts
   - Single function handles ALL personal agent Telegram webhooks
   - Identifies staff member from bot token in webhook
   - Reads staff_personas for role, tools_allowed, persona_prompt, model_preference
   - Initialises Agent SDK session scoped to this person
   - Processes message with role-appropriate tools only
   - Handles inline_keyboard callbacks for approval flows
2. Implement personalised morning briefs:
   - agent-personal-briefs cron triggers agent-orchestrator
   - For each staff member in staff_personas with morning_brief_time:
     - Generate role-specific brief content
     - Send via their personal bot
3. Wire proactive outreach:
   - When business_events match a staff member's proactive_triggers, notify them

Start with Marnin + Shaun only. Other staff in Sprint 6.

Acceptance criteria:
- Marnin DMs his bot, gets CEO-level response with full tool access
- Shaun DMs his bot, gets ops-scoped response
- Both get personalised morning briefs at configured times
- Proactive messages sent when matching events occur
```

### Sprint 6 (Week 11–12): Personal Agents Phase 2
```
Create Telegram bots for Nathan, Khairo, Henry, Isaac, Jan via BotFather.
Update staff_personas with their bot tokens and Telegram user IDs.
Test each agent end-to-end.
Monitor token usage and optimise model selection.
```

### Sprint 7 (Week 13–14): MCP Server
```
Upgrade secureworks-ops/servers/index.js:
- Add agent-orchestrator tools to MCP endpoints
- Add OAuth authentication for external agents
- Add rate limiting
- Add SSE event streaming
- Add schema discovery endpoint
Test: external Claude connects via MCP and queries SecureSuite.
```

### Sprint 8 (Week 15–16): Hardening
```
Load testing all autonomous workflows.
Error recovery testing (step fails mid-workflow).
Rollback testing for any self-modifications.
Token usage optimisation.
Production deployment checklist.
```

---

## Guardrails & Safety

- **Kill switch**: existing `org_settings.ai_paused` flag halts ALL autonomous behaviour instantly
- **Approval thresholds**: driven by `action_permissions` table (configurable per action, not hardcoded)
- **Code modification limit**: max 3 proposals/day, scope limited to tools + prompts + thresholds
- **Rollback**: every self-modification stores a rollback diff
- **Audit trail**: every action logged to `ai_reasoning_traces` with workflow context
- **Rate limiting**: personal agents rate-limited per staff member
- **Scope isolation**: each staff agent can only access tools listed in their `staff_personas.tools_allowed`
- **Memory access control**: `staff_scope` column on `agent_memory` restricts private memories
- **Memory decay**: unused memories fade over time (decay_factor), preventing stale context
- **Rejection learning**: agent stores rejection reasons and avoids proposing similar changes
