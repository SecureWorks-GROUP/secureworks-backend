# Database Schema

## Migrations (in `supabase/migrations/`)
| # | File | What |
|---|------|------|
| 001 | Core schema | organisations, users, jobs, documents, media, events, job_assignments |
| 002 | GHL link | ghl_opportunity_id on jobs |
| 003 | Reporting | xero_tokens, xero_invoices, xero_reports, google_ads_daily, contact_matches, webhook_log + views |
| 004 | pg_cron | Token refresh, invoice sync, report sync, contact matching schedules |
| 005 | Digests | daily_digests, org_config tables |
| 006 | Projects | xero_projects table |
| 007 | Granular ads | ad_group fields, google_ads_keywords, google_ads_landing_pages |
| 008 | CEO targets | org_config entries for revenue/margin/jobs/marketing/pipeline targets |
| 009 | More KPIs | DSO, cycle time, cost-to-revenue, concentration, win rate targets + sync pg_cron |
| 010 | Ops Dashboard | Extended job_assignments, purchase_orders, work_orders, suppliers, calendar_events view, jobs_needing_scheduling view, PO/WO sequences |
| 011 | Trade | Service reports |
| 012 | Job numbering | job_number_seq (starts 25000), job_number/xero_contact_id/xero_quote_id on jobs, next_job_number() function, expanded type constraint |
| 013 | Time tracking | started_at, completed_at on job_assignments |
| 014 | Share token | share_token (unique, auto-generated) on job_service_reports for public report links |
| 015 | Receipt media | 'receipt' added to job_media.phase constraint, po_id FK column on job_media → purchase_orders |
| 016+ | **PLANNED** | System upgrade — see `SYSTEM-UPGRADE-PLAN.md` for full SQL. Adds: `job_stage_history`, `scorecard_history`, `ids_issues`, `audit_log` tables. Adds `xero_project_id`, `materials_status`, `cross_sell_json` columns to `jobs`. Adds `material_categories` to `suppliers`. |

## Key Tables
- **jobs** — central entity. Has: client_name, site_address, status, type, scope_json, pricing_json, job_number, xero_contact_id, ghl_opportunity_id, ghl_contact_id
- **job_assignments** — scheduling. Links jobs to users with dates, times, crew, status, started_at, completed_at
- **job_service_reports** — trade sign-off. checklist_json, notes, signature_data (base64 PNG), signature_name, share_token, status (draft/submitted/approved)
- **job_media** — photos/videos. phase: scope/in_progress/completion/receipt. po_id (nullable FK) for receipt photos linked to POs
- **xero_invoices** — synced from Xero. Has: invoice_type (ACCREC/ACCPAY), contact_name, xero_contact_id, reference, job_id, amounts
- **xero_projects** — per-project P&L from Xero Projects API
- **contact_matches** — links GHL contacts to Xero contacts. Has: ghl_contact_id, xero_contact_id, email, phone, client_name, lead_source, gclid
- **purchase_orders** — POs linked to jobs
- **work_orders** — WOs with share tokens for external trades
- **suppliers** — cached Xero supplier contacts
- **org_config** — key-value config (targets, settings)
- **webhook_log** — audit trail for all sync operations

## Key Views
- **calendar_events** — joins assignments + jobs + users for calendar rendering
- **jobs_needing_scheduling** — accepted/quoted jobs with no future assignments

## Key Functions
- **next_job_number(job_type)** — generates SWP-25001, SWF-25002, etc.
- **update_updated_at()** — trigger function for updated_at columns
- **auth_org_id()** — RLS helper, gets org_id from JWT

## Sequences
- `job_number_seq` — starts at 25000 (above Tradify max ~SW23324)
- `po_number_seq` — purchase order numbers
- `wo_number_seq` — work order numbers
