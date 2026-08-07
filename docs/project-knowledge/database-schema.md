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
- **jobs** — central entity. Has: client_name, site_address, site_suburb, status, type, scope_json, pricing_json, job_number, xero_contact_id, ghl_opportunity_id, ghl_contact_id. Note the live names: `site_address`/`site_suburb`/`type`, NOT `address`/`suburb`/`job_type`.
  - **quoted_value** (added `20260717000001`) — `numeric`, `GENERATED ALWAYS AS ... STORED` over `pricing_json` (`totalIncGST`, falling back to `totalIncGst` / `total_inc_gst`). Read-only: Postgres maintains it, so any INSERT/UPDATE naming it is rejected — write `pricing_json` instead. Null where the blob carries no total key. Apply the migration before deploying any function that selects it — as of 2026-07-20 it is NOT applied in production (a read-only check returned `42703`), so the four `daily-digest` reads that select it are 400ing today and their sections silently report zero. That is also why `ops-api?action=pipeline` derives its value from `pricing_json` JSON paths rather than from this column.
- **job_assignments** — scheduling. Links jobs to users with dates, times, crew, status, started_at, completed_at. Also carries **is_ghost** (`boolean NOT NULL DEFAULT false`) — live drift, in no repo migration. Ghost rows (in practice always `role:'observer'`) mirror a job onto an ops manager's list and are never rescheduled, so they keep stale dates; the `calendar_events` view and every `my_jobs` feed read exclude them with `is_ghost = false` (see `docs/evidence/trade-feed-ghost-row-source-exclusion-2026-08-06.md`).
- **job_service_reports** — trade sign-off. checklist_json, notes, signature_data (base64 PNG), signature_name, share_token, status (draft/submitted/approved)
- **job_media** — photos/videos. phase: scope/in_progress/completion/receipt. po_id (nullable FK) for receipt photos linked to POs
- **xero_invoices** — synced from Xero. Has: invoice_type (ACCREC/ACCPAY), invoice_date, fully_paid_on, contact_name, xero_contact_id, reference, job_id, amounts. There is no `type`, `date` or `fully_paid_on_date` column — selecting those 400s the whole request (see `gotchas.md`).
- **SES U5/U6 invoice release** — migration `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` adds the invoice-obligation ledgers (`makesafe_invoice_obligations`, `makesafe_invoice_obligation_revisions`), review/release ledgers, and the SES identity columns/indexes on `xero_invoices`. The matching `ops-api` actions must not be deployed until this migration is applied; it is additive and does not create, authorise, send, or close anything by itself.
- **xero_projects** — per-project P&L from Xero Projects API
- **contact_matches** — links GHL contacts to Xero contacts. Has: ghl_contact_id, xero_contact_id, email, phone, client_name, lead_source, gclid
- **purchase_orders** — POs linked to jobs. **No `delivery_address` column**: the address is encoded into the free-text `notes` field as a leading `Deliver to: <address>` line. Never hand-roll that prefix — `_shared/po_reference.ts` owns both sides (`formatPoDeliveryNotes` to write, `parsePoDeliveryAddress` / `isPoPickup` to read), because a drift between writer and reader silently renders every PO as a pickup. Also no `supplier_email` (email lives on **suppliers**).
- **work_orders** — WOs with share tokens for external trades. No `estimated_hours`, `trade_cost` or `crew_rates` columns; the makesafe hours-flag `ops_set` source is therefore unwired and permanently null until an ops-set expected-hours field lands.
- **business_events** — append-only event log. Timestamp column is **occurred_at**, not `created_at`. Filter and order on `occurred_at`.
- **trade_invoices** / **trade_invoice_lines** — weekly trade billing, rebuilt in `20260325000003_timer_invoice_system`. Live columns are `week_end`, `subtotal_ex`, `total_inc`, `xero_bill_id` (not `week_ending` / `subtotal` / `total` / `xero_bill_number`). Per-job hours and amounts live relationally on `trade_invoice_lines` (job_id, job_number, total_hours, hourly_rate, line_total_ex, days_worked, assignment_ids) — not in a `line_items` JSON blob. Per-metre lines record cost with zero hours, so reconciliation never reads metres as hours. Migration `20260730000002_trade_invoice_wo_labour_lines` adds nullable `wo_allocated`, `wo_labour_deduction`, and cleaned `wo_labour_lines` JSONB facts for work-order deductions; the matching `generate_trade_invoice` path keeps those facts on the holder line and writes the human-readable breakdown into its description. Labourers bill SecureWorks Group directly; no payout invoice is auto-created. Apply the migration before deploying the matching function. Status is bounded by `trade_invoices_status_check` (`20260611000001_trade_invoice_guards.sql`): draft / pending_acknowledgment / queried / acknowledged / pending_ops_review / approved / pushed_to_xero / paid / ops-reject. There is **no `'failed'` status** — PostgREST returns the CHECK violation rather than throwing, so writing it silently leaves the invoice LIVE, holding its `job_assignments.invoiced_in` stamps; a failed submission releases back to `'draft'` instead (see `docs/trade-invoice-assignment-lock-root-cause-2026-08-06.md`).
- **suppliers** — cached Xero supplier contacts
- **org_config** — key-value config (targets, settings)
- **webhook_log** — audit trail for all sync operations

## Key Views
- **calendar_events** — joins assignments + jobs + users for calendar rendering. Carries `jobs.scope_json` through, so never `select('*')` or select `scope_json` from it across a date range — that OOM-kills the edge worker (see `gotchas.md`). The live view has also drifted ahead of the migrations here (live has 44 columns, the newest migration declares 41); check `information_schema.columns`, not the migrations, before enumerating its columns. Both consumers enumerate: `CAL_FINANCIAL_COLUMNS` / `CAL_LIGHT_COLUMNS` for the calendar, `OPS_SUMMARY_SCHEDULE_COLUMNS` for `ops_summary`'s `today_schedule`.
- **jobs_needing_scheduling** — accepted/quoted jobs with no future assignments. `ops_summary` reads only `id, client_name, site_suburb, type, days_waiting` (`OPS_SUMMARY_NEEDS_SCHEDULING_COLUMNS`), so the view can grow without widening that read.

## Key Functions
- **next_job_number(job_type)** — generates SWP-25001, SWF-25002, etc.
- **update_updated_at()** — trigger function for updated_at columns
- **auth_org_id()** — RLS helper, gets org_id from JWT

## Sequences
- `job_number_seq` — starts at 25000 (above Tradify max ~SW23324)
- `po_number_seq` — purchase order numbers
- `wo_number_seq` — work order numbers
