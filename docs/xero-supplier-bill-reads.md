# Supplier bill reads

`get_xero_bill` / `get_supplier_bill` and `list_xero_bills` /
`list_supplier_bills` read Xero ACCPAY records without refreshing the local
`xero_invoices` mirror. Provider token maintenance remains the shared auth
boundary. These routes never create, approve, void, pay or send a bill.

Mirror refresh remains in the explicitly requested `trigger_xero_sync` action
and the existing sync lane. Draft create/update actions continue caching their
own completed writes. A bill read must never become a cache-refresh action.

## List scope

- `xero_contact_id` is an optional exact UUID, normalised to lowercase and sent
  as Xero's `ContactIDs` query parameter. An invalid UUID refuses before token
  or provider access. A provider row with a different or absent contact id
  refuses the whole page rather than silently trimming it.
- Existing contact-name, reference and status filters still apply together.
- `filters` returns the applied `xero_contact_id`, `contact_name`,
  `invoice_ref` and canonical `status`, with null for an absent filter.
- Reads remain one bounded provider page. Follow `next_page`; a single full
  page is never an exhaustive supplier history.

## Checks

The supplier-bill suite exercises successful detail/list reads with an
available mirror writer and requires no writes. It also checks exact-contact
query arguments, invalid-input refusal, provider scope violations, pagination
and the unchanged cache shape following an explicit draft write.

After deployment, bracket a detail and exact-contact list read with SELECTs of
the mirror count and relevant row contents/timestamps. Require all returned
contacts to equal the requested contact. Retain private inputs and readbacks
outside this public repository. Concurrent sync can invalidate the comparison;
that is an inconclusive run, not permission to stop the sync or edit records.

Xero documents the exact-contact parameter in its
[Invoices API](https://developer.xero.com/documentation/api/accounting/invoices).
