# GHL Workflow Setup Guide

**For:** Shaun (Ops Manager)
**Last Updated:** 4 March 2026

This guide covers setting up GoHighLevel custom fields, webhooks, SMS workflows, and understanding how GHL pipeline stages map to our job management system.

---

## 1. Custom Fields on Opportunities

These custom fields are pushed from our system when a job is scheduled via the Ops Dashboard. They need to exist in GHL first so the data can be stored.

### Fields to Create

| Field Name | Field Key | Type | Options |
|------------|-----------|------|---------|
| Job Number | `job_number` | Text | — |
| Scheduled Date | `scheduled_date` | Date | — |
| Assigned Crew | `assigned_crew` | Text | — |
| Schedule Status | `schedule_status` | Dropdown | Unscheduled, Scheduled, In Progress, Complete |

### How to Create Custom Fields

1. Go to **Settings** (gear icon, bottom left)
2. Click **Custom Fields** in the left sidebar
3. Select the **Opportunities** tab at the top
4. Click **+ Add Field**
5. Enter the **Field Label** (e.g., "Job Number")
6. Select the **Field Type** (Text, Date, or Dropdown)
7. For the Schedule Status dropdown, add these options:
   - Unscheduled
   - Scheduled
   - In Progress
   - Complete
8. Click **Save**
9. Repeat for each field

### How These Fields Get Updated

When you create or update a job assignment in the Ops Dashboard, the system automatically pushes `scheduled_date`, `assigned_crew`, and `schedule_status` to the GHL opportunity via the `ghl-proxy` edge function (`update_custom_fields` action). No manual entry needed — the Ops Dashboard handles it.

---

## 2. Webhook Configuration

The webhook receives form submissions from GHL and creates draft jobs in our database automatically.

### Webhook URL

```
https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-webhook
```

### Setup Steps

1. Go to **Automation** > **Workflows** in GHL
2. Create a new workflow or edit an existing one
3. Add a **Webhook** action (or use a form submission trigger with an HTTP action)
4. Set the method to **POST**
5. Set the URL to the webhook URL above
6. Add a custom header:
   - **Header Name:** `X-Webhook-Secret`
   - **Header Value:** *(the value matching the `GHL_WEBHOOK_SECRET` environment variable set in Supabase — ask Marnin for the current secret)*

### Supported Events

The webhook currently handles **form submissions** that create new leads/jobs. It maps these GHL fields to our system:

| GHL Field | Our Field | Notes |
|-----------|-----------|-------|
| `contact_id` / `contactId` | `ghl_contact_id` | Links to GHL contact |
| `full_name` / `name` | `client_name` | Auto-splits first/last |
| `phone` | `client_phone` | |
| `email` | `client_email` | |
| `customField.address` | `site_address` | |
| `customField.suburb` / `city` | `site_suburb` | |
| `customField.project_type` | `type` | Mapped: fencing, patio, combo |
| `customField.timeframe` | `notes` | Stored in job notes |
| `gclid` / UTM params | `contact_matches` | For Google Ads attribution |

### Authentication

The webhook validates the secret in two ways:
- `X-Webhook-Secret` header matching the stored secret
- `Authorization` header as `Bearer <secret>`

If no `GHL_WEBHOOK_SECRET` is set in Supabase, the webhook accepts all requests (not recommended for production).

### Testing

1. In GHL, go to **Contacts** and select a test contact
2. Trigger the workflow manually or submit the form
3. Check the Supabase `jobs` table to see if a draft job was created
4. Check the `webhook_log` table for any error records
5. Verify the `contact_matches` table has a row with attribution data

---

## 3. SMS Workflow Templates

Set these up as **GHL Workflows** (Automation > Workflows). Each uses GHL merge fields to personalise messages.

### 3.1 Crew Notification — Job Scheduled

**Trigger:** When a job assignment is created in the Ops Dashboard (manual trigger or internal webhook)

**Template:**
```
Hey {{contact.assigned_crew}}, you've been scheduled for a job:

Client: {{contact.name}}
Address: {{contact.address1}} {{contact.city}}
Date: {{opportunity.scheduled_date}}
Job: {{opportunity.job_number}}

Check your Trade App for full details.
```

**Notes:** This is best triggered from the Ops Dashboard side. When Shaun schedules a job, the system could fire a webhook to GHL which triggers this workflow.

### 3.2 Client Confirmation — 48hrs Before Install

**Trigger:** Workflow trigger based on `scheduled_date` custom field, 48 hours before

**Template:**
```
Hi {{contact.first_name}}, this is a reminder from SecureWorks WA.

Your installation is scheduled for {{opportunity.scheduled_date}}.

Please ensure the work area is clear and accessible. Our team will arrive between 7-8am.

If you need to reschedule, please call us on 0490 786 967.

Thanks,
SecureWorks WA
```

### 3.3 Client Thank-You — Job Complete

**Trigger:** When opportunity moves to a "Complete" stage (e.g., "Job complete Needs to be invoiced" or "Get Google Review")

**Template:**
```
Hi {{contact.first_name}}, your project with SecureWorks WA is now complete!

We hope you love your new outdoor space. If you have a moment, we'd really appreciate a Google review — it helps other Perth homeowners find us.

[REVIEW LINK]

Thanks for choosing SecureWorks!
```

### 3.4 Shaun Notification — Scope Complete

**Trigger:** When opportunity moves to "Scope Complete / Quote to be Sent" (patio) or "Scope Complete" (fencing)

