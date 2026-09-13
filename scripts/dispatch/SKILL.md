---
name: secureworks-dispatch-review
description: >
  Review accepted fencing and patio jobs, organise material requirements, reuse
  existing supply, prepare unsent PO drafts and assess readiness. The default
  skill path does not send, purchase or reschedule crew. Manual terminal and cloud use the same
  dispatch_trigger / dispatch_run / dispatch_command interfaces.
  Trigger: on demand by OPERATIONS. The checked-in worker is disabled.
  Owner: OPERATIONS.
version: dispatch-workflow/v1
---

# secureworks-dispatch-review

Shaun accounts for accepted work that may have no order, no date and no deposit. Groups, notes, allocations, receipts and drafts are review work. A confirmed PO is not a receipt. Live supplier/customer sends stay held.

## Intended path

1. Browse `dispatch_list` using the [queue and coverage contract](../../docs/dispatch/workbench.md#http-contract), keeping current material work separate from acceptance resolution and history.
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

The checked-in `worker.disabled.json` prints `dispatch worker disabled` and makes no network call. This describes the checked-in invocation, not an observation of any running worker.

Page **Refresh evidence** re-reads the selected job and calendar through the same authenticated `ops-api` actions. It does not enable the worker.

**Workflow Refresh** is a separate control. Follow the [operator Refresh contract](../../docs/dispatch/workbench.md#http-contract) for start/readback and the held completion boundary.

To run one bounded assessment cycle after a reviewed enablement (not current default):

```bash
# only after worker.disabled.json is replaced with an enabled loopback config and token
bash scripts/dispatch/run-dispatch-worker.sh --once
```

That posts `dispatch_trigger`, `dispatch_run` and the server-only `dispatch_refresh_worker`. Production activation remains a separate approval.

## Cloud / schedule

Checked-in configuration: `scripts/dispatch/worker.disabled.json`, `enabled: false`, `interval_seconds: null`. No scheduler is installed from this skill. Do not describe the worker as running.

Inspect `GET ops-api?action=dispatch_workflow` using the [worker status contract](../../docs/dispatch/workbench.md#http-contract).

## Proof

See the [Dispatch owner document](../../docs/dispatch/workbench.md#persistence-and-release) for proof boundaries and release limitations.
