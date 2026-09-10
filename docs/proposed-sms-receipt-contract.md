# Proposed SMS acceptance receipts

`send_proposed_sms` claims one pending proposal as `approved` before its provider request. Its `action_payload.sms_dispatch` retains the attempt ID, action/job/contact IDs and SHA-256 of the exact message. Claim and completion checks bind those identities; concurrent approvals and status-only resets cannot replay a retained attempt.

A checked `business_events` receipt uses `entity_type=ai_proposed_action`, `entity_id=proposal_id` and matching `payload.action_id`. Its outcomes are:

- `proposed_action.dispatched`, `outcome=provider_accepted`: positive proxy response and nonempty string GHL message ID. This proves acceptance, not delivery, customer agreement or a calendar booking.
- `proposed_action.dispatch_failed`, `outcome=rejected`: explicit pre-send dedup refusal. It does not deny that a prior attempt may have sent the same message.
- `proposed_action.dispatch_unknown`, `outcome=unknown`: transport, HTTP, malformed/missing receipt or generic `success:false`. The provider may have accepted the request. Do not resend automatically.

`observed_at` and event `occurred_at` are local response-observation times. No provider timestamp or conversation identity is inferred. Raw provider error bodies are not retained. Every attempted send stays held until its checkpoint, receipt and conditional finalization are checked. Accepted receipts can coexist with an `approved` proposal if finalization failed: reconcile the attempt, never issue a new send merely to repair local state. There is no automatic recovery or retry endpoint in this change.

## Deployment prerequisite

Migration `20260910105833_proposed_sms_sent_status_receipt.sql` must run before the handler release. The read-only live schema check found `ai_proposed_actions_status_check` allows exactly `pending`, `auto_approved`, `approved`, `rejected`, `expired`; existing handlers already tried to write the prohibited `sent` value. The migration adds only `sent`, preserves NOT NULL and all old values/rows, and fails closed on an unexpected column or constraint definition. Reapplying the exact target definition is harmless. It does not relabel historical proposals or prove any prior send.

The registered PostgreSQL migration contract tests real allowed/refused writes, preserves an existing row, rejects an unexpected pre-existing status policy, and deliberately removes `sent` to prove the contract fails. The actual handler tests import the production entry point and use synthetic database/provider fixtures. Both are wired into PR CI. Release must verify the live constraint and retained receipt shape; this patch was not tested by sending a customer SMS.

The separate `manual_dispatch` and quote-follow-up handlers are unchanged. Their legacy receipts/statuses must not be promoted to this contract without their own acceptance checks. The generic handler's previous uncorrelated local `job_events.sms_sent` write is replaced by this checked action receipt; GHL proxy capture is unchanged.
