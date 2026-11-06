# Frozen scope job drafts

RQ-17.c and TK-S28, 6 Nov build round. These records are local job drafts.
Preparation never calls Xero, GHL, a sender, a payment-link producer or a
work-order approver. Existing acceptance side effects and deposit/office gates
are unchanged.

Both actions are POSTs to ops-api:

- `prepare_scope_job_drafts`
- `read_scope_job_drafts`

Body: `{job_id, scope_revision_id}` only. Extra fields, including money and
acceptance claims, are refused. Staff sessions use their server-owned profile
organisation. The ops key uses the configured organisation. Trades, routine
and read-agent callers are refused. The private RPCs are service-role only.

Response:

```ts
{
  job_id: string,
  scope_revision_id: string,
  work_order: {
    id: string,
    status: 'draft' | 'released',
    labour_total_ex_gst: number | null
  },
  invoices: Array<{
    id: string,
    payer_id: string,
    status: 'draft',
    ex_gst: number | null,
    gst: number | null,
    inc_gst: number | null
  }>,
  amounts_confirmed: boolean,
  xero_writes: false,
  sent: false,
  payment_links: false
}
```

Preparation requires the latest revision to be frozen on that fencing or patio
job. It verifies the stored scope and pricing byte contracts, then reads only
that revision's pricing. Payers use `parties[].id`, `ex_gst`, `gst`, `inc_gst`
and the private `billing_contact`. Without parties, the solo payer is
`__client__` from `totalExGST`, `gst`, `totalIncGST`. Missing or non-numeric
money is null and `amounts_confirmed` is false. Known totals and each payer's
figures must reconcile in integer cents, including each tax subtotal. Negative
and sub-cent figures are refused. Unknown never becomes zero.

`labourCostEstimate` and `internal.labour_lines` bind the work order.
When the frozen pricing has a labour total and no itemised labour, preparation creates one group labour allowance line for that exact total.
Priced labour lines must add to the frozen total in cents.
The same
`work_orders.kind = job` row is retained, linked by `jobs.work_order_id` and
`work_orders.scope_revision_id` and the existing
`quote_filled_scope_revision_id` consumed by work-order readers. There is no second crew work order or group
split. Saving the frozen source replaces earlier lines on an editable draft, including manual placeholders, with the saved revision's labour.
An approved work order, a set approval timestamp or a content seal refuses every refill.
A new frozen revision may refill the unaccepted draft with the same id.
Payer ids retain their invoice ids. A removed payer's old row remains stored
under its old revision and is omitted from the current response. Once partial
acceptance starts, a prepared revision cannot be replaced.

Read returns persisted identities and totals, never a fresh calculation.
For fencing and patio, `freeze_scope` also prepares these drafts after freezing and returns `job_drafts: {status, data}` beside the saved revision.
This runs on repeated freezes too, so a retained frozen revision can repair a missed handoff.
The freeze requires staff access and the job's server-owned organisation before it writes.
A failed handoff leaves the frozen revision saved and returns its distinct hold or unavailable code inside `job_drafts`; clients must show that result rather than claim the work order was saved.
The explicit preparation action remains available with the same body and response for retry and readback.
Absent drafts return 404. A different or stale revision returns 409. After
release the accepted revision remains readable even if later superseded.
Preparation while the released source remains current returns the retained
record; it cannot replace it with a later source.

Both send-quote acceptance branches and the office's `update_job_status`
accepted path call the same release helper. It consumes the existing
`acceptedRevisionForOrders` decision. A named accepted source must match the
prepared revision. A legacy acceptance uses the existing accepted-cost pin
when present, and also requires the prepared revision to remain current.
Unknown or conflicting acceptance provenance leaves the work order held and
records a diagnostic. The customer's acceptance is retained. A repeated office
accepted save can retry a held release. Partial acceptance cannot release.

Release locks the job and stores one release time and one event. It changes
neither the work-order approval status nor any invoice status. `released` in
this contract means the accepted source is ready for the existing office
process. Approval, group participation, sign-offs and crew pay still use their
existing gates. The ordinary work-order editor cannot change these source
lines or approve this draft before release.

## Production and undo

The additive migration creates two private tables, three draft RPCs, a cents
helper and a guard on source-bound work orders. It backfills no jobs, enables
no flags and creates no accounting entries. The schema preflight declares the
migration for both functions. Production schema names and the unused migration
version were checked read-only before building.

Undo: revert this change's function code first, then apply
`supabase/rollbacks/20261106040518_scope_job_drafts_down.sql`. It removes the
RPCs and guard while retaining every local invoice, release record and work
order. Do not delete the tables or existing work orders to undo this feature.

Local checks cover stored drafts, cent reconciliation, repeated calls, source
changes, unknowns, partial/full acceptance and existing work-order guards.
Full live Scope Engine, Dispatch and Job Profit proof belongs to the shared
whole-job test round after the build PRs land.

The saved handoff follow-up changes only the preparation function and the fencing/patio freeze action.
It makes no automatic backfill.
Undo its function code first, then apply `supabase/rollbacks/20261106062000_scope_work_order_saved_handoff_down.sql` to restore the earlier draft-content policy while keeping all stored lines, invoice drafts and revision links.
