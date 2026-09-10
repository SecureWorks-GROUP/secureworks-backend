# Proposed SMS acceptance receipts

`send_proposed_sms` claims one pending proposal as `approved` before its provider request. Its `action_payload.sms_dispatch` retains the attempt ID, action/job/contact IDs and SHA-256 of the exact message. Claim and completion checks bind those identities; concurrent approvals and status-only resets cannot replay a retained attempt.

A checked `business_events` receipt uses `entity_type=ai_proposed_action`, `entity_id=proposal_id` and matching `payload.action_id`. Its outcomes are:

- `proposed_action.dispatched`, `outcome=provider_accepted`: positive proxy response and nonempty string GHL message ID. This proves acceptance, not delivery, customer agreement or a calendar booking.
- `proposed_action.dispatch_failed`, `outcome=rejected`: explicit pre-send dedup refusal. It does not deny that a prior attempt may have sent the same message.
- `proposed_action.dispatch_unknown`, `outcome=unknown`: transport, HTTP, malformed/missing receipt or generic `success:false`. The provider may have accepted the request. Do not resend automatically.

`observed_at` and event `occurred_at` are local response-observation times. No provider timestamp or conversation identity is inferred. Raw provider error bodies are not retained. The proposal stays `approved` after both accepted and uncertain sends: status records approval, not send or delivery truth. Once the checkpoint and receipt are checked, conditional finalization sets `sent_at` to the local acceptance-observation time and returns `success:true`, `outcome:provider_accepted`, `proposal_status:approved`, the provider message ID and receipt event ID. A checked accepted receipt may exist even if finalization failed; that response requires reconciliation. Never issue a new send merely to repair local state. There is no automatic recovery or retry endpoint in this change.

## Release boundary

No migration is required. Production's existing five-value approval enum remains `pending`, `auto_approved`, `approved`, `rejected`, `expired`. The actual handler tests enforce that exact set and prove success with `approved` plus `sent_at` and an accepted receipt. The tests import the production entry point, use synthetic database/provider fixtures, and are wired into PR CI. No customer SMS was sent to test this patch.

The initial draft proposed adding `sent` to the enum. Release review withdrew that change because it would unblock the old manual-dispatch pre-send status write before repaired code deployed. The final patch preserves the existing schema and uses the receipt as dispatch truth. No historical proposals are relabelled.

The separate `manual_dispatch` and quote-follow-up handlers are unchanged. Their legacy receipts/statuses must not be promoted to this contract without their own acceptance checks. The generic handler's previous uncorrelated local `job_events.sms_sent` write is replaced by this checked action receipt; GHL proxy capture is unchanged.
