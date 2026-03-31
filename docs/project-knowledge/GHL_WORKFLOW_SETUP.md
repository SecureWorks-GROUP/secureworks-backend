# GHL Workflow Setup — Bidirectional Sync with Ops Dashboard

## Overview

The Ops Dashboard and GHL are now bidirectionally synced:

1. **Ops → GHL:** When Shaun moves a job status in the Ops kanban, the GHL opportunity stage updates automatically.
2. **GHL → Ops:** When someone moves an opportunity in GHL, the job status updates in Supabase automatically.

This doc covers the GHL workflows Shaun needs to configure for the reverse sync (GHL → Ops) to work.

---

## Workflow 1: Pipeline Stage Changed → Webhook (REQUIRED)

This is the critical workflow that enables GHL → Supabase sync.

### Setup Steps

1. Go to **GHL → Automation → Workflows**
2. Create a new workflow for EACH execution pipeline:

#### Fencing Execution Pipeline
- **Trigger:** Pipeline Stage Changed → Pipeline: "SecureWorks Fencing Execution"
- **Action:** Webhook (Custom Webhook)
  - Method: POST
  - URL: `https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-webhook`
  - Headers: `X-Webhook-Secret: <your GHL_WEBHOOK_SECRET value>`
  - Body (JSON):
    ```json
    {
      "type": "PipelineStageChanged",
      "opportunityId": "{{opportunity.id}}",
      "pipelineId": "fgV2mkFh6BD4gOZZx94y",
      "pipelineStageId": "{{opportunity.pipeline_stage_id}}",
      "contactId": "{{contact.id}}"
    }
    ```

#### Patio Execution Pipeline
- **Trigger:** Pipeline Stage Changed → Pipeline: "SecureWorks Patios Execution"
- **Action:** Webhook (Custom Webhook)
  - Same URL and headers as above
  - Body (JSON):
    ```json
    {
      "type": "PipelineStageChanged",
      "opportunityId": "{{opportunity.id}}",
      "pipelineId": "SxayUz0KRDlCUk58apCC",
      "pipelineStageId": "{{opportunity.pipeline_stage_id}}",
      "contactId": "{{contact.id}}"
    }
    ```

### Anti-Loop Protection

The system has built-in anti-loop protection:
- When the Ops Dashboard moves a job status → GHL updates → GHL fires webhook back → webhook detects status already matches → skips update.
- The webhook also prevents backward status moves (e.g., won't move a "scheduled" job back to "accepted").

### Testing

After setting up the workflows:
1. Move an opportunity in GHL Fencing Execution from one stage to another
2. Check the Ops Dashboard — the job card should move to the corresponding column
3. Check `webhook_log` table in Supabase for the received payload

---

## Stage Mappings

### Fencing Execution → Supabase Status

| GHL Stage | Supabase Status |
|-----------|----------------|
| Job Accepted Ready for Execution | `accepted` |
| 25% Deposits To Be Received | `accepted` |
| 50% Deposit To Be Received | `accepted` |
| Materials To Be Ordered / Job Scheduled | `scheduled` |
| Pending WhatsApp Confirmation | `scheduled` |
| Pending Confirmation Email From Supplier | `scheduled` |
| Confirmed Material Order | `scheduled` |
| Order to be Picked up | `scheduled` |
| Order To be Delivered | `scheduled` |
| Scheduled / In Progress | `in_progress` |
| Get Final Payment Both Clients | `complete` |
| Get Google Review | `complete` |
| Completed and Archived | `complete` |
| Outstanding Payments Backlog | `invoiced` |

### Patio Execution → Supabase Status

| GHL Stage | Supabase Status |
|-----------|----------------|
| Ready to Execute | `accepted` |
| Drafting in progress | `accepted` |
| DA in Progress | `accepted` |
| Engineering in progress | `accepted` |
| CDC in Progress | `accepted` |
| Council Approval in progress | `accepted` |
| Finalised Plans and Invoice | `accepted` |
| Deposit Received Materials to be ordered | `scheduled` |
| Materials Ordered Job to be Scheduled | `scheduled` |
| Scheduled Awaiting Start Date | `scheduled` |
| In Progress | `in_progress` |
| Rectification / To be Finished off | `in_progress` |
| Job complete Needs to be invoiced | `complete` |
| Invoice Sent waiting on Final Payment | `invoiced` |
| Get Google Review | `complete` |
| Job sign off with all documentation | `complete` |

---

## GHL Custom Fields Written by Ops Dashboard

When the Ops Dashboard schedules a job or updates status, it writes these custom fields to the GHL opportunity:

| Field | When Written | Value |
|-------|-------------|-------|
| `scheduled_date` | Job is scheduled (assignment created) | YYYY-MM-DD |
| `assigned_crew` | Job is scheduled | Crew name string |
| `schedule_status` | Job is scheduled | "scheduled" |

---

## Future Workflows (Not Yet Implemented)

These are documented for future implementation:

### Job Scheduled → SMS to Crew
- **Trigger:** Custom field `schedule_status` changes to "scheduled"
- **Action:** Send SMS to crew phone number
- **Message:** "You've been scheduled for {opportunity.name} on {scheduled_date}"

### Job Complete → Thank You SMS
- **Trigger:** Pipeline stage moves to "Get Final Payment" or "Job complete"
- **Action:** Send SMS to contact
- **Message:** Customer satisfaction / Google review request

### Invoice Overdue → Payment Reminder
- **Trigger:** Custom field `invoice_status` = "overdue" (set by future Xero webhook sync)
- **Action:** Send SMS/email payment reminder to contact

---

## Deploy Notes

After modifying the webhook handler:
```bash
/Users/marninstobbe/.local/bin/supabase functions deploy ghl-webhook --project-ref kevgrhcjxspbxgovpmfl --no-verify-jwt
```

The `--no-verify-jwt` flag is required because GHL sends webhooks without a JWT.

---

## Troubleshooting

1. **Webhook not firing:** Check GHL workflow is active and the trigger matches the right pipeline
2. **Status not updating:** Check `webhook_log` table for the received payload — look for `status: 'received'`
3. **Anti-loop skipping:** Normal behaviour — check job_events for `ghl_stage_synced` events
4. **Wrong status mapping:** If Shaun renames a GHL stage, the stage UUID stays the same so mappings still work. Only adding/removing stages requires code updates to `GHL_STAGE_TO_STATUS` in `ghl-webhook/index.ts`
