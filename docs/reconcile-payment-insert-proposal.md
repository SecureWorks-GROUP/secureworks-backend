# Reconcile payment insert

`ops-api` `reconcile_payment` posts a Xero payment, then tries to insert a `job_events` row of type `payment_recorded`. That insert names no `job_id`. `job_events.job_id` is `NOT NULL`, so the row does not land. The `try/catch` around it does not see the failure either: PostgREST returns `{ error }` and does not throw. This is the behaviour restored in the send-fields change. No new live insert was added.

## Why it matters

A recorded payment is the evidence a ledger reading uses to close "they paid". Without the row, the payment exists in Xero and on the invoice mirror, and the job story does not have a payment event of its own. Putting `job_id` on the insert would make the row land. That is a live money-path write, and it is not decided here.

## Design, if it is turned on

One row per Xero payment, never a second row for the same payment.

- Unique on `detail_json->>'payment_id'` for `event_type = 'payment_recorded'`. A retry of the same Xero payment id inserts nothing.
- `job_id` comes from the invoice the gate already resolved (`assertLegacySesInvoiceActionAllowed`), not from the request body.
- The event records the payment id, the amount, the date and the invoice id. It does not set `jobs.status`, `xero_invoices.status`, or `fully_paid_on`.
- A partial payment never closes the invoice as paid. Paid stays the Xero invoice status. One payment row is not "the invoice is paid".
- The insert checks `{ error }`. A unique violation is success (the payment was already recorded). Any other error is logged and does not change the Xero result already returned.

Until that is accepted, `reconcile_payment` keeps the insert that does not land.
