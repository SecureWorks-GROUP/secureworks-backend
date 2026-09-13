# Refresh driver receipt contract

The shared Refresh API separates three states:

1. `startWorkflowRefresh` requests a scoped run and may return `started` or
   `joined`. It does not claim work or declare completion.
2. An owner worker claims the run with `claimWorkflowRefresh` (or consumes it
   through `consumeWorkflowRefresh`). Claiming establishes the lease token,
   generation, and expected source revision. Claiming is work ownership, not a
   verified result.
3. A real owner driver captures its scoped source and persists one receipt, then
   finishes the run. A completed run must carry a receipt; a source change at
   finish is returned as `partial`.

For Dispatch, the current registered adapter is `dispatch_refresh/v1`. The
owner calls `finishWorkflowRefresh` with the lease returned by claim and this
receipt shape:

```ts
{
  driver_version: "dispatch_refresh/v1",
  scope: run.scope, // exact scope returned by start/claim, including org_id
  observed_source_revision: revision, // read after the driver's assessment
  output: {
    ok: true,
    declared_output: "dispatch_refresh/v1",
    observed_source_revision: revision,
    work: {
      jobs_read: 12, // at least one scoped job must be read
      source_cutoff: "2026-09-13T00:00:00Z"
    },
    output_ref: {
      table: "dispatch_commands",
      command: "assess",
      request_id: "<dispatch_commit request UUID>"
    }
  }
}
```

Operations must produce that reference by issuing the real scoped Dispatch
`assess` command through `dispatch_commit` after claiming the run. The command
must persist the matching `dispatch_plans` version/state/source row; a job read
or arbitrary JSON assertion is not an output.

The API persists that receipt through the service-only
`record_workflow_refresh_receipt` RPC before calling
`finish_workflow_refresh`. The database verifies the run scope, owner, lease
token, generation, driver version, output reference, and the current
Dispatch-owned source revision. It resolves the referenced `assess` command
and checks its persisted plan version, state, and source revision. It also
rechecks the source at finish. An exact receipt replay is idempotent; a
different receipt for the same run is a conflict.

Partial or failed outcomes may include a driver error result without a
receipt. Missing or failed source validation leaves the run unavailable or
running and cannot become a declaration-only completed run. Receipt rows are
private; readback exposes the verified output and receipt id without exposing
the lease token.

Other workflow owners remain unavailable until they register their own
validator and output contract. This adapter does not implement those domain
drivers.
