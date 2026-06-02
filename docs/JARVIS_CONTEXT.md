# JARVIS Platform Context — Single Source of Truth

> Last updated: 2026-04-06 by Terminal (Claude Code)
> Notion Mission Control: https://www.notion.so/33a9fef56a4d81ae8814d81313007f6c

Any AI agent working on SecureWorks reads this FIRST before writing code.

---

## Architecture Overview

```
                    Telegram
                       |
                 telegram-bot (2214 lines)
                  /          \
          Railway Agent    Supabase ops-ai (3970 lines)
          (97 MCP tools)      |
                |         [Claude API + tool loop]
                |              |
            ops-api ──────── reporting-api ──── daily-digest
           (12,176 lines)   (3,548 lines)    (4,568 lines)
                |              |                  |
           Supabase DB    xero-sync          pg_cron jobs
                |          (2,367 lines)
            ghl-proxy
           (2,316 lines)
```

### Edge Functions (19 total, 39,038 lines)

| Function | Lines | What It Does | External APIs |
|----------|-------|-------------|---------------|
| **ops-api** | 12,176 | Job CRUD, pipeline, scheduling, invoicing, POs, WOs, council, variations | Supabase |
| **daily-digest** | 4,568 | Morning brief, financial snapshots, nudges, weekly letter | Claude API, Telegram |
| **ops-ai** | 3,983 | AI chat with 60+ tools, multi-round tool loop, confirmation flow, conversation memory | Claude API (Anthropic) |
| **reporting-api** | 3,548 | Financial reports, debt followup, CEO report, sales summary, profitability, team_activity | Supabase, Xero data |
| **send-quote** | 3,147 | Quote PDF generation, email delivery, acceptance tracking | Resend API, GHL |
| **xero-sync** | 2,367 | Invoice sync, bank balance, aged payables from Xero | Xero API |
| **telegram-bot** | 2,312 | Telegram message handling, classification, tone rewrite, action cards | Claude API, Telegram API |
| **ghl-proxy** | 2,316 | GoHighLevel CRM proxy — contacts, opportunities, pipelines, SMS, email | GHL API |
| **agent-runner** | 1,025 | Railway agent runner for MCP tools | Railway, Claude API |
| **completion-pack** | 836 | Branded HTML completion report generator | GHL |
| **ghl-webhook** | 611 | GHL opportunity sync on stage changes | GHL webhook |
| **receive-po-email** | 549 | Inbound PO email processing, supplier quote analysis | Resend webhook |
| **monitor-inbox** | 329 | Graph inbox polling, Haiku classification, Telegram alerts | Microsoft Graph, Claude API |
| **send-po-email** | 301 | PO email via Resend with thread tracking | Resend API |
| **resend-webhook** | 287 | Email delivery tracking (sent, opened, bounced) | Resend webhook |
| **send-outlook-email** | 245 | Microsoft Graph email sending with signature, CC, attachments | Microsoft Graph |
| **google-ads-ingest** | 157 | Google Ads spend/conversion import | Google Ads API |
| **system-health** | 146 | Health check endpoint | Supabase |
| **sql-query** | 91 | Direct SQL query endpoint for Cowork | Supabase |

### Key Database Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| **jobs** | All jobs (fencing, patio, decking) | id, job_number, client_name, status, pricing_json, scope_json |
| **job_assignments** | Crew scheduling | job_id, user_id, scheduled_date |
| **job_events** | Activity timeline | job_id, event_type, detail_json |
| **purchase_orders** | Material POs | job_id, supplier_name, status, total |
| **work_orders** | Work order tracking | job_id, description, status |
| **xero_invoices** | Synced from Xero | invoice_number, contact_name, amount_due, status |
| **xero_projects** | Xero project financials | job_id, total_invoiced, total_expenses |
| **contact_matches** | GHL↔Xero contact linking | ghl_contact_id, xero_contact_id, phone, email |
| **aged_receivables** | VIEW: overdue invoice bucketing | age_bucket (current, 1-30, 31-60, 61-90, 90+) |
| **council_submissions** | Council/permit tracking | job_id, overall_status, steps |
| **variations** | Scope change requests | job_id, status, amount |
| **payment_chase_logs** | Debt chase history | xero_invoice_id, method, outcome |
| **ai_feedback_outcomes** | AI action approval/rejection tracking | feedback_category, human_action |
| **learned_rules** | AI business rules (confirmed) | rule_type, description, confidence |
| **ai_annotations** | Proactive AI flags on jobs | entity_type, annotation_type, message |
| **business_events** | CloudEvents audit log | event_type, entity_id, payload |
| **chat_logs** | Conversation Q&A logging | query, response, channel, user_email |
| **conversation_sessions** | NEW: 30-min session tracking | user_id, channel, last_activity_at |
| **conversation_history** | NEW: Full message persistence | session_id, role, content, tool_calls |
| **inbox_events** | NEW: Email inbox monitoring | graph_message_id, classification, priority |
| **users** | Team members | name, email, telegram_id, role |
| **pending_confirmations** | Telegram action approval queue | action_type, action_payload, status |
| **financial_snapshots** | Daily pre-computed financials | snapshot_date, revenue_mtd, outstanding |
| **material_price_ledger** | Supplier price tracking | supplier_name, material_code, unit_price |
| **org_config** | Business targets/settings | config_key, config_value |
| **po_communications** | Supplier email threads | job_id, direction, message_id, thread_id |
| **email_events** | Outbound email delivery tracking | recipient, status, sent_at |
| **jarvis_event_log** | Action dedup + audit trail for JARVIS actions | action_type, action_key, channel, dedup_window |

