# Patio pay routing and voided invoice release

With `patio_pay_group_only_v1` on, an ordinary paid or submitted claim no
longer exempts a later patio job from group pay. The boundary is the first
patio group's earliest genuine scheduled allocation. The first group is
selected by creation time and id inside the organisation; a historical void
does not remove it from that history. Ghost, observer and cancelled rows do
not set the boundary. Allocation reads are paged.

Only a job first genuinely scheduled before that boundary, already carrying
an ordinary live claim and without a live group may finish by hours. A later
touch-up on that older job retains its route. Missing dates or transition
evidence grant no hourly exemption. Existing claims are retained and still
block creating a second payment route; the office must reconcile them.

`my_group_work_orders.payable_routes` and the ordinary-pay submission guard
use the same scheduling read. Existing groups always require shares. Both
running-draft saves and submissions already reach the guard. A group share,
commission, travel, materials and office milestone fee keep their existing
classification. No flag, rate, budget, hours, sign-off or paid claim is changed.

The Trade App already consumes these routes: group jobs lose the hourly
mode, missing groups show Create or the office setup reason, and Job details
opens the existing group hour form with date, start, finish and break fields.
Hours remain loggable before completion; share finalisation keeps its current
crew-approval and sign-off gates.

## Release an invoice whose bill was voided

`POST ops-api?action=release_voided_trade_invoice` requires an authorised
office JWT in this organisation or a privileged server credential. Routine,
agent-read and trade callers cannot use it. Supply `invoice_id`,
`expected_xero_bill_id`, `confirm: true` and a non-empty `reason`.

The action refuses unless the local invoice is pushed, has the expected
external identity, records zero paid, has no paid date and contains no group
shares. It freshly reads that exact Xero ACCPAY bill, requiring VOIDED,
explicit zero paid and no payment, credit, overpayment, prepayment or batch
allocation. A mirror status, missing bill, AUTHORISED or DELETED is never
enough. Provider read errors save nothing.

One compare-and-set changes the local invoice to `ops-reject` and stores the
provider check, tenant, actor, reason, timestamp and previous review note in
`override_details.voided_release`. Existing override fields remain. The CAS
checks the external identity, local status/payment and review fields. A
changed record refuses. A verified repeat is idempotent. Unexpected legacy
override shapes require office review.

The original invoice, external pointers, lines and assignment links remain as
history. Existing released-status rules free its week and ordinary claim
locks; a corrected submission creates its own invoice and must pass every
current patio and duplicate guard. Thus an eligible older-job touch-up can
be resubmitted while a later group job's hours remain refused. The endpoint
does not void, recreate, push, pay or send anything in Xero, and it does not
freeze or reopen a group. Group-share corrections keep their existing group
procedure.

## Bounded verification

The group and release suites cover earlier/later jobs, a prior ordinary paid
claim, group precedence, unknown dates, nullable allocation status, paginated
allocations, a voided historical anchor, preserved invoice history, replay,
provider settlement refusals, caller and organisation boundaries, and a
payment or office review racing the local write. Full ops-api type checking
is required. Local fixtures are synthetic; real invoice release and the
connected end-to-end journey remain a separately authorised live check.
