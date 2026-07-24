# Make-safe board read model v1

Consumer contract for the Ops and Trade board builds.

## Endpoint

`GET /functions/v1/ops-api?action=makesafe_board&projection=ops|trade`

Contract version: `makesafe-board.v1`.

- `projection=ops` requires the ops API key or an admin, owner, or ops-manager JWT.
- `projection=trade` requires the signed-in trade JWT. If a browser request also carries the dashboard `x-api-key`, the verified user Bearer remains the caller identity. Visibility is resolved server-side.
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

## Derived status and captain-applied display truth

Each canonical row carries an evidence-derived status beside the raw declared
model. The engine stays pure and never changes an operational record.

- `computed_status`, `computed_status_job_type`, `computed_status_reasons[]`, `computed_status_missing[]`, `computed_status_at`
- `computed_status_hold`: an active, reason-coded hold surfaced as a badge on the derived column (never moves the card)
- `computed_status_evidence`: `report_received_at`, `has_submitted_service_report`, `has_current_portal_capture`

The derivation is a pure engine (`makesafe_computed_status.ts`) fed by typed
portal evidence (assessment-report/quote cards require the assessment 3-of-3
predicate). Durable sent-pack evidence plus an AUTHORISED/PAID ACCREC
invoice is authoritative close-out proof even when historical typed portal
captures are absent. Current archived/completed/cancelled display stages and
terminal job states cannot be revived.

The raw projection stage is returned as `declared_stage`. A captain-approved
transition changes `canonical_stage` only through the latest applicable row in
the append-only `makesafe_board_status_applications` ledger. It never rewrites
`jobs`, `makesafe_job_details.substatus`, assignments, invoices, events, or
communications. `status_application` carries its run key, before/after,
evidence reference, attribution, and timestamp.

Reconciliation actions:

- `?action=makesafe_status_disagreements` — declared≠computed cards
- `?action=makesafe_status_canary` — alarm-only consistency check (logs, returns `ok`)
- `?action=makesafe_status_shadow_refresh` — writes the `computed_status` shadow cache; privileged (`api_key`/service-role cron) only, never routine- or JWT-callable
- `?action=makesafe_status_apply` — dry-runs or atomically appends an exact,
  idempotency-keyed, captain-approved display transition set; live apply is
  API-key/service-role only and rejects terminal or stale cards

A missing status-hold or status-application table in a preview environment is
tolerated and logged, never fatal to the board. Production remains
migration-first.

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

Visibility is server-owned. It derives only from the caller's `role` and `managed_verticals`, never from their display name. The production roles `admin`, `ops_manager`, `crew`, `estimator`, `installer`, `lead_installer`, and `sales` are explicit; `owner` retains its approved platform scope. Any other role is refused with 403.

- Ordinary `crew`, `estimator`, `installer`, and `lead_installer` profiles receive only jobs carrying their own assignment. Their assignment array is also reduced to their own rows. The server scopes the read to their assigned job ids before building the canonical model, so an allocated-only caller never loads or receives full make-safe history.
- A profile managing the `makesafe` vertical (Hugo), or a platform admin/owner/ops manager, receives all make-safes including complete, archived and cancelled cards, and `can_allocate` is true.
- A make-safe view-only capability (managed vertical `makesafe_view` / `makesafe_readonly`, e.g. Jan) sees all make-safes but is action-gated: `can_allocate` is always false. This is the standing information-free / actions-gated posture for Jan; flip his profile to the full `makesafe` vertical if allocate rights are ever wanted.
- Khairo remains fencing view-only. His production `sales` role is mapped to this read-only scope when no make-safe manager capability supersedes it; an explicit managed vertical `fencing` produces the same scope. On this make-safe endpoint he receives only a make-safe specifically allocated to him, normally none. `permissions.fencing_view_only` is true and `can_allocate` is false.

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
