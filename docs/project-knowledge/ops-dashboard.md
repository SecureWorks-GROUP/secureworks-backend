# Ops Dashboard (ops.html)

## Status: LIVE
**File**: `dashboard/ops.html`
**User**: Shaun (Operations Manager)
**Auth**: Supabase magic link
**API**: `ops-api` edge function (--no-verify-jwt)

## 5 Tabs
1. **Today** — AI morning brief, attention items (actionable), today's assignments, upcoming week
2. **Calendar** — Full calendar view, crew assignments, drag scheduling, crew utilisation sidebar
3. **Jobs** — Job list with filters, slide-out detail panel, status pipeline, scope data
4. **Financials** — Job P&L, PO tracking, invoice status, Xero push
5. **Materials** — PO creation, supplier list, delivery tracking, scope-to-PO extraction

## Key Features
- AI chat sidebar (Claude sonnet via ops-ai)
- Morning brief (auto-generated, 30-min cache)
- Actionable attention items (click to schedule/invoice/create PO)
- Complete + Invoice cascade (mark job complete → auto-create Xero invoice)
- Scope-to-PO material extraction (auto-populates PO from scope_json)
- Assignment completion cascade (complete buttons, prompt when all done)
- Crew utilisation (bar chart, colour-coded green/amber/red)

## ops-api Actions
See edge-functions.md for full list. Key ones:
- `schedule`, `update_assignment`, `delete_assignment` — calendar CRUD
- `create_po`, `update_po`, `push_po_to_xero` — purchase orders
- `create_wo`, `update_wo` — work orders
- `job_detail` — full job data with assignments, POs, WOs, scope, invoices
- `morning_brief` — AI-generated daily summary
- `complete_and_invoice` — compound action (mark complete + Xero invoice)
- `scope_to_po` — extract materials from scope_json into PO line items

## Data Quality Issues (audit 3 March 2026)
- **site_suburb/site_address**: NULL on 100% of jobs — location features non-functional
- **scope_json**: empty on all jobs — scope-to-PO extraction has no data yet
- **pricing_json**: GHL totals only (no line items) — cascade creates single-line Xero invoices
- **137 legacy jobs**: bulk-moved from `complete` → `invoiced` (GHL imports, already invoiced via Tradify)
- **Attention items**: "not_invoiced" now includes `job_ids` for click-to-action (was missing)

## ops-ai Edge Function (AI Chat Backend)
- **File**: `supabase/functions/ops-ai/index.ts` (~595 lines)
- **Model**: claude-sonnet-4-6 with tool_use (max 5 tool rounds)
- **Dual context**: `view: 'ops'` (9 tools) or `view: 'ceo'` (7 tools)
- **Ops tools**: search_jobs, get_schedule, get_job_detail, search_invoices, get_attention_items, create_assignment, update_job_status, complete_and_invoice, draft_communication
- **CEO tools**: get_dashboard_summary, get_job_profitability, get_marketing_summary, get_trends, get_sales_breakdown, search_invoices, get_debt_followup
- **Write actions require confirmation**: create_assignment, update_job_status, complete_and_invoice return action cards — frontend shows Confirm/Cancel buttons
- **Auto-context**: pulls ops_summary (ops view) or dashboard_summary (ceo view) into system prompt
- **Calls ops-api and reporting-api internally** via service role key
- **Conversation**: last 20 messages sent, localStorage stores last 50

## Chat Sidebar (Frontend)
- Present on both `ops.html` and `ceo.html`
- Floating FAB button (bottom-right, branded orange)
- 400px slide panel with markdown rendering
- Quick prompts (ops: morning brief, attention, stale invoicing, schedule; ceo: month summary, margins, overdue AR, type analysis)
- Action cards for write ops with Confirm/Cancel
- localStorage persistence: `sw_ops_chat` / `sw_ceo_chat`

## Assignment Cascade Flow (Feature 6)
1. Job detail panel shows "Complete" button next to each non-complete assignment
2. `markAssignmentComplete()` calls `opsPost('update_assignment', {status:'complete'})`
3. Backend checks if ALL assignments for that job are now complete
4. If yes, returns `{all_complete: true, suggest_status: 'complete'}`
5. Frontend shows toast: "All assignments complete — mark job as complete?"
6. Three options: Complete + Invoice (opens cascade modal) | Complete Only | Not Yet

## Depends On
- `ops-ai` edge function for chat + morning brief (needs ANTHROPIC_API_KEY secret — NOT SET YET)
- `ops-api` edge function for all data (deploy with --no-verify-jwt)
- Supabase auth for login (magic link)
