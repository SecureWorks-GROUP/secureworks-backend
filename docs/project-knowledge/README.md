# Job Management System — Knowledge Base

> **ACTIVE PLAN:** The system upgrade roadmap is at **`SYSTEM-UPGRADE-PLAN.md`** (project root).
> That is the authoritative document for what's being built. These docs describe the current system as-is.

This folder documents the **Job Management System** — the CEO/Ops/Trade dashboards, edge functions, database, and sync layer. It does NOT cover websites, lookbooks, or scoping tools (those are documented elsewhere — see MEMORY.md).

## How to Use
1. **Start here**: Read `SYSTEM-UPGRADE-PLAN.md` at project root — it has the full 90-day build plan
2. **Then read**: The files below to understand the current system you're modifying
3. **After making changes**: Update the relevant files with what you built/changed
4. **New patterns/gotchas**: Add them so other instances don't repeat mistakes

## File Index
| File | What's In It | Status |
|------|-------------|--------|
| `architecture.md` | System architecture, tech stack, data flows, key IDs | Current |
| `sync-layer.md` | GHL ↔ Xero sync: job numbers, contacts, invoice matching | Current — will expand with Xero Projects auto-creation (Plan Week 2) and PO sync (Week 6) |
| `current-state.md` | Live data numbers, match rates, revenue, AR, what works/broken | Snapshot from 3 March — update when data changes |
| `ops-dashboard.md` | Ops dashboard: 5 tabs, features, AI chat, cascades | Current — Daily Huddle view and materials gate coming (Plan Weeks 6-8) |
| `trade-app.md` | Trade mobile app: PWA, endpoints, receipts, signatures | Current — cross-sell fields and materials status coming (Plan Weeks 6, 9) |
| `edge-functions.md` | All 9 edge functions, actions, deploy commands | Current — ops-api split into ops-api + trade-api planned (Plan Week 12) |
| `database-schema.md` | Migrations 001-015, key tables, views, sequences, functions | Current — Migration 016+ adds 5 new tables (see Plan) |
| `ghl-integration.md` | GHL pipelines, scoping tool integration, auth | Current — GHL MCP server integration planned (Plan Week 10) |
| `GHL_WORKFLOW_SETUP.md` | GHL workflow configuration for bidirectional sync | Current |
| `gotchas.md` | Bugs, things that break, workarounds — READ THIS FIRST | Current |
| `dashboard-spec.md` | CEO dashboard design spec, metrics, layout | Reference — only subset being built in 90-day plan |

## Archived
| File | Why |
|------|-----|
| `archive/AUDIT-2march.md` | Gap analysis from 2 March — claims "FIXED" items that were still broken. Superseded by SYSTEM-UPGRADE-PLAN |
| `archive/DASHBOARD_RESEARCH-presynthesis.md` | 6,500-line research dump — synthesised into SYSTEM-UPGRADE-PLAN and Obsidian research briefs |

## Rules
- Keep files focused and concise
- Update `current-state.md` when data numbers change
- Always add new gotchas to `gotchas.md`
- Don't duplicate info across files — link instead
- **SYSTEM-UPGRADE-PLAN.md** is the single source of truth for what to build

## What's NOT Here
- **Websites** (landing pages): See `CLAUDE.md` at project root + `*-strategy.md` files
- **Lookbooks** (sales materials): See `LOOKBOOK-*.md` files at project root
- **Scoping Tools** (GitHub Pages apps): See `tools/shared/` code + `reference/` folder
- **General business context**: See `SECUREWORKS-BUSINESS-CONTEXT.md` at project root
- **Research briefs**: See Obsidian vault at `~/Library/Mobile Documents/.../WEBSITE RESEARCH/research-briefs/`
