# Phase 2 Terminal 1 — HANDOFFs

> Created: 22 March 2026 by Phase 2 Terminal 1 (Trade App + Client Experience)

## For ops-api owner (self — building directly)

### 1. New Comms Templates (add to CLIENT_COMMS_TEMPLATES)
Add these 5 new triggers alongside the existing 13:

| Trigger | Channel | Template |
|---------|---------|----------|
| `follow_up_day3` | sms | Hi {name}, just checking in — have you had a chance to review your {service} quote? Happy to answer any questions. |
| `follow_up_day5` | sms | Hi {name}, your quote for {service} at {address} is still open. Would you like to discuss anything? |
| `follow_up_day7` | email | Hi {name}, we noticed you haven't responded to your {service} quote yet. We'd hate for you to miss out — this quote expires soon. Call us anytime on 0489 267 771. |
| `deposit_reminder_day3` | sms | Hi {name}, just a reminder — your deposit invoice for {service} is waiting. Pay online anytime: {payment_url} |
| `deposit_reminder_day7` | annotation_only | N/A — creates RED annotation for scoper: "Accepted but unpaid 7 days — call immediately or mark as lost" |

### 2. Invoice Verification Actions (Part C)
- `list_pending_verifications` — query assignments awaiting lead verification
- `verify_hours` — lead approves labourer hours
- `dispute_hours` — lead disputes labourer hours

### 3. User Profile Field
- Add `invoice_type` field to users table: 'hourly' (default) or 'per_metre'

---

## For daily-digest owner

### 1. Stale Quote Follow-Up (HIGH priority)
Run daily at 9am AWST:
```sql
SELECT j.id, j.client_name, j.type, j.site_address,
       jd.share_token, jd.sent_at
FROM job_documents jd
JOIN jobs j ON j.id = jd.job_id
WHERE jd.sent_to_client = true
  AND jd.accepted_at IS NULL
  AND jd.declined_at IS NULL
  AND jd.sent_at IS NOT NULL
```
- Day 3: call `send_client_update` with trigger `follow_up_day3`
- Day 5: call `send_client_update` with trigger `follow_up_day5`
- Day 7: call `send_client_update` with trigger `follow_up_day7` + create annotation for scoper "Quote stale 7 days — call them"
- After day 7: no more auto-comms

### 2. Deposit Chaser (HIGH priority)
Run daily at 9am AWST:
```sql
SELECT j.id, j.client_name, j.type, j.site_address, j.accepted_at
FROM jobs j
WHERE j.status = 'accepted'
  AND j.deposit_paid_at IS NULL
  AND j.accepted_at < NOW() - INTERVAL '3 days'
```
- Day 3: call `send_client_update` with trigger `deposit_reminder_day3`
- Day 7: create RED annotation for scoper: "Accepted but unpaid 7 days — call immediately or mark as lost"

### 3. Phantom Buyer Detection (MEDIUM priority)
Run in the 9am digest check:
```sql
SELECT ee.job_id, j.client_name, j.assigned_to,
       COUNT(*) as view_count,
       MAX(ee.created_at) as latest_view
FROM email_events ee
JOIN jobs j ON j.id = ee.job_id
WHERE ee.comms_trigger = 'quote_viewed'
  AND ee.created_at > NOW() - INTERVAL '24 hours'
GROUP BY ee.job_id, j.client_name, j.assigned_to
HAVING COUNT(*) >= 3
```
If 3+ views detected: create business_event `quote.hot_lead` + Telegram message to scoper.

### 4. Completion Pack Send (MEDIUM priority)
Run daily:
```sql
SELECT j.id, j.job_number, j.client_name, j.client_email
FROM jobs j
WHERE j.status = 'complete'
  AND j.final_payment_at IS NOT NULL
  AND j.final_payment_at < NOW() - INTERVAL '2 days'
  AND NOT EXISTS (
    SELECT 1 FROM job_events je
    WHERE je.job_id = j.id
    AND je.event_type = 'completion_pack_emailed'
  )
```
For each: call completion-pack edge function with `send_email: true`.

---

## For ops dashboard owner

### Labour Cost Ticker (MEDIUM priority)
**[DONE 22-Mar-2026 by Terminal 2]** — Built in ops-job-detail.js money tab. Uses assignments + work order rates + PO budget comparison.

---

## From Terminal 2 (Intelligence & Dashboard) — 22 March 2026

### For ops-api owner (HIGH priority)

#### 1. `po_communications` joined in `list_pos` response
**Why:** Dashboard PO kanban cards and job detail money tab now display email thread previews inline on each PO card. The UI reads `po.communications` or `po.email_threads` array.
**Needed:** Join `po_communications` on `purchase_order_id` when returning POs. Include: `direction`, `from_email`, `subject`, `body_text`, `created_at`, `attachments`.

#### 2. `list_email_events` action (filtered by job_id)
**Why:** Job detail comms tab shows "Automated Communications" timeline from `email_events`.
**Needed:** Query `email_events` filtered by `job_id`, return array sorted by `created_at` with fields: `event_type`, `comms_trigger`, `comms_channel`, `status`, `created_at`, `open_count`, `metadata`.

#### 3. Assignment hours in `job_detail` response
**Why:** Labour cost tracker in money tab uses assignment hours + trade rates.
**Needed:** Include `hours_worked` or `clocked_on`/`clocked_off` timestamps in assignment data returned by `job_detail`.

### pg_cron entries needed (run via SQL migration)

```sql
-- Stale followup at 9am AWST (1:00 UTC)
SELECT cron.schedule('stale-followup', '0 1 * * *',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=stale_followup',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- EOD followup at 5pm AWST (9:00 UTC) — weekdays only
SELECT cron.schedule('eod-followup-5pm', '0 9 * * 1-5',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=eod_followup',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);

-- EOD followup at 7pm AWST (11:00 UTC) — weekdays only
SELECT cron.schedule('eod-followup-7pm', '0 11 * * 1-5',
  $$SELECT net.http_post(url:='https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest?action=eod_followup',headers:='{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U","Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb);$$
);
```