**Template:**
```
Scope complete for {{contact.name}}

Job: {{opportunity.job_number}}
Type: {{opportunity.pipeline}}
Value: {{opportunity.monetary_value}}

Scope link has been added to the contact notes in GHL.
```

**Notes:** The `link` action in the scoping tool automatically moves the opportunity to the Scope Complete stage, so this workflow triggers when that happens.

---

## 4. Pipeline Stage Mapping

This is the full mapping between GHL pipeline stage names and our Supabase job statuses. This is defined in the `ghl-proxy` edge function (`STAGE_MAP`) and used during sync operations.

### Sales — Patios Pipeline

**Pipeline ID:** `OGZLpPPVWVarN94HL6af`

| GHL Stage Name | Supabase Status |
|----------------|-----------------|
| Client Needs To Be Contacted | `draft` |
| Contacted Waiting on Response | `draft` |
| Needs Scope / Quote | `draft` |
| Scope Booked | `draft` |
| Scope Complete / Quote to be Sent | `quoted` |
| Quote Sent / Follow up | `quoted` |
| Job Won / Move to Execution | `accepted` |
| Nurture / On Hold (Nithin) | `draft` |
| Outside Service Area (Too Small) | `cancelled` |
| Job Lost/Archive | `cancelled` |
| Not Relevant /Archive | `cancelled` |

### Sales — Fencing Pipeline

**Pipeline ID:** `I9t8njpuR0Dm7B2NDcvI`

| GHL Stage Name | Supabase Status |
|----------------|-----------------|
| New Lead (Call + Qualify) | `draft` |
| New Lead (Replied/ Contacted) | `draft` |
| Called, No Answer | `draft` |
| Call Answered (presentation not made) | `draft` |
| Presentation Made (scope not booked) | `draft` |
| Needs On Site Scope Urgently | `draft` |
| Lead Closed (scope booked) | `draft` |
| Scope Scheduled | `draft` |
| Scope Complete | `quoted` |
| Following up Quote Sent (Site visit) | `quoted` |
| Job Accepted -> Move to Execution | `accepted` |
| On Hold | `draft` |
| Stale Lead | `cancelled` |
| Job Lost | `cancelled` |

### Execution — Fencing Pipeline

**Pipeline ID:** `fgV2mkFh6BD4gOZZx94y`

| GHL Stage Name | Supabase Status |
|----------------|-----------------|
| Job Accepted Ready for Execution | `accepted` |
| 25% Deposits To Be Received (Shared Fence) | `accepted` |
| 50% Deposit To Be Received | `accepted` |
| Materials To Be Ordered / Job Scheduled | `scheduled` |
| Pending WhatsApp Confirmation From Fencing Team | `scheduled` |
| Pending Confirmation Email From Supplier | `scheduled` |
| Confirmed Material Order | `scheduled` |
| Order to be Picked up | `scheduled` |
| Order To be Delivered (Materials TBC on Site) | `scheduled` |
| Scheduled / In Progress | `in_progress` |
| Get Final Payment Both Clients | `complete` |
| Get Google Review | `complete` |
| Completed and Archived in Tradify (Get Sign off) | `complete` |
| Outstanding Payments Backlog | `invoiced` |

### Execution — Patios Pipeline

**Pipeline ID:** `SxayUz0KRDlCUk58apCC`

| GHL Stage Name | Supabase Status |
|----------------|-----------------|
| Ready to Execute | `accepted` |
| Drafting in progress | `accepted` |
| DA in Progress | `accepted` |
| Engineering in progress | `accepted` |
| CDC in Progress | `accepted` |
| Council Approval in progress | `accepted` |
| Finalised Plans and Invoice for Deposit Sent | `accepted` |
| Deposit Received Materials to be ordered | `scheduled` |
| Materials Ordered Job to be Scheduled | `scheduled` |
| Scheduled Awaiting Start Date | `scheduled` |
| In Progress | `in_progress` |
| Rectifcation / To be Finished off | `in_progress` |
| Job complete Needs to be invoiced | `complete` |
| Invoice Sent waiting on Final Payment | `invoiced` |
| Job sign off with all documentation | `complete` |

### Materials Pipeline (Tracked)

**Pipeline ID:** `SkgfC3nzTsOHqTSv9LNl`

This pipeline is tracked but not actively mapped for job sync.

### Scope Complete Stage IDs

Used by the scoping tools when the `link` action is triggered:

| Pipeline | Stage Name | Stage ID |
|----------|-----------|----------|
| Patio Sales | Scope Complete / Quote to be Sent | `9b9e5313-8e0e-4ed6-8654-d50413b99885` |
| Fencing Sales | Scope Complete | `418534d4-6356-4c20-a274-51fbb892c2fa` |

### Job Complete Stage IDs

**Note:** These are currently placeholder values and need to be replaced with real GHL stage UUIDs:

| Pipeline | Stage ID | Status |
|----------|----------|--------|
| Fencing Execution | `PLACEHOLDER-FENCING-COMPLETE-STAGE-ID` | Needs real UUID |
| Patio Execution | `PLACEHOLDER-PATIO-COMPLETE-STAGE-ID` | Needs real UUID |
| Decking Execution | `PLACEHOLDER-DECKING-COMPLETE-STAGE-ID` | Needs real UUID |

To find the real UUIDs: call the `ghl-proxy` edge function with `?action=pipelines` to list all pipelines and their stage IDs.
