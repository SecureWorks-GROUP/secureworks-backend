# Job deposit gate v1 (RQ-19.e)

Owner, 10 Nov 2026: no materials are ordered and no crew starts until every
paying party (the client and each neighbour on a shared fence) has accepted
and paid its deposit. The override is the owner and the office, with a reason
recorded.

## One rule

`ops-api/job_start_deposits.ts` is the only judge. `judgeDepositGate(job)`:

| Step | Answer |
|---|---|
| Job not a deposit-advance type (`isDepositAdvanceJobType`), or a repair / report-only make-safe | open, `not_gated` |
| `job_not_yet_accepted(job)` true | held, `job_not_accepted` |
| The sealed quote's payer drafts (`scope_job_draft_invoices` on the current draft set's revision, `scope_job_draft_sets.scope_revision_id`; a known 0 share excluded; rows kept from an older revision and rows with no draft set never count) name more payers than the job's paying parties (at least one) | held, `job_deposits_unpaid`, `payer_without_party:<n>` |
| Every paying party (`job_contacts`) has a live deposit invoice of its own, PAID | open, `paid` |
| Otherwise | held, `job_deposits_unpaid` with the reasons |
| Any read fails | held, `job_deposits_unreadable` |

"Paid" is the same rule `docs/job-deposit-advance-v1.md` uses. Never re-derive
it in a caller.

`assertJobDepositsBeforeWork(client, job, purpose)` throws a 409
`JobStartDepositError` when held, unless a live override exists. An override
that cannot be read never opens the gate (`job_deposits_unreadable`). Purpose
`start` reads "Work cannot start ...", `materials` reads "Materials cannot be
ordered ...".

## Where it is checked

Crew start (purpose `start`), installation work only (`isInstallationAssignment`;
scope visits, meetings, delivery and ghost watchers are not gated): a trade
clocking on, starting travel, arriving or resuming; an assignment or a trade's
own job phase moving to started; an office edit that starts an assignment; the
job moving to `in_progress`.

Supplier orders (purpose `materials`), at the send only, never at a draft:

- `email_po` (`ops-api/index.ts`), when the order names a job
- `dispatch_order_send` (`dispatch_orders_store.ts`), after the sendable check
- Dispatch v2 supplier order email (`dispatch_v2_store.ts`), real sends only
  (a test send goes to our own admin address)
- `send-po-email`, real sends only (`_holdPoEmailForDeposits`)

Not gated, on purpose: drafting, editing or making an order email; `create_po`
and quote builder orders; `push_po_to_xero` (a Xero draft, not an order to the
supplier); a supplier reply; recording an Outlook order already sent; the
by-hand material stage; an order with no job.

## Override

Table `job_deposit_gate_overrides` (`20261111110000`), one live row per job,
append-only apart from a one-way revoke. RLS on, revoked from every browser
role, read by the service role only. Rows are written only by
`grant_job_deposit_gate_override` and `revoke_job_deposit_gate_override`
(SECURITY DEFINER, service role only). Each checks the person's role
(admin, owner or ops_manager) and company, a reason of at least 10 characters,
and writes one `job_events` row (`deposit_gate_overridden` /
`deposit_gate_override_revoked`).

Staff doors (`ops-api/job_deposit_gate_override.ts`):

| Action | Method | Does |
|---|---|---|
| `job_deposit_gate` | GET | the gate as it stands: `open`, `held`, `overridden` or `unreadable`, with reasons and the live override |
| `override_job_deposit_gate` | POST | records an override with a reason; refused when the gate is open, already overridden or unreadable |
| `revoke_job_deposit_gate_override` | POST | ends the live override with a reason |

Only a signed-in person may grant or revoke. The ops key is refused
(`deposit_gate_override_needs_person`), so no machine path can lift the gate.

## Deploy order

Apply `20261111110000_job_deposit_gate_overrides.sql` before `ops-api` and
`send-po-email`. `send-po-email` imports `ops-api/job_start_deposits.ts`; a
later change to that file alone does not redeploy `send-po-email`, so redeploy
it by hand when the rule changes.
