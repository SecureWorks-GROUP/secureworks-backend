---
name: secureworks-dispatch-review
description: >
  Review accepted fencing and patio jobs, organise material requirements, reuse
  existing supply, prepare unsent PO drafts and assess readiness. Never sends,
  purchases, or reschedules crew. Manual terminal and cloud use the same
  dispatch_trigger / dispatch_run / dispatch_command interfaces.
  Trigger: on demand by OPERATIONS. The checked-in worker is disabled.
  Owner: OPERATIONS.
version: dispatch-workflow/v1
---

# secureworks-dispatch-review

Shaun accounts for accepted work that may have no order, no date and no deposit. Groups, notes, allocations, receipts and drafts are review work. A confirmed PO is not a receipt. Live supplier/customer sends stay held.

## Intended path

1. Read the accepted population (`dispatch_list`) until coverage is complete or explicitly partial.
2. Open one job (`dispatch_job`). Quote lines are evidence, not an invented kit.
3. Group and review requirements. Reuse existing PO/stock before preparing a draft.
4. Record physical counts and receipts separately from ordered or paid status.
5. Assess (`dispatch_assess` / `dispatch_trigger` + `dispatch_run`). Assessment does not send.
6. Exact email drafts require separate communication and purchase approvals. Default release remains held.

## Manual

From the Dispatch core checkout:

```bash
bash scripts/dispatch/run-dispatch-worker.sh --once
```

The checked-in `worker.disabled.json` prints `dispatch worker disabled` and makes no network call. That is the current runtime, not a failure of the command.

Page **Refresh evidence** re-reads the selected job and calendar through the same authenticated `ops-api` actions. It does not enable the worker.

**Workflow Refresh** is a separate control. It POSTs `workflow_refresh` `op=start` then reads back. Operators cannot claim or finish. Until the Dispatch driver is registered and the worker can finish `dispatch_refresh/v1`, start is **unavailable**. A source-hash reread is not completed Refresh. CIO overlay `3b19d5dc` consume-hash is not this driver.

To run one bounded assessment cycle after a reviewed enablement (not current default):

```bash
# only after worker.disabled.json is replaced with an enabled loopback config and token
bash scripts/dispatch/run-dispatch-worker.sh --once
```

That posts `dispatch_trigger` then `dispatch_run`. Production activation remains a separate approval.

## Cloud / schedule

Checked-in configuration: `scripts/dispatch/worker.disabled.json`, `enabled: false`, `interval_seconds: null`. No scheduler is installed from this skill. Do not describe the worker as running.

Runtime truth is `GET ops-api?action=dispatch_workflow`. If `worker.mismatch` is true, intended and observed enablement disagree.

## Proof

Isolated PostgreSQL on `127.0.0.1:55581` with rollback fixtures. No live send, purchase, calendar write or production migration. Combined Ops host copies Patio Booking pin `f048ca5` and uses authenticated `sales_booking_*` / `opsFetch`. 4174/4175 JSON preview is not connected. Performance remains unpublished until `public.sales_performance_weeks` exists. CIO projection of `event_at` remains a separate pin.
