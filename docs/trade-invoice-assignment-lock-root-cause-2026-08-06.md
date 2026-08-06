# Trade invoice submission fails: "Only stamped 0 of 6 assignments"

Root cause analysis, 2026-08-06. Captain-reported with screenshot.
All live inspection below was read-only SELECT. Nothing was mutated.

## Symptom

Trade App Pay tab, trade Alyx (`2f00f91e-8b76-4856-8dec-ab6041f04e1d`),
week 2026-06-29, invoicing SecureWorks Group Pty Ltd. Red toast:

> Failed: Failed to lock invoiced job cards before Xero push: Only stamped 0 of 6 assignments

The trade saw one row on screen (SWF-26615 FENCING, Ben Jones, $180.00) and
three other searched-in lines, $420.00 total. The server reported six
assignments she never selected and could not see.

## Mechanism

`ops-api/index.ts`, `generate_trade_invoice`. Layer B stamps `invoiced_in` on
every assignment referenced by the invoice's lines, and requires an exact
N-of-N match before the Xero push:

```
UPDATE job_assignments SET invoiced_in = <new invoice>
 WHERE user_id = <trade> AND id IN (<expected>)
   AND (invoiced_in IS NULL OR invoiced_in IN (<released invoices>))
```

`RELEASED_INVOICE_STATUSES` is `draft`, `failed`, `ops-reject`. Anything else
is LIVE and holds its assignments.

Read-only reproduction of that exact WHERE against the six ids:

| expected | found | would stamp | claimable via released | holding invoice statuses |
|---|---|---|---|---|
| 6 | 6 | **0** | 0 | `pending_acknowledgment`, `pushed_to_xero` |

`found = 6` is why the earlier "Only found X of N" guard passed. All six were
held by LIVE invoices, so zero were claimable. Not an id mismatch, not column
drift, not RLS (the handler uses the service-role client), and **not ghost rows**
(`is_ghost = false` on all six, so branch `fm/trade-board-stale-schedule-backend-source-fix`
is unrelated and untouched here).

## Trigger

Three defects compounded.

### 1. Read/write asymmetry in the clocked lane (root cause)

`my_hours`, the read that paints the Pay tab, drops assignments held by a live
invoice (`index.ts`, "Layer B double-invoice guard"). The manual submit lane has
the same guard and 409s with `ALREADY_INVOICED`. The **legacy clocked lane** did
not: it re-queried `job_assignments` server-side on `user_id` + `status='complete'`
only, with no `invoiced_in` filter.

So the Pay tab correctly hid six already-billed job cards; the trade therefore
ticked nothing; `hasManualAssignments` was false; the handler fell into the
clocked lane, which silently re-added exactly those six hidden cards. **The read
model hiding the cards is what forced the submission into the unguarded lane.**

All six are `status='complete'` with `hours_worked = NULL` and no clock events,
so they produced six $0.00 / 0.00h lines. The real $420.00 came from four
searched-in extra lines carrying `assignment_ids = NULL`.

### 2. The stamp was not atomic

The UPDATE ran first and the row count was checked afterwards, so a partial
match mutated the rows it did match and then threw.

Timeline for the incident:

| time (UTC) | invoice | outcome |
|---|---|---|
| 2026-07-14 15:23 | `b4b91266` | manual lane, stamped 4 of 4, **pushed to Xero** |
| 2026-08-06 02:56 | `04488d17` | clocked lane, "stamped 2 of 6", threw. **The 2 stayed stamped.** |
| 2026-08-06 03:18 | `ad245628` | clocked lane, now 4 + 2 held. "stamped 0 of 6" |

The 02:56 half-claim is what converted a recoverable failure into a permanent
wedge. It also left two orphan invoices and a duplicate.

### 3. The failure status is unreachable, so failures never released

`failAssignmentStamp` wrote `trade_invoices.status = 'failed'`. Migration
`20260611000001_trade_invoice_guards.sql` defines:

```
CHECK (status IN ('draft','pending_acknowledgment','queried','acknowledged',
                  'pending_ops_review','approved','pushed_to_xero','paid','ops-reject'))
```

`'failed'` is not in it. PostgREST *returns* the CHECK violation rather than
throwing, the code discarded it, and the invoice stayed at
`pending_acknowledgment`, a LIVE status. Consequences:

