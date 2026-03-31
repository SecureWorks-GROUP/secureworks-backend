# Terminal D Handoffs — Triggers from Terminal A

> Terminal A writes the detection logic and data. Terminal D routes notifications via ops-ai/Telegram.

---

## 1. Phantom Buyer Signal

**Trigger:** `email_events` shows a quote opened 3+ times in a 2-hour window.

**Detection query:**
```sql
SELECT ee.job_id, ee.recipient, COUNT(*) as open_count,
       j.client_name, j.job_number, j.assigned_to
FROM email_events ee
JOIN jobs j ON j.id = ee.job_id
WHERE ee.email_type = 'quote'
  AND ee.status = 'opened'
  AND ee.updated_at > NOW() - INTERVAL '2 hours'
GROUP BY ee.job_id, ee.recipient, j.client_name, j.job_number, j.assigned_to
HAVING COUNT(*) >= 3;
```

**Telegram message (Terminal D routes):**
> "{Client} is looking at their quote right now — opened it {X} times today. Call them now."

**Target:** Assigned scoper (from `jobs.assigned_to`).

---

## 2. Deposit Velocity Tagging

**Trigger:** On deposit paid (detected via Xero payment webhook or xero-sync).

**Logic:**
1. Calculate `deposit_paid_at - quote_sent_at` (from `jobs.quoted_at`)
2. Write delta to `jobs.metadata` as `deposit_velocity_hours`
3. Fast payers (< 24 hours) flagged for priority scheduling

**Data update:**
```sql
UPDATE jobs
SET metadata = metadata || jsonb_build_object(
  'deposit_velocity_hours', EXTRACT(EPOCH FROM (payment_date - quoted_at)) / 3600
)
WHERE id = $job_id;
```

**Terminal D surfaces** in daily digest:
> "Fast payer: {Client} paid deposit in {X} hours — flag for priority scheduling."

---

## 3. "I've Paid" Notification

**Trigger:** Client clicks "I've paid" button on Next Steps page or invoice email.

**Data written by Terminal A:**
- `job_events` row: type `client_payment_claimed`
- `business_events` row: type `payment.claimed`

**Terminal D action:**
- Send Telegram notification to ops group: "{Client} says they've paid for {JobNumber}. Check Xero."
- Pick up from `business_events WHERE event_type = 'payment.claimed' AND processed_at IS NULL`

---

---

## 4. Auto-Extract PO Pricing (Terminal A/B)

**When:** After `createPO()` completes successfully in ops-api.

**Action needed:** Call `extractPOPricing()` automatically after PO creation to populate `material_price_ledger`.

Currently this is manual — the function exists but isn't called automatically. Terminal A/B should add this to the createPO success path:

```typescript
// In ops-api createPO handler, after successful PO insert:
try {
  await extractPOPricing(sb, po.id)
} catch { /* non-blocking — don't fail PO creation */ }
```

**Why:** Feeds the price intelligence loop. Without this, `material_price_ledger` stays empty and price drift detection has no data.

---

## 5. Feedback Logging on Annotation Resolution (Terminal A/B)

**When:** After `resolveAnnotation()` completes in ops-api.

**Action needed:** Insert into `ai_feedback_outcomes` to close the learning loop.

```typescript
// In ops-api resolveAnnotation handler, after resolution:
try {
  await sb.from('ai_feedback_outcomes').insert({
    trace_id: null,
    human_action: resolution.value === 'dismiss' ? 'rejected' : 'approved',
    human_action_at: new Date().toISOString(),
    feedback_category: annotation.annotation_type,
    actual_outcome: resolution,
    action_params: { annotation_id: annotation.id, entity_id: annotation.entity_id },
  })
} catch { /* non-blocking */ }
```

**Why:** Without this, annotation dismiss/action rates can't be tracked and the learning digest can't tune annotation severity.

---

## 6. Price Drift Resolution → Update Scope Tool Defaults (Terminal A/B)

**When:** A `price_drift` annotation is resolved with `value: 'update_default'`.

**Action needed:** In the `resolveAnnotation()` handler, if `annotation_type === 'price_drift'` and `resolution.value === 'update_default'`, update the matching `scope_tool_defaults` row. Note: `structured_data` now includes `scope_tool` to target the correct row.

```typescript
if (annotation.annotation_type === 'price_drift' && resolution.value === 'update_default') {
  const sd = annotation.structured_data
  await sb.from('scope_tool_defaults')
    .update({
      default_price: sd.supplier_rate,
      default_cost_rate: sd.supplier_rate,
      last_updated_at: new Date().toISOString(),
    })
    .eq('item_key', sd.item_key)
    .eq('scope_tool', sd.scope_tool || 'patio-tool')
    .eq('org_id', annotation.org_id)
}
```

