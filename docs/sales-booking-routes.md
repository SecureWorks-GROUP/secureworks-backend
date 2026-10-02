# Booking routes (2 Oct 2026)

Who books which lead, and which GHL calendar the visit goes into, is a table
the owner changes himself: `public.sales_booking_routes`
(migration `20261002090000_sales_booking_routes`). Matching code:
`supabase/functions/ops-api/sales_booking_routes.ts`; the edit door:
`sales_booking_routes_actions.ts`; tests: `sales_booking_routes_test.ts` and
the SQL contract `supabase/tests/migration-contracts/20261002090000_sales_booking_routes/`.

## A rule

| Field | Meaning |
| --- | --- |
| `id` | Stable slug, `^[a-z0-9][a-z0-9_-]{0,63}$` |
| `position` | Read order, lowest first (1 to 10000) |
| `enabled` | Off means the rule is skipped |
| `label` | Plain words for the screen (optional) |
| `match_trade` | `fencing` or `patio` (from the GHL pipeline), or empty for any |
| `match_lead_source` | `stratco` (any Stratco signal) or `normal` (a positive non-Stratco signal), or empty for any; the signals are `salesBookingLeadKind` |
| `match_tag` | One GHL tag on the contact or opportunity (case-insensitive), or empty |
| `match_pipeline_id` | One GHL pipeline id, or empty |
| `person` | `marnin`, `khairo` or `nithin` (`sales_booking_sender.ts`; a new person needs their line in code first) |
| `calendar_id` | The GHL calendar the visit is booked into |
| `calendar_name` | Plain name for the screen (optional) |

Every condition a rule sets must hold; an empty condition matches anything.
Enabled rules are read in `position` order (then `id`) and the first match
wins.

- **Unassigned lead:** the first matching rule's person takes it and books
  into its calendar.
- **Assigned lead:** the GHL assignee always wins. Only that person's rules
  are read: the first that fully matches, else (GHL already chose the person)
  their first rule for that trade and pipeline. A person with no rule for the
  trade can still be texted but not booked.
- **No match:** the lead is shown, flagged, on the list of the person who
  holds that trade's unrouted leads (fencing Marnin, patio Nithin:
  `SALES_BOOKING_RESOURCES[].holds_unrouted`), and nothing can be approved,
  texted or booked until a rule or a GHL assignee claims it
  (`booking_route_missing`, with a plain message).
- **A fact could not be read:** a rule that needs the lead's source or tags
  when they could not be read stops the search there
  (`booking_route_lead_source_unread` / `booking_route_tags_unread`). A later,
  broader rule never catches a lead an earlier rule might have claimed.
- **Table unreadable:** no unassigned lead is routed and nothing is
  bookable (`booking_routes_unreadable`).

## Seed (owner, 28 Sep 2026)

| Position | id | Match | Person | Calendar |
| --- | --- | --- | --- | --- |
| 10 | `stratco-fencing-marnin` | fencing, Stratco | Marnin | STRATCO FENCING `dEQKVKHthsjSYaen1fiE` |
| 20 | `normal-fencing-khairo` | fencing, normal | Khairo | Fencing Scope `i6j9vaCy6c94n3i93cir` |
| 30 | `patio-nithin` | patio | Nithin | Nithin's scope calendar `RSQnT8cQdEE8azb5Chlq` |

STRATCO FENCING stays the Stratco calendar, so Stratco booking is unchanged on
merge. A fencing lead with neither a Stratco nor a normal signal matches no
seed rule: it stays owner unclear on Marnin's list, exactly as before.

## Who reads the route

- `sales_booking_read`: whose list each lead is on, `booking_route` on every
  case, `routing` on the response (`checked_at_approval` for an assigned lead
  whose rule needs facts the list does not read).
- Owner approvals (`sales_booking_approval_write` with `owner_input`) and the
  engine path: a visit, or a text offering one, needs a route naming the
  approved person; the snapshot's `calendar_id` is the route's calendar. Each
  person's own visit rules apply (`SALES_BOOKING_VISIT_RULEBOOKS`).
- `sales_booking_book`: re-reads the route at the press and refuses
  `booking_route_changed` if the rule moved since approval.
- `sales_booking_send`: whose lead it is, through the same rule.

Every existing gate stays: owner-only approvals, the 15-minute approval life,
`SALES_BOOKING_SEND_EXECUTE`, `SALES_BOOKING_BOOK_EXECUTE` and the writer's
`GHL_CALENDAR_APPOINTMENT_WRITE_ENABLED`. With those off every press is a dry
run.

## The edit door (for the booking screen)

**Read** `GET ops-api?action=sales_booking_routes_read` (any caller the
front door admits). Returns `{ok, how_it_works, routes[], read_order[],
choices:{people[], match_trade[], match_lead_source[], pipelines},
changes[]}`. `routes` includes disabled rules and each rule's `updated_at`;
`changes` is the latest 50 audit rows, newest first.

**Change** `POST ops-api?action=sales_booking_routes_write`, one change per
call:

```json
{
  "op": "create" | "update" | "delete",
  "route_id": "normal-fencing-khairo",
  "route": { "position": 20, "enabled": true, "label": "...",
             "match_trade": "fencing", "match_lead_source": "normal",
             "match_tag": null, "match_pipeline_id": null,
             "person": "khairo", "calendar_id": "i6j9vaCy6c94n3i93cir",
             "calendar_name": "Fencing Scope" },
  "expected_updated_at": "<the rule's updated_at from the read>",
  "reason": "optional, up to 1000 characters",
  "dry_run": false
}
```

- Only the owner's signed session (`SALES_BOOKING_CAPTAIN_EMAILS`, the same
  gate as an owner approval) may change a rule; others get
  `stamp_write_requires_captain` (403). `dry_run: true` checks the change and
  returns `{before, after, read_order, stale}` without writing; a desk API
  key may run one.
- `route` is the whole rule (create, update); delete needs only `route_id`.
  Update and delete must send `expected_updated_at`; a rule changed since
  that read refuses `route_changed_since_read` (409) and nothing is written.
- Other refusals: `route_op_invalid`, `route_field_invalid` /
  `route_person_unknown` (400, `detail.field` names the field),
  `route_expected_updated_at_required`, `route_exists`, `route_not_found`,
  `booking_routes_unreadable`, `booking_route_write_failed`.
- Every change writes the rule and one append-only row in
  `sales_booking_route_changes` (who, when, before, after, why) in one
  transaction (`sales_booking_route_write`). The service role can only read
  the tables; the function is the only writer.

To reorder, update `position`; to switch a rule off, update `enabled`. A
calendar id is checked live at every approval (active, holds the person's
GHL user), not when it is saved.
