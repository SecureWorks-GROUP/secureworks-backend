# GHL Custom Fields Required

Create these in GHL Settings → Custom Fields → Opportunities.

These are written automatically by `ghl-proxy` during the `link` action (scope complete).

| # | Field Name | Type | Example | Written By |
|---|-----------|------|---------|-----------|
| 1 | `job_number` | Text | `SWP-25005` | ghl-proxy link action |
| 2 | `supabase_job_id` | Text | `a1b2c3d4-...` (UUID) | ghl-proxy link action |
| 3 | `job_type` | Text | `patio`, `fencing`, or `decking` | ghl-proxy link action |
| 4 | `quote_value` | Number | `18200` (inc GST) | ghl-proxy link action |
| 5 | `scheduled_date` | Date | `2026-03-15` | Ops Dashboard (future) |
| 6 | `assigned_crew` | Text | `Team A` | Ops Dashboard (future) |

## Why These Exist

- **job_number**: Shaun sees job numbers on GHL kanban cards without opening each opportunity
- **supabase_job_id**: Used by `ghl-webhook` to re-link jobs when opportunities move between Sales → Execution pipelines
- **job_type**: Pipeline filtering and division identification
- **quote_value**: Redundant with monetaryValue but explicit for custom field queries
- **scheduled_date / assigned_crew**: Future use by Ops Dashboard to push scheduling info to GHL

## Cross-Sell Note

When one GHL opportunity has both a patio and fencing scope, the **most recent** link action wins for the custom field values. This is expected — the custom fields reflect the latest scope action. Both jobs exist independently in Supabase linked to the same `ghl_opportunity_id`.

## Setup Steps

1. Go to GHL → Settings → Custom Fields → Opportunities
2. Create each field with the exact name (column 2 above) and type (column 3)
3. Field IDs will be auto-assigned by GHL — the code uses field names, not IDs
