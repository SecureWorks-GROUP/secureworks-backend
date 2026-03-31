# SecureWorks Spine Contract — Phase 1 Infrastructure

> **Created:** 22 March 2026 — Phase 1 Spine session
> **Purpose:** Contract document for Phase 2 feature terminals. Lists every table, action, and pattern available.

---

## New Tables

### expense_receipts
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| org_id | uuid | Default org |
| job_id | uuid FK→jobs | nullable — null = General Stock |
| po_id | uuid FK→purchase_orders | Set by PO matching |
| submitted_by | uuid FK→users | |
| vendor_name | text | Haiku-extracted |
| receipt_date | date | Haiku-extracted |
| total_amount | numeric(12,2) | Haiku-extracted |
| gst_amount | numeric(12,2) | Haiku-extracted |
| line_items | jsonb | Array of {description, quantity, unit_price, total} |
| extraction_confidence | numeric(4,3) | |
| extraction_raw | jsonb | Full Haiku response |
| match_type | text | 'po_matched', 'ad_hoc', 'non_job', 'unmatched' |
| match_confidence | numeric(4,3) | |
| status | text | 'pending', 'pending_extraction', 'approved', 'queried', 'pushed_to_xero' |
| approved_by | uuid | |
| approved_at | timestamptz | |
| approval_routed_to | text | 'shaun' (job) or 'jan' (stock) |
| xero_bill_id | text | Set after Xero push |
| receipt_photo_url | text NOT NULL | |
| expense_tier | text | 'tier_1' (PO), 'tier_2' (ad-hoc job), 'tier_3' (stock) |
| split_allocation | jsonb | [{job_id, amount, cost_centre}] for split purchases |

### council_submissions
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| org_id | uuid | |
| job_id | uuid FK→jobs | |
| steps | jsonb NOT NULL | Array of step objects (see below) |
| current_step_index | int | |
| overall_status | text | 'not_started', 'in_progress', 'complete', 'blocked' |
| template_type | text | 'standard_council', 'development_approval', 'retrospective', 'custom' |

**Step object format:**
```json
{
  "step_id": "uuid",
  "name": "Get Engineering",
  "status": "pending|in_progress|complete|blocked",
  "vendor": "Perth Structural Engineers",
  "vendor_email": "info@pse.com.au",
  "started_at": null,
  "completed_at": null,
  "documents_received": [],
  "notes": ""
}
```

### council_step_templates
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| template_type | text UNIQUE | 'standard_council', 'development_approval', 'retrospective' |
| template_name | text | Human label |
| steps | jsonb | Default steps array |

### job_variations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| org_id | uuid | |
| job_id | uuid FK→jobs | |
| variation_number | int | Auto-incremented per job |
| description | text NOT NULL | |
| reason | text | 'client_request', 'site_condition', 'design_change', 'error_correction' |
| amount | numeric(12,2) | |
| gst_included | boolean | Default true |
| cost_estimate | numeric(12,2) | Internal estimate |
| photo_url | text | |
| status | text | 'pending_approval', 'approved', 'rejected', 'auto_approved', 'sent', 'accepted', 'declined', 'invoiced' |
| needs_approval | boolean | True if amount > $200 |
| share_token | text UNIQUE | Auto-generated, for client view URL |
| sent_at, accepted_at, declined_at | timestamptz | |
| invoice_method | text | 'standalone', 'with_final' |
| xero_invoice_id | text | |
| created_by, approved_by | uuid | |

### job_duration_defaults
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| org_id | uuid | |
| job_type | text | 'patio', 'fencing' |
| stage_from | text | e.g. 'quoted' |
| stage_to | text | e.g. 'accepted' |
| expected_days | int | |
| learned_avg_days | numeric(6,1) | AI-learned (future) |
| sample_count | int | |

**UNIQUE(org_id, job_type, stage_from, stage_to)**. Seeded with 16 rows (8 patio + 8 fencing stage transitions).

---

## Altered Tables

