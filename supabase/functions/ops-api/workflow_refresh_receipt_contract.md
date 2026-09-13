# Refresh driver receipt contract

The shared Refresh API separates three states:

1. `startWorkflowRefresh` requests a scoped run and may return `started` or
   `joined`. It does not claim work or declare completion.
2. An owner worker claims the run with `claimWorkflowRefresh`.
   `consumeWorkflowRefresh` selects and claims one queued run; the owner must
   still perform the assessment. Claiming establishes the lease token,
   generation, a server-issued `driver_request_id`, and expected source
   revision. The request id is the public correlation id for the driver's
   command; the lease token remains secret.
3. A real owner driver captures its scoped source and persists one receipt, then
   finishes the run. Completion requires the persisted assessment and current
   source checks described below.

For Dispatch, the supported adapter version is `dispatch_refresh/v1`.
Operations must register its driver through `register_workflow_refresh_driver`;
this migration preserves the existing registration state. Registration requires
the Dispatch source function and command/plan tables. Until the driver is
registered and those validator dependencies exist, start and consume return
`unavailable` with reason `driver_or_validator_not_registered`.

For an available Dispatch driver, the scope must include an existing `job_id`
in the bound organisation; empty and week-only scopes are rejected before
enqueueing. The owner calls
`finishWorkflowRefresh` with the lease returned by claim and this
receipt shape:

```ts
{
  driver_version: "dispatch_refresh/v1",
  scope: run.scope, // exact scope returned by start/readback, including org_id
  observed_source_revision: revision, // read after the driver's assessment
  output: {
    ok: true,
    declared_output: "dispatch_refresh/v1",
    observed_source_revision: revision,
    output_ref: {
      table: "dispatch_commands",
      command: "assess",
      request_id: run.driver_request_id
    }
    // Optional driver metadata may include work/source_cutoff details.
  }
}
```

Operations must produce that reference by issuing the real scoped Dispatch
`assess` command through `dispatchCommand`/`dispatch_commit` after claiming the
run, using the claimed `driver_request_id` as its `request_id`. The command
must persist the matching `dispatch_plans` version/state/source row, with
`live_actions_enabled: false` in the command result; a job read or arbitrary
JSON assertion is not an output. The receipt's output reference must equal the
run-issued request id, so another same-job command cannot be borrowed.

The API persists that receipt through the service-only
`record_workflow_refresh_receipt` RPC before calling
`finish_workflow_refresh`. The database verifies the run scope, owner, lease
token, generation, driver version, output reference, and the current
Dispatch-owned source revision. It resolves the referenced `assess` command
and checks its persisted plan version, state, and source revision. It repeats
the assessment and source checks at finish. An exact receipt replay is
idempotent; a different receipt for the same run and generation is a conflict.

If a worker is reclaimed, the prior generation's receipt remains immutable and
the new claim receives a new `driver_request_id`. The new generation must
persist its own command and receipt before it can finish. A lost successful
finish response may be retried with the same receipt id, lease, generation and
observed revision; the stored final result is returned without running the
driver again. Different or stale retry identities are refused.

`finishWorkflowRefresh` uses the persisted receipt's source revision; callers
do not need to repeat it at the top level. For completed outcomes, the stored
run result comes from the receipt output plus `receipt_id`, replacing the
caller's `result`.

The receipt must match the source at persistence time, even if that source
differs from the revision captured at claim. Drift before persistence is
rejected with `workflow_refresh_source_changed`. If the source changes after
persistence and the assessment evidence still validates, the database finish
RPC returns `partial` with `completion_note: source_changed_after_assessment`
in the stored result. A missing or failed source read, or invalidated command
or plan evidence, rejects completion and leaves the run running.

Partial or failed outcomes may include a driver error result without a
receipt. If a consumer cannot claim a queued run, it records that run as failed
with the claim error so later consume calls can progress. Receipt rows are
private; readback exposes the stored run result without the lease token.

Other workflow owners remain unavailable until they register their own
validator and output contract. This adapter does not implement those domain
drivers.
