# Job Sync Flow — SecureWorks WA

> How jobs are created, numbered, and synced across GHL → Supabase → Xero
> Last updated: 4 March 2026

---

## The Problem (What Tradify Used To Do)

Tradify was the job card system. When a lead converted to a job, someone would:
1. Create a job card in Tradify (manual)
2. Tradify generated a job number
3. POs, timesheets, and invoices referenced that job number
4. Tradify pushed invoices to Xero

**Tradify is being phased out.** The Supabase `jobs` table + ops-api + scoping tools now replace it. But the critical question is: **who creates the running job card and triggers the sync chain?**

---

## Current Job Creation Paths

### Path 1: Scoping Tool → GHL Link → Job Created (PRIMARY PATH)

This is the main flow for new work:

1. **Lead arrives in GHL** (Google Ads → GHL form → opportunity in pipeline)
2. **Estimator opens scoping tool** (patio or fencing tool on GitHub Pages)
3. **Estimator clicks "Load from GHL"** → `integration.js` calls `ghl-proxy?action=get_opportunities`
4. **Selects the opportunity** → `ghl-proxy?action=create_job_for_opportunity` fires:
   - Creates a row in `jobs` table (status: `draft`, type: `patio`/`fencing`)
   - Links `ghl_opportunity_id` and `ghl_contact_id` on the job
   - Copies contact details (name, phone, email) from GHL to job
5. **Estimator scopes the job** → saves `scope_json` and `pricing_json` via `ghl-proxy?action=save_scope`
6. **Estimator clicks "Link" (scope complete)** → `ghl-proxy?action=link_scope`:
   - Generates job number via `next_job_number(type)` → e.g., `SWP-25042`
   - Updates GHL opportunity stage (moves pipeline forward)
   - Creates Xero contact (if not exists) via Xero API
   - Stores `xero_contact_id` on the job
   - Pushes job value ($) back to GHL opportunity
   - Job status → `quoted`

**This is the only path that generates a job number and triggers Xero contact creation.**

### Path 2: Ops Dashboard → Manual Status Changes

Shaun (ops manager) moves jobs through the pipeline:

- `accepted` → `scheduled` → `in_progress` → `complete` → `invoiced`
- Each status change calls `ops-api?action=update_job_status`
- Status change records timestamps: `accepted_at`, `scheduled_at`, `completed_at`
- **`complete_and_invoice`** compound action: marks complete + creates Xero invoice

### Path 3: Trade App → Assignment Status Updates

Field crews update their assignment status (not job status):

- `scheduled` → `confirmed` → `in_progress` → `complete`
- When ALL assignments for a job complete, ops-api returns `all_complete: true`
- Ops dashboard shows cascade prompt: "Mark job as complete?"
- **Trade app does NOT create jobs or change job status directly**

### Path 4: Direct Database (Legacy/Bulk)

- 137 legacy jobs were bulk-moved from `complete` → `invoiced` via migration
- Test assignments created for demo mode (should be cleaned up)

---

## Job Number Generation

```sql
-- Sequence starts at 25000 (above Tradify max ~23324)
CREATE SEQUENCE job_number_seq START 25000;

-- Function generates prefixed numbers
CREATE FUNCTION next_job_number(job_type text) RETURNS text AS $$
  SELECT CASE job_type
    WHEN 'patio' THEN 'SWP-'
    WHEN 'fencing' THEN 'SWF-'
    WHEN 'decking' THEN 'SWD-'
    WHEN 'retaining' THEN 'SWR-'
    ELSE 'SWI-'
  END || nextval('job_number_seq')::text;
$$;
```

- Format: `SWP-25001`, `SWF-25002`, `SWD-25003`, etc.
- Sequential across all types (shared sequence)
- Only generated on `link_scope` action (not on job creation)

---

## GHL ↔ Supabase Sync

### GHL → Supabase (via `ghl-proxy` edge function)

| Action | Trigger | What Syncs |
|--------|---------|------------|
| `get_opportunities` | Estimator opens GHL picker | Reads GHL pipeline, returns opportunities |
| `create_job_for_opportunity` | Estimator selects opportunity | Creates `jobs` row, copies contact data |
| `save_scope` | Estimator saves scope | Updates `scope_json`, `pricing_json` on job |
| `link_scope` | Estimator completes scope | Generates job number, moves GHL stage, creates Xero contact |
| `get_contact` | Various | Reads GHL contact by ID |
| `update_contact` | Save flow | Pushes address/details back to GHL contact |

### Supabase → GHL (push-back)

- Job value ($) pushed to GHL opportunity on link
- Scope PDF URL pushed to GHL opportunity notes
- GHL pipeline stage updated when job status changes (link_scope only currently)

### What's NOT synced:

- **GHL stage changes don't flow back to Supabase** — if someone moves a card in GHL, Supabase doesn't know
- **No webhook from GHL → Supabase** — sync is pull-based (triggered by scoping tool actions)
- **site_address/site_suburb** — NULL on most jobs because GHL doesn't have structured address fields

---

## Supabase → Xero Sync

### Contact Creation (on `link_scope`)

```
1. Check if Xero contact exists (by email or phone match)
2. If not → POST to Xero Contacts API
3. Store xero_contact_id on jobs row
4. Store match in contact_matches table (GHL ↔ Xero attribution)
```

### Invoice Creation (on `complete_and_invoice`)