| Table | Column Added | Type | Notes |
|-------|-------------|------|-------|
| po_communications | communication_type | text DEFAULT 'purchase_order' | 'purchase_order', 'council', 'engineering' |
| email_events | comms_trigger | text | 13 lifecycle values (see templates below) |
| email_events | comms_channel | text DEFAULT 'email' | 'email', 'sms', 'both' |
| jobs | callback_parent_id | uuid FK→jobs | Links callback to original job |
| jobs | is_callback | boolean DEFAULT false | |
| jobs | cross_sell_flags | jsonb DEFAULT '[]' | Column exists, handlers deferred to Phase 2 |
| jobs | cross_sell_source_job_id | uuid FK→jobs | Links cross-sell job to source |

---

## ops-api Actions

> **CALLING CONVENTION:** All actions use the query string: `?action=ACTION_NAME`. POST body contains action-specific parameters. GET actions (list/read) pass filters as query params. POST actions (create/update) pass data in the JSON body.
>
> **Example:** `POST /functions/v1/ops-api?action=submit_expense` with body `{ "receipt_photo_url": "..." }`

### Expenses
| Action | Input | Output |
|--------|-------|--------|
| `submit_expense` | `{ job_id?, receipt_photo_url, submitted_by?, po_id? }` | `{ expense_id, extraction, status, routed_to }` |
| `approve_expense` | `{ expense_id, approved_by?, approved? }` | `{ success, status }` |
| `push_expense_to_xero` | `{ expense_id }` | `{ success, xero_bill_id }` |
| `list_expenses` | `?job_id=&status=&limit=` (GET params) | `{ expenses: [...] }` |
| `list_unreconciled_transactions` | `?days_back=30&limit=50` (GET params) | `{ transactions: [{ xero_txn_id, amount, date, contact_name, description, suggested_matches }] }` |

**Expense approval routing:** ALL expenses require approval. job_id set → Shaun. No job_id (General Stock) → Jan. No auto-approve.

### Council/Engineering
| Action | Input | Output |
|--------|-------|--------|
| `create_council_submission` | `{ job_id, template_type? }` | `{ submission_id, steps_count }` |
| `update_council_status` | `{ submission_id, step_index?, step_id?, status?, vendor?, vendor_email?, notes?, documents_received? }` | `{ success, overall_status, step }` |
| `send_council_email` | `{ submission_id, step_index?, to_email, subject?, body_html?, body_text? }` | `{ success, email_id }` |
| `list_council_submissions` | `?job_id=` (GET params) | `{ submissions: [...with email_threads] }` |

**Email reply-to:** `council+CS{submission_id_prefix}-step{index}@secureworksgroup.app`

### Variations (v2 — uses job_variations table)
| Action | Input | Output |
|--------|-------|--------|
| `create_variation` | `{ job_id, description, estimated_cost?, amount?, photo_url?, reason?, invoice_method?, user_id? }` | `{ success, variation_id, variation_number, share_token, needs_approval, auto_approved, message }` |
| `approve_variation` | `{ variation_id (or event_id), approved, user_id?, notes? }` | `{ success, approved, message }` |
| `list_variations` | `?job_id=&status=` (GET params) | `{ variations: [...] }` |
| `send_variation` | `{ variation_id }` | `{ success, email_id }` |

### Callbacks
| Action | Input | Output |
|--------|-------|--------|
| `create_callback` | `{ job_id, issue_description, reported_by? }` | `{ success, message }` |
| `resolve_callback` | `{ job_id, resolution_notes?, resolved_by? }` | `{ success, message }` |

### Client Comms
| Action | Input | Output |
|--------|-------|--------|
| `send_client_update` | `{ job_id, comms_trigger, channel?, custom_message?, template_vars? }` | `{ sent, channel, message_preview }` |

**IMPORTANT:** `send_client_update` is **caller-triggered only**. It is NOT automatic. The ops dashboard, AI, or Phase 2 trigger logic must call it explicitly. Phase 2 terminals that want automated lifecycle comms should build trigger logic and use this as the delivery mechanism.

**SMS:** Always via GHL (locked). **Email:** Via Resend.

### Duration Monitoring
| Action | Input | Output |
|--------|-------|--------|
| `check_job_durations` | (no params) | `{ overdue_jobs: [...], on_track_jobs: [...] }` |

**Duration source priority:** `scope_json.labour_days` → `scope_json.install_days` → metres-based (fencing: <30m=1d, 30-60m=2d, 60m+=3d) → `job_duration_defaults` table fallback.

Uses source_ref deduplication to prevent duplicate annotations.

