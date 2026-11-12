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
call the same release helper. The office writer asks on every move into an
open status past acceptance (`job_work_order_open_statuses()` less
`partially_accepted`), not only `accepted`, and the database applies the same
rule (`20261110200000`, TK-S28): a card moved straight from quoted to Deposit
or Scheduled is released there, and one whose release was held at acceptance
is retried when the deposit moves it on (`awaiting_deposit`,
`order_materials`). An already released draft answers at once. It consumes the existing
`acceptedRevisionForOrders` decision. A named accepted source must match the
prepared revision. A legacy acceptance uses the existing accepted-cost pin
when present, and also requires the prepared revision to remain current.
Unknown or conflicting acceptance provenance leaves the work order held and
records a diagnostic. The customer's acceptance is retained. Any later office move
into an open status retries a held release. Partial acceptance cannot release.

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

The open-status release (`20261110200000`, TK-S28) changes only the release
function body and the office status writer. Undo its function code first, then
apply `supabase/rollbacks/20261110200000_scope_draft_release_open_status_down.sql`;
a release already recorded stays recorded.

## Each payer is a party on the job (RQ-17.c)

A shared fence has one quote and one invoice per payer. After a prepare saves
the drafts, ops-api calls `register_scope_payer_parties` (`20261111120000`,
service role only) with the same job, revision and organisation. It reads only
the `parties` of the revision the drafts were prepared from and writes each
payer through the one party writer, `upsert_job_party`, keyed by its payer id:
the client is the owner party (`primary`, whose name and ids still follow the
job), each other payer keeps its id (`nb-1`, ...) with its own name, contact
details, role and share of the quote. Only a contact detail the quote gives
is sent: one it leaves out or blank is not, so the party keeps what it holds
(the writer overwrites any key it is sent, null included). So each payer's
deposit, its own invoice and the deposit gate read one party row per payer.

A payer an earlier registration made that the current quote no longer names
stops paying: the function soft-removes it through the same writer (`status`
removed; the row and its receipts stay), so it neither holds the deposit gate
nor stands in for a payer the quote now needs. Only rows this function
registered (a `job_party_events` receipt with actor `scope_payer_parties`); the
owner is never removed, and a party it never registered is left alone. A
removed payer named by a later quote comes back as the same party. A quote with
one payer writes nothing on a job this function never registered; on one it
did, it removes the earlier payers and gives the owner the whole quote.

An older party row with no key is adopted, never doubled: the owner by
`is_primary`, a neighbour only by an equal phone or email. An older neighbour
row it cannot match refuses the whole call
(`scope_payer_parties_legacy_unmatched`) rather than leave two parties for one
share; match it by hand and prepare again. Every refusal rolls the call back.

The prepare response carries `payer_parties`: the function's answer
(`outcome` `registered` with one `{payer_id, job_contact_id, label,
source_party_key, outcome}` per payer, or `single_payer`, each with `removed`:
one `{job_contact_id, label, source_party_key, outcome}` per payer removed), or
`{outcome: "refused", code}`. A refusal never undoes the saved drafts, and the
deposit gate (`docs/job-deposit-gate-v1.md`, `payer_without_party`) keeps the
job held while the quote names a payer the job has no party for. Nothing is
sent, no Xero contact or invoice is made, and no job is backfilled: a job
prepared before this change registers its payers on its next prepare.

Undo: revert this change's function code first, then apply
`supabase/rollbacks/20261111120000_scope_payer_parties_down.sql`. Party rows
already written stay; they are ordinary parties with their receipts.