- no `query_note` diagnostic was ever written (both orphan invoices have an empty note),
- there are zero `status='failed'` rows in `trade_invoices`, so `'failed'` in
  `RELEASED_INVOICE_STATUSES` is dead code,
- every failed submission held its job cards forever.

## Masking condition: why other trades and weeks still work

- **The manual lane was always guarded.** `b4b91266` billed four of these same
  six assignments at 2.00h x $40.00 on 2026-07-14 and pushed to Xero cleanly.
  Its lines show 2.00h against assignments whose `hours_worked` is NULL, which
  only the manual lane can produce.
- **Most invoices never enter Layer B.** Alyx's earlier invoices
  (`6a34533e`, `e49b4597`, `cab191f7`, ...) have zero assignment-bearing lines,
  so the stamp block is skipped entirely.
- **The clocked lane almost never carries money.** Fleet-wide, only 3 of 654
  `status='complete'` assignments have `hours_worked > 0`.

The bug needs all of: clocked lane + a week containing `status='complete'` cards
+ those cards already held by a live invoice. Alyx's week was the first to hit it.

## Fix

`supabase/functions/ops-api/trade_invoice_assignment_lock.ts` (new, pure) plus
three edits in `index.ts`:

1. **Clocked lane** selects `invoiced_in`, resolves referencing invoice statuses,
   and drops live-held cards via `selectUnlockedAssignments` (matching `my_hours`
   and the manual lane). Skipped silently, not 409: the trade cannot deselect a
   card they were never shown. Also drops never-clocked rows via
   `isClockedAssignmentBillable`, because a $0 line still stamps `invoiced_in`
   and permanently consumes the card.
2. **Layer B decides before writing.** `planAssignmentLock` classifies every
   expected id from the candidate read; if any is not claimable the submission
   fails with no mutation at all. A dangling `invoiced_in` is treated as blocked,
   never silently overwritten. If the UPDATE still under-matches (concurrent
   submission) the claim is rolled back with `invoiced_in = NULL WHERE
   invoiced_in = <this invoice>`, which can only touch rows this statement
   claimed. The refusal message now names the job cards.
3. **Failure status is `'draft'`**, which is CHECK-legal *and* in
   `RELEASED_INVOICE_STATUSES`, so a failed submission releases its assignments
   and the next submission for that week re-uses the row instead of orphaning
   another invoice. Both `status: 'failed'` writes to `trade_invoices` are gone
   and the update error is now surfaced.

## Read-only verification

Clocked-lane collection for Alyx, week 2026-06-29:

| pre-fix collected | after live-invoice filter | post-fix collected |
|---|---|---|
| 6 | 0 | 0 |

All six are excluded, so `includedAssignmentIds` is empty, Layer B is skipped,
and the $420.00 of genuine searched-in extras pushes to Xero. The submission
succeeds. The empty-assignments path is already proven in production by every
prior Alyx invoice.

Over-match check, fleet-wide across all 654 `status='complete'` assignments:

| still collected, unchanged | newly excluded, already billed | newly excluded, never clocked |
|---|---|---|
| 3 | **0** | 651 |

**No assignment carrying real hours is newly excluded.** The 651 are all $0.00
rows that the old lane would have billed at nothing while permanently consuming
them; 503 of those are still unstamped and were at risk.

## Note on the reported acceptance criterion

The brief asked for proof that the fixed logic "matches all 6 of Alyx's
assignments". The evidence disproves the premise behind it. Four of the six were
genuinely billed and pushed to Xero on `b4b91266`, so stamping 6 of 6 today would
double-bill. Refusing them is correct; the defect is that they were collected
into the invoice at all. The fix removes them upstream, which is what lets the
submission complete.

## Outstanding live-data remediation (not done here, needs Marnin/Shaun)

This branch changes code only. The existing bad state is untouched:

- `04488d17` and `ad245628`: two orphan `pending_acknowledgment` invoices,
  week 2026-06-29, $420.00 each, never pushed to Xero. `04488d17` has zero lines.
- Assignments `027bb8f4` and `2d77301a` remain wrongly held by `04488d17`
  from the 02:56 half-claim.

Cleanup is a live-money mutation and is out of scope for this task.