### Annotations
| Action | Input | Output |
|--------|-------|--------|
| `annotations` | `?scope=&entity_type=&entity_id=` (GET params) | `{ annotations: [...] }` |

> **Note:** The action name is `annotations`, not `get_annotations`.

### Email Events
| Action | Input | Output |
|--------|-------|--------|
| `get_email_events` | `?job_id=&limit=` (GET params) | `{ events: [...] }` |

### Reconciliation (reporting-api)
| Action | Input | Output |
|--------|-------|--------|
| `reconcile_transaction` | `{ transaction_id, job_id?, cost_centre?, status? }` | `{ success, transaction_id, status }` |

> **Note:** This action lives in `reporting-api`, not `ops-api`.

---

## Client Comms Templates (18)

| Trigger | Channel | Template |
|---------|---------|----------|
| quote_sent | email | Hi {name}, your quote for {service} at {address} is ready... |
| quote_accepted | sms | Thanks for choosing SecureWorks! Your deposit invoice is on its way. |
| deposit_paid | sms | Deposit received! We're ordering your materials... |
| materials_ordered | sms | Your materials have been ordered. Expected delivery: {delivery_date}. |
| council_submitted | sms | We've submitted your application to {council}... |
| council_approved | sms | Great news! Your {service} has been approved... |
| crew_scheduled | sms | Your install is booked for {date}. {installer} and team will arrive... |
| crew_arriving | sms | Our crew is on their way to {address}... |
| daily_progress | sms | Day {day} update: {progress_note} |
| job_complete | email | Your {service} is complete! Please review and sign off... |
| invoice_sent | email | Your final invoice for {amount} is attached... |
| payment_received | email | Payment received — thank you! We'd love a Google review... |
| follow_up_30d | email | Hi {name}, how's your new {service}?... |
| follow_up_day3 | sms | Hi {name}, just checking in — have you had a chance to review your {service} quote? |
| follow_up_day5 | sms | Hi {name}, your quote for {service} at {address} is still open. Would you like to discuss? |
| follow_up_day7 | email | Hi {name}, we noticed you haven't responded to your {service} quote yet... |
| deposit_reminder_day3 | sms | Hi {name}, just a reminder — your deposit invoice for {service} is waiting... |
| deposit_reminder_day7 | sms | Hi {name}, your deposit for {service} is still outstanding after a week... |

---

## Haiku Classifier Router (ops-ai)

Every query goes through a Haiku classifier first (~$0.001, <1 second):

| Classification | Model | Tools | Max Tokens |
|---------------|-------|-------|------------|
| **A** (simple lookup) | claude-haiku-4-5-20251001 | 5 read-only: search_jobs, get_job_detail, get_schedule, get_attention_items, get_dashboard_summary | 512 |
| **B** (complex analysis) | claude-sonnet-4-20250514 | Full intelligence tool set | 2048 |
| **C** (write action) | claude-sonnet-4-20250514 | Full tool set inc. write actions | 2048 |

Fallback on classifier failure: Sonnet (fail safe to smart model).

---

## system-health Endpoint

**URL:** `POST /functions/v1/system-health`
**Auth:** SW_API_KEY or service role key
**Cron:** Every 30 minutes via pg_cron

**Response:**
```json
{
  "status": "healthy|degraded|critical",
  "checked_at": "2026-03-22T14:30:00Z",
  "checks": {
    "xero_sync": { "status": "ok", "last_sync": "...", "age_minutes": 15 },
    "daily_digest": { "status": "ok", "last_run": "...", "age_hours": 5 },
    "stale_alerts": { "status": "ok", "count": 3 },
    "annotations": { "status": "ok", "active_count": 12 },
    "business_events": { "status": "ok", "last_24h_count": 45 }
  },
  "alerts": []
}
```

If degraded/critical → sends Telegram alert to admin.

---

## Deferred to Phase 2

| Item | Terminal | Notes |
|------|----------|-------|
| Cross-sell handlers (flag_cross_sell, list_cross_sell_opportunities) | Terminal B | Column exists on jobs, no API handlers |
| Council kanban card UI | Terminal builds UI | Spine provides data via list_council_submissions |
| Reconciliation UI card | Terminal D | list_unreconciled_transactions provides data |
| Automated comms triggers | Phase 2 | send_client_update is caller-triggered only |
| Bank feed catch-all annotations | xero-sync update | Flag unmatched company card transactions |