### Integration Credentials (locations, NOT values)

| Service | Where Stored |
|---------|-------------|
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Supabase edge function env |
| Anthropic (Claude) | `ANTHROPIC_API_KEY` — Supabase secrets |
| Telegram | `TELEGRAM_BOT_TOKEN` — Supabase secrets |
| GoHighLevel | GHL API key in ghl-proxy env, `GHL_LOCATION_ID` |
| Xero | OAuth tokens in `xero_tokens` table, refreshed by xero-sync |
| Microsoft Graph | `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` — Supabase secrets |
| Railway Agent | `RAILWAY_AGENT_URL`, `SW_API_KEY` — Supabase secrets |
| Resend (email) | `RESEND_API_KEY` — Supabase secrets (DNS blocked by marketing agency) |

### Routing Architecture

```
Telegram message arrives
  → telegram-bot classifies (Haiku)
  → Business? → askOpsAi() → RAILWAY_AGENT_URL (if set) or Supabase ops-ai
  → Banter? → freestylePersonality() (Sonnet, no tools)
  → Response → rewriteTone() (Sonnet) → send to Telegram
```

**Database:** 92 migrations applied (2025-03-01 to 2026-04-06).

**CRITICAL:** `RAILWAY_AGENT_URL` IS SET. Telegram business messages go to Railway, not Supabase ops-ai. Conversation memory was built in ops-ai but only works because telegram-bot now injects chat_logs history into the messages array before sending to Railway.

---

## What's Been Built (This Session: 2026-04-05/06)

### Batch 1 Fixes (deployed)
- Token bloat: stripped scope_json/pricing_json from 4 endpoints (11.4M → ~1.5M)
- Actionability: search_contacts tool, debt_followup search param, action execution prompt
- Data accuracy: /overdue bug (wrong column), $0 values (wrong field name), test data filter
- Email monitoring: monitor-inbox function, inbox_events table, pg_cron every 5 min

### Batch 2 Fixes (deployed)
- 14 missing tool definitions added to ops-ai
- Job number added to pipeline search (was missing)
- GHL fallback on search (auto-search GHL when Supabase empty)
- Action cards extended to create_work_order, send_review_request
- SIMPLE_TOOLS expanded from 6 to 17

### Conversation Memory (deployed)
- conversation_sessions + conversation_history tables
- 30-min session timeout, 5 most recent messages
- History injected as proper Claude message pairs (not system prompt text)
- telegram-bot saves Q&A to chat_logs + passes history to agent
- Pronoun resolution works: "What's his email?" after discussing someone resolves correctly

### JARVIS Persona (deployed)
- Complete rewrite from casual Australian bro → Tony Stark's JARVIS
- Sophisticated, precise, dry wit, addresses Marnin as "sir"
- All error messages updated, freestyle personality refined
- Business keyword routing expanded (20+ new keywords, 15-word length check)

### Sprint 1 Sweep (2026-04-06)
- GHL conversations fix verified working (Cowork confirmed)
- Contact data cleanup: 3 dupes fixed, suburbs standardised, 3 Xero-GHL links created
- Action dedup gate: 24hr on payment links, 10-min content-aware on SMS
- jarvis_event_log table created + wired into 4+ action handlers
- search_contacts GHL endpoint: new /contacts/ API call (was searching opportunities)
- Response size fixes: listOverdueInvoices, calendarEvents, salesPipeline, jobProfitability all stripped
- team_activity endpoint added to reporting-api
- monitor-inbox 401 auth fix (relaxed for pg_cron)
- job_number→UUID auto-resolution in jobDetail

---

## Known Issues & Tech Debt

| Issue | Severity | File | Notes |
|-------|----------|------|-------|
| Proposed actions queue always empty | P1 | ops-api | sw_list_proposed_actions returns nothing — no generation engine |
| Resend email blocked | P1 | send-po-email | DNS controlled by marketing agency, can't add MX records |
| Railway agent has no conversation memory | P2 | Railway | Memory only works because telegram-bot injects history |
| monitor-inbox MARNIN_TELEGRAM_ID | P3 | monitor-inbox | Uses users table lookup, needs role column verification |
| Xero bank transactions sync | P3 | xero-sync | Column mismatch, non-critical |
| Google Ads UTM tracking | P2 | blocked | Marketing team needs to configure GHL forms |
| financial_snapshots raw JSON | P3 | daily-digest | executive_summary has markdown fences from Claude output |

