# Make-safe board read model v1

Consumer contract for the Ops and Trade board builds.

## Endpoint

`GET /functions/v1/ops-api?action=makesafe_board&projection=ops|trade`

Contract version: `makesafe-board.v1`.

- `projection=ops` requires the ops API key or an admin, owner, or ops-manager JWT.
- `projection=trade` requires the signed-in trade JWT. Visibility is resolved server-side.
- Clients must not query Supabase tables directly and must not derive a column from `job_assignments.status`.
- Reads paginate with PostgREST `.range()` and chunk job IDs. The feed is not capped at 1,000 dependent rows.

## Canonical truth

Every card originates as one canonical job row with:

- `job_state`, `substatus`, `canonical_stage`
- `assignments[]`: who, scheduled date/time, travel, arrival, start and completion facts
- `report`: state, submitted date, current cycle and completion photo count
- `pack`: draft/send state and close-out document presence
- `notes[]`: the two-way human note thread, without internal system markers
- `lineage`: same-property claim key, intake lineage, one-card-per-PO identity and sibling links
- `age`: current age, target, hard maximum and overdue state
- `blockers.real[]` and `blockers.stale_artifacts[]` as separate facts
- `contact`: current client name, phone, full address and linked Call/Text/Navigate actions

A stale `company_contact_required` substatus on an already allocated/scheduled job is reported as `stale_company_contact_substatus`. It is not presented as a real client blocker.

## Ops projection

Ops retains the full stages:

`new`, `allocated`, `trade_report_in`, `report_ready`, `completed`, `archive`, `cancelled`.

Each row appears exactly once. An unknown stage is retained in `new`, carries `projection_warning`, and is listed in `unmapped_stage_job_ids`. It never disappears.

## Trade projection

The only column names are:

**New / Allocated / Complete / Archive**

| Canonical ops stage | Trade column |
|---|---|
| `new` | New |
| `allocated` | Allocated |
| `trade_report_in` | Complete |
| `report_ready` | Complete |
| `completed` | Archive |
| `archive` | Archive |
| `cancelled` | Archive |

`Complete` means the trade report is submitted while office processing may still be underway. Never label it “office”.

Visibility:

- Ordinary trades receive only jobs carrying their own assignment. Their assignment array is also reduced to their own rows.
- Hugo, or a profile managing the `makesafe` vertical, receives all make-safes including complete, archived and cancelled cards.
- Khairo remains fencing view-only. On this make-safe endpoint he receives only a make-safe specifically allocated to him, normally none. `permissions.fencing_view_only` is true and `can_allocate` is false.

The trade projection is an explicit allow-list. It contains no pricing, Xero invoice data, trade invoices, or another trade's invoice data.

## Contact actions

Render actions from `contact.actions`, not locally assembled stale values:

- An available action has `available: true` and a non-null `href` (`tel:`, `sms:`, or Google Maps URL).
- A missing source fact has `available: false`, `href: null`, and a stated `unavailable_reason`.
- A button with a fabricated, blank, or locally cached link is a release blocker.

## Parity gate

`parity.ok` must remain true. Fixtures cover every ops stage plus the historical failure modes:

- assignment marked complete but no report remains **Allocated**
- Docs Ready / `report_ready` appears in trade **Complete**
- an unknown stage remains visible with a warning

Consumers should treat a false parity result or duplicate job ID as a broken feed, not an empty board.