```
1. Read job pricing_json for line items
2. POST to Xero Invoices API (type: ACCREC)
3. Store xero_invoice_id in xero_invoices table
4. Link invoice to job via job_id
5. Update job status → 'invoiced'
```

### PO → Xero (on `push_po_to_xero`)

```
1. Read purchase_order line items
2. POST to Xero as a Bill (type: ACCPAY)
3. Store xero_po_id on purchase_orders row
```

### Periodic Sync (via `xero-sync` edge function)

- Pulls invoices, payments, projects from Xero
- Updates `xero_invoices`, `xero_projects` tables
- Matches invoices to jobs by reference/contact
- `fully_paid_on` parsed from Xero's `/Date(ms)/` format

---

## Purchase Order → Job Linkage

| Field | Table | Purpose |
|-------|-------|---------|
| `purchase_orders.job_id` | `purchase_orders` | Links PO to the job it's for |
| `purchase_orders.po_number` | `purchase_orders` | Auto-generated from `po_number_seq` |
| `purchase_orders.xero_po_id` | `purchase_orders` | Xero Bill ID after push |
| `job_media.po_id` | `job_media` | Links receipt photos to specific POs |

PO creation flow:
1. Shaun creates PO in Ops Dashboard (selects job, supplier, line items)
2. PO saved to `purchase_orders` table with `job_id` link
3. Optionally: "Auto-populate from scope" extracts materials from `scope_json`
4. PO pushed to Xero as a Bill via `push_po_to_xero`
5. Tradies photograph receipts in Trade App → linked to PO via `po_id`

---

## The Gap: What's Missing Without Tradify

### Currently Working:
- Job creation (via scoping tools)
- Job numbering (SWP/SWF/SWD-25XXX)
- GHL opportunity → Supabase job → Xero contact chain
- Invoice creation from ops dashboard
- PO creation and Xero push
- WO creation and dispatch

### Critical Gaps:

1. **No way to create a job WITHOUT the scoping tool**
   - If a small job comes in (e.g., gate repair), there's no quick "New Job" button in ops dashboard
   - Workaround: estimator must open scoping tool, load from GHL, save minimal scope, link
   - **Fix needed:** "Quick Job" creation in Ops Dashboard

2. **No automated GHL → Supabase sync**
   - If an opportunity moves stages in GHL (e.g., client accepts quote), Supabase doesn't know
   - The `link_scope` action is the only trigger
   - **Fix needed:** GHL webhook → Supabase edge function for stage changes

3. **No automated Xero invoice → job status sync**
   - When Xero invoice is paid, job should auto-update to reflect payment
   - Currently: `xero-sync` pulls payment data but doesn't update job status
   - **Fix needed:** Payment webhook or sync that marks jobs as paid

4. **scope_json is empty on most jobs**
   - Legacy jobs imported from Tradify don't have scope data
   - scope-to-PO auto-populate can't work without it
   - **Not fixable retroactively** — only affects new jobs going forward

5. **site_address/site_suburb NULL on most jobs**
   - GHL doesn't have structured address fields
   - Scoping tool captures address but only if estimator enters it
   - **Fix needed:** Address capture required in scoping tool save flow

6. **No recurring job / maintenance scheduling**
   - Tradify had recurring job templates
   - Not yet built in Supabase system
   - **Deferred** — low priority for now

---

## Recommended Priority Fixes

| Priority | Fix | Effort | Impact |
|----------|-----|--------|--------|
| **P0** | Add "Quick Job" creation to Ops Dashboard | Medium | Unblocks non-scoped work |
| **P1** | GHL webhook for stage changes | Medium | Keeps Supabase in sync with sales pipeline |
| **P1** | Auto-update job when Xero invoice paid | Low | Closes the invoicing loop |
| **P2** | Require address in scoping tool save | Low | Fixes NULL address problem going forward |
| **P2** | Job creation from CEO dashboard | Low | Lets Marnin create jobs directly |

---

## Visual Flow

```
Google Ads → GHL Lead → GHL Opportunity
                              │
                    Estimator opens scoping tool
                              │
                    "Load from GHL" → select opportunity
                              │
                    create_job_for_opportunity
                    ┌─────────┴─────────┐
                    │   jobs table      │
                    │   (status: draft) │
                    └─────────┬─────────┘
                              │
                    Estimator scopes + prices
                              │
                    "Link" (scope complete)
                    ┌─────────┴─────────────────┐
                    │ • Generate job number      │
                    │ • Move GHL stage           │
                    │ • Create Xero contact      │
                    │ • Push $ to GHL            │
                    │ • status → quoted          │
                    └─────────┬─────────────────┘
                              │
                    Client accepts quote
                    (manual status change in ops dashboard)
                              │
                    status → accepted → scheduled
                              │
                    Shaun creates assignments, POs, WOs
                              │
                    Crew installs (Trade App)
                    ┌─────────┴─────────┐
                    │ • GPS check-in    │
                    │ • Photos          │
                    │ • Service report  │
                    │ • Signature       │
                    └─────────┬─────────┘
                              │
                    All assignments complete
                              │
                    "Complete + Invoice" (ops dashboard)
                    ┌─────────┴─────────────────┐
                    │ • status → complete        │
                    │ • Create Xero invoice      │
                    │ • status → invoiced        │
                    └───────────────────────────┘
```