---

## Monthly Cost

~$36-38/month total:
- Supabase Pro: $25
- Claude API: ~$8-10 (Sonnet for chat, Haiku for classification/evaluation)
- Haiku classifier/evaluator/nudges: ~$2.70

---

## pg_cron Jobs

| Schedule | Job | Function |
|----------|-----|----------|
| `0 23 * * *` (7am AWST) | Daily digest | trigger_daily_digest() |
| `0 3,7,11 * * *` | Nudge check | 11am/3pm/7pm AWST |
| `*/5 * * * *` | Inbox monitor | trigger_monitor_inbox() |
| `0 19 * * *` (3am AWST) | Cleanup conv history | DELETE older than 14 days |
| `0 19 * * 0` (3am Sun AWST) | Cleanup conv sessions | DELETE older than 90 days |
| `* * * * *` | Queue processor | process_outbound_queue() |

---

## Railway Agent (~/Projects/secureworks-agent/)

**This is a 17K-line autonomous agent, NOT just a tool proxy.**

| Module | Lines | Purpose |
|--------|-------|---------|
| mcp-server.ts | 1,468 | 97 sw_* tool definitions |
| agent.ts | 536 | Multi-turn autonomous agent |
| orchestrator/ | 1,387 | Decision routing, safety rules |
| monitoring/ | 2,614 | Email/GHL/Telegram watchers, audit rules |
| memory/ | 1,159 | Prompt cache, retrieval, scoring |
| jobs/ | 1,183 | Job state machine, scope validator |
| channels/ | 1,002 | Telegram, Email, Graph clients |
| automation/ | 725 | Cron scheduler, brief aggregator |
| sop/ | 766 | Standard Operating Procedures |
| personas/ | 369 | Personality configs per user |
| intelligence/ | 334 | Cross-thread context |
| context/ | 274 | Person context builder |
| triage/ | 142 | Email classifier |
| subagents/ | 108 | Ops/Sales/Finance delegations |

**CRITICAL:** This agent and ops-ai are PEERS. Both have tool loops, both call Claude. Telegram routes to Railway (via RAILWAY_AGENT_URL). Dashboard routes to Supabase ops-ai. Changes to one don't affect the other unless explicitly synced.

---

## Scattered Planning Documents

| Document | Path | Status |
|----------|------|--------|
| AI Implementation Roadmap | `docs/ai-implementation-roadmap.md` | Current (7-phase build spec) |
| Data Architecture Spec | `docs/data-architecture-spec.md` | Definitive (6-layer, CloudEvents) |
| Autonomous Agent Research | `docs/research-autonomous-ai-agent.md` | Current (600+ lines, L0-L4 autonomy) |
| System Upgrade Plan | `docs/strategy/SYSTEM-UPGRADE-PLAN.md` | Active (3 flywheels, 90-day plan) |
| Business Context | `docs/strategy/SECUREWORKS-BUSINESS-CONTEXT.md` | Current ($5.5M target) |
| Autonomous Agent Build Plan | `AUTONOMOUS-AGENT-BUILD-PLAN.md` | v2 corrected (agent SDK strategy) |
| Phase 2 Handoffs | `PHASE2_HANDOFFS.md` | Build spec (terminal handoffs) |
| Design Brief | `SECUREWORKS-DESIGN-BRIEF.md` | Current (Architectural Assurance) |
| Project Knowledge Base | `docs/project-knowledge/*.md` | 7 subdocs (architecture, schema, GHL, gotchas) |

---

## Project Map

| Project | Path | Deployed On |
|---------|------|-------------|
| Edge Functions | `~/Projects/secureworks-site/supabase/functions/` | Supabase |
| Dashboards (CEO, Ops, Trade) | GitHub: `SecureWorks-GROUP/secureworks-ux` | GitHub Pages |
| Sale Dashboard | GitHub: `SecureWorks-GROUP/secureworks-sale` | GitHub Pages |
| Patio Scoping Tool | `~/Projects/patio-tool/` | GitHub Pages |
| Fencing Scoping Tool | GitHub: `SecureWorks-GROUP/fence-designer` | GitHub Pages |
| Astro Website | `~/Projects/secureworks-website/` | Cloudflare Pages |
| Marketing Generator | `~/Projects/secureworks-marketing/` | Not deployed |
| Railway MCP Agent | Railway | Railway (production) |

---

## Mandatory Pre-Work Checks

Before editing any git-tracked project:
1. `git fetch origin && git pull origin main`
2. Resolve conflicts before starting
3. After finishing: commit + push (live versions run from GitHub Pages / Supabase)
4. Deploy edge functions: `supabase functions deploy <name> --no-verify-jwt`
