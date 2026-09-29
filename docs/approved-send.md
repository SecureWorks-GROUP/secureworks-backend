# Approved sends

An approved send is one exact email or SMS that the owner has approved. It
lets the recording seat send what he approved to any recipient, with CC, BCC
and attached files, including a reply in an existing thread, and SMS to any
mobile from a named SecureWorks line. Every other send path is unchanged.

Code: `supabase/functions/_shared/approved_send.ts` (rules),
`_shared/approved_send_sms.ts`, `send-outlook-email/approved_send_email.ts`,
`ops-api/approved_send_actions.ts`. Schema:
`supabase/migrations/20260929100000_approved_send_approvals.sql`.

## 1. Record the approval (recording seat only)

`POST ops-api?action=record_send_approval` with a server credential (the
service-role key or `OPS_AGENT_SERVER_KEY`) **and** `x-sw-actor: seat:rayleigh`.
Anything else is refused `approval_recorder_required` and audited.

```json
{
  "channel": "email",
  "approved_by": "marnin",
  "approved_at": "2026-09-29T09:41:00+08:00",
  "approval_words": "<his words, verbatim>",
  "approval_source": "<where he said it: session, channel, time>",
  "expires_in_minutes": 1440,
  "email": {
    "mailbox": "marnin@secureworkswa.com.au",
    "mode": "reply",
    "reply_to_message_id": "<Graph message id in that mailbox>",
    "to": ["client@example.com"],
    "cc": ["shaun@secureworkswa.com.au"],
    "bcc": [],
    "subject": "RE: …",
    "html_body": "<exact HTML; nothing is appended, include any signature>",
    "attachments": [
      { "source": "job_document", "id": "<job_documents.id>" },
      { "source": "email_attachment", "id": "<email_attachments.id>" },
      { "source": "storage_object", "bucket": "comms-attachments", "path": "jobs/…/file.pdf", "name": "Quote.pdf" }
    ]
  }
}
```

SMS instead: `"channel": "sms", "sms": { "to_mobile": "0412 345 678",
"message": "<exact wording>", "from_line": "+61489267771" }` (`from_line`
optional, default +61489267771; any number on `_shared/sms_from_number.ts`).

The first call is a dry run: it returns the exact `payload` and its
`payload_hash`. Check them against his approval, then repeat the call with
`"dry_run": false, "expected_payload_hash": "<payload_hash>"`. The response
carries `approval_id`. `mode: "new"` sends a new email and takes no
`reply_to_message_id`.

## 2. Send it

`POST ops-api?action=send_approved` with a server credential and the body
`{"approval_id": "<id>"}` and nothing else. SMS is sent by ops-api; email is
handed to `send-outlook-email`, which also accepts `{"approval_id": "<id>"}`
directly with the operations credential.

Before anything is consumed the send re-checks the seal, the stored hash, the
status, the expiry and the audit, re-reads every attachment and rebuilds the
payload; its hash must equal the approved hash. Then the approval is claimed,
once. `sent`, `failed` and `outcome_unknown` all consume it; a new attempt
needs a new approval. Never resend after `outcome_unknown`: check the mailbox
Sent Items or the SMS inbox first.

## 3. Read the outcome

`GET ops-api?action=send_approval_status&approval_id=<id>` with a server
credential returns the approval (without its seal) and its audit rows.