**Why:** Closes the pricing feedback loop — confirmed price changes automatically update the scope tool baseline. Works for both patio-tool and fence-designer defaults.

---

## 7. Supplier Email → Price Extraction (Terminal A — CRITICAL GAP)

**Current state:** `receive-po-email` catches supplier reply emails and archives them in `po_communications`. It does NOT extract pricing.

**What's needed:** When a supplier replies to a PO email (often with a quote PDF or line-item pricing in the body), the system should:

1. Parse the email body/attachments for pricing data (use Claude to extract structured line items)
2. Write each line item to `material_price_ledger` with status `'pending'`
3. Link to the original PO via `po_id`

**Where to build:** Either enhance `receive-po-email/index.ts` or create a new `extract-supplier-pricing` function called after archival.

```typescript
// Pseudocode for the extraction step:
const extracted = await extractPricingFromEmail(emailBody, attachments) // Claude call
for (const item of extracted.line_items) {
  await sb.from('material_price_ledger').insert({
    org_id, supplier_name: po.supplier_name,
    item_description: item.description,
    material_code: item.code || null,
    material_category: detectCategory(item), // roofing, steel, fencing_install, etc.
    unit: item.unit, unit_price: item.price,
    po_id: po.id, job_id: po.job_id,
    status: 'pending', captured_at: new Date().toISOString(),
  })
}
```

**Why:** This is the missing trigger for the entire price intelligence loop. Without supplier prices flowing into `material_price_ledger`, the drift detection (daily-digest + check_supplier_pricing) has nothing to compare against.

**Flow once built:**
```
Supplier replies to PO email
  → receive-po-email archives it
  → extract-supplier-pricing parses prices → material_price_ledger (pending)
  → daily-digest compares to scope_tool_defaults → price_drift annotation
  → Ops confirms "Update Default" → scope_tool_defaults updated
  → (Future) Scope tools read from database → next quote uses new price
```

---

## 8. SCOPE TOOL PRICING REFACTOR (Future Session — Not Terminal D)

**Current state:** Both scope tools (`patio-tool` and `fence-designer`) use hardcoded JavaScript pricing constants. The `scope_tool_defaults` table now has 49 rows of real pricing data (6 patio, 43 fencing). But the tools don't read from the database — they read from JS.

**Future refactor needed:**

1. Both scope tools should call a Supabase function on load to fetch current pricing
2. Pricing hierarchy: confirmed `material_price_ledger` (most recent) → `scope_tool_defaults` (baseline) → hardcoded JS (last resort fallback)
3. When a price drift is confirmed by a human, the NEXT quote automatically uses the updated price
4. No code changes needed per price update — the database becomes the pricing source of truth
5. Display a "prices last updated: [date]" indicator in the scope tool UI

**This requires changes to:**
- `~/Projects/patio-tool/` (Terminal A / separate session)
- `fence-designer` repo (Terminal A / separate session)
- New edge function or ops-api endpoint: `get_current_pricing?scope_tool=patio-tool` and `get_current_pricing?scope_tool=fence-designer`

**Until this refactor is done**, the AI flags price drift as annotations, but updating the actual scope tool prices is still a manual code change. The `scope_tool_defaults` table is the staging ground — it holds the "should be" prices, ready for the tools to read when the refactor lands.

---

## Status

| Handoff | Terminal A (data/trigger) | Terminal D (routing) |
|---------|--------------------------|----------------------|
| Phantom Buyer | Query ready, email_events populating after Batch 1 deploy | NOT BUILT — needs ops-ai detection cron |
| Deposit Velocity | Schema defined, needs xero-sync payment hook | NOT BUILT — needs daily-digest integration |
| "I've Paid" | LIVE — job_events + business_events written on button click | **BUILT** — daily-digest processEventTriggers() routes via Telegram |
| Auto-Extract PO Pricing | extractPOPricing() exists in ops-api | **NEEDS WIRING** — call after createPO() |
| Feedback on Annotation | resolveAnnotation() exists in ops-api | **NEEDS WIRING** — insert ai_feedback_outcomes |
| Price Drift Resolution | scope_tool_defaults table (49 rows: patio + fencing) | **NEEDS WIRING** — update default on resolution (now includes scope_tool) |
| Supplier Email → Prices | receive-po-email archives only, no extraction | **NOT BUILT** — needs Claude extraction → material_price_ledger |
| Scope Tool DB Pricing | scope_tool_defaults seeded, ready to serve | **FUTURE SESSION** — tools still read hardcoded JS |
