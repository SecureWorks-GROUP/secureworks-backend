# Make-safe board read model v1

Consumer contract for the Ops and Trade board builds, and for the `makesafe_audit`
read over the same make-safe jobs.

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
- U2-S1 additive spine (nullable-safe before/without migration apply):
  `attendance_cycle_id`, `cycle_number`, `cycle_attribution_flags[]`,
  `readiness_revision` (pure fingerprint; not yet an approval-invalidation gate),
  `commercial_warning` when prior-cycle commercial is visible but non-closing

A stale `company_contact_required` substatus on an already allocated/scheduled job is reported as `stale_company_contact_substatus`. It is not presented as a real client blocker.

### U2-S1 cycle-scoped evidence (board + audit)

One pure helper (`makesafe_cycle_evidence.ts`) owns the current-attendance
boundary for both the board enrich path and audit compact flags:

- When `reattend_count > 0`, only evidence bound to the current attendance
  (by `attendance_cycle_id` or matching `cycle_number`) may satisfy report,
  assignment, pack/sent, typed report-doc or photo readiness. Unscoped /
  `backfill_cycle_scope` rows fail closed with attribution flags.
- First attendance / reopen-only cards (`reattend_count = 0`) keep the legacy
  any-cycle first-match behaviour proven by prior regressions.
- Prior-cycle invoice/commercial may remain visible as a warning fact but must
  not close the current attendance or imply current-cycle send readiness.
- Holds for the current cycle are exposed on **ops** (`computed_status_hold`)
  and **trade** (`hold: { reason_code, note, held_since, cycle_number }`).
- Migration `20260727000001_makesafe_attendance_cycles_u2_s1.sql` materialises
  immutable `makesafe_attendance_cycles` rows and nullable attribution columns.
  Apply the migration **before** deploying the matching `ops-api`. Code rollback
  is the previous edge version; additive schema is harmless if left in place.
- This slice does **not** complete full U2 (single display authority,
  cryptographic approval invalidation, docket revisions, obligation ids).

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

## Sealed SES Reporting visibility boundary

For the five-minute clean-automated intake metric, **Board-visible** has one
server boundary:

- Start: the clean source email's received timestamp.
- Stop: the same `jobs.id` is contained in an authorised
  `makesafe_board?projection=trade` response for a profile whose
  `managed_verticals` contains `makesafe`, in `New` or `Allocated`.
- A `company_contact_required` card in `New` satisfies Board visibility. It is
  separately `field_ready: false` because client contact remains a blocker, and
  separately `open_pool_eligible: false` under the existing pool predicate.
- A job or reconciliation row by itself does not satisfy this boundary.

The deterministic no-write fixture proof is
`supabase/functions/ops-api/makesafe_intake_integration_test.ts`. Its one clean
instruction identity passes the production clean-intake gate, retains the same
`job_id` through canonical stage derivation and the authorised Trade route seam,
including profile lookup, the production canonical loader against deterministic
stub rows, authorization, parity, and the response envelope. The positive path
goes through the outer `makesafe_board` action envelope
(`_makesafeBoardActionForTest`) so non-JWT modes fail before the route. There
is no injectable `loadBoard` override on the production trade route — containment
requires an observable `jobs` table read. Ordinary allocated-only discovery uses
join-capable assignment fixtures (nested `jobs.type=makesafe`) and cannot pass
via an empty restrict list alone. JWT claim fields cannot escalate beyond the
authoritative `users` profile. Its deterministic timestamps are fixture timing
evidence only; the real email-received to live authorised Board containment
measurement remains mandatory in the merged end-to-end harness and sealed
mission proving run. That harness must enforce a maximum direct-response
elapsed time of 300,000 ms.

The fixture calls the authorised server route seam directly, so it explicitly
bypasses the Trade client's 90,000 ms in-memory Board cache. It proves the
Board L2 response shape and containment seam, not browser first paint.
Production stores no first-paint telemetry, and the test does not manufacture
one. The e2e fixture driver
(`tests/e2e/ses-reporting-proof/drivers.ts`) confirms Board identity through
`scripts/ses-board-fixture-seam.ts` (same production action/route); it must not
green-light visibility from in-memory cards alone. That seam is still not live
five-minute SLA evidence.

Run:

```bash
deno test --no-check --allow-all supabase/functions/ops-api/makesafe_intake_integration_test.ts
```

## Contact actions

Render actions from `contact.actions`, not locally assembled stale values:

- An available action has `available: true` and a non-null `href` (`tel:`, `sms:`, or Google Maps URL).
- A missing source fact has `available: false`, `href: null`, and a stated `unavailable_reason`.
- A button with a fabricated, blank, or locally cached link is a release blocker.

## Audit read

`GET /functions/v1/ops-api?action=makesafe_audit` is the compact audit read
(`jobs[]` + `known_refs[]`) behind the make-safe skills and hybrid loop.

- `jobs[]` walks range pages for make-safe jobs matching the request instead of
  applying the former fixed 500-row cap.
- Job-scoped dependent reads are split by the shared encoded-URL budget and merge
  all row pages. Global ACCREC and intake-draft reads paginate separately.
- A reported error from a required query rejects the request instead of becoming
  an empty map. A successful empty query still surfaces as absent facts; this is
  not a per-job completeness or full U2 board-truth guarantee. Required joins
  (jobs, details, documents, service reports, job_events pack markers, ACCREC
  invoices, pipeline_items sent status, intake drafts, card story) hard-fail;
  only `recheck_queue_depth` is optional (null when its auxiliary COUNT fails).
- Current-cycle report truth: when `reattend_count > 0`, `has_report_record` and
  the report leg of `pack_effectively_sent` use the shared
  `makesafe_cycle_evidence.ts` boundary as the board, so a prior visit's service
  report cannot falsify the current reattendance cycle. Cards with no reattend
  boundary keep the legacy any-cycle first-match behaviour.
- Multi-row `pipeline_items.sent_status` for one job is reduced by explicit rank
  (`verified_sent` > `needs_review` > `not_sent`); input order cannot demote a
  stronger verdict, and a row with empty status never invents "sent".
- `recheck_queue_depth` is a number when its auxiliary count succeeds and `null`
  when the count errors or is unavailable.
- Paginated reads end on a unique sort key (see the PostgREST entry in
  `docs/project-knowledge/gotchas.md`).
- Regression owner: the `2.1` cases in
  `supabase/functions/ops-api/makesafe_audit_test.ts` cover 392/500 URL-budget
  volume, a 1001-job second page, multi-page job/document merges,
  required-query error rejection (full required-join matrix), cycle-aware
  report / pack_effectively_sent, and multi-row pipeline sent precedence.

## Known gaps (deferred, not fixed in this change)

Each entry below is a real, understood defect this change deliberately leaves
alone. Every one of them sits on a path with no regression coverage, so fixing
them here would widen blast radius ahead of the live run.

### MAJOR-2 — global ACCREC full-history read in `makesafe_audit`

- Concurrency: the audit's `xero_invoices` ACCREC read has no job filter and no
  date window, so it walks the whole invoice history across multiple `.range()`
  pages. `.range()` is LIMIT/OFFSET against a live table, so an xero-sync insert
  landing between page N and page N+1 shifts every later offset and an invoice
  is skipped or returned twice. `makesafe_story_recompute` repeats the full scan
  inside the same invocation, so the two scans can disagree with each other.
- Scaling: resolution is O(jobs × ACCREC history) and both former bounds (the
  500-job cap and the implicit 1000-row cap) are gone. At roughly 400 make-safe
  jobs against roughly 3000 invoices this stays inside the CPU budget and
  degrades gradually as history grows. The `job_id` tier could be served from a
  `Map<job_id, rows[]>` without changing output order; the `reference_substring`
  tier would need an explicit date window, which is a product decision about
  what the audit is allowed to miss.

### Tie-break direction — audit `id DESC` vs board `id ASC`

The audit's ACCREC read ends on `invoice_date desc, id desc`; the board's
`_fetchAllByJobIdChunked` appends `id asc`. Two same-day, same-rank live ACCREC
invoices on one job therefore resolve differently: the audit picks the newer id,
the board the older. Both orders are total and stable, and today's first-wins
consumers tolerate either, so the direction is left unreconciled.

## Parity gate

`parity.ok` must remain true. Fixtures cover every ops stage plus the historical failure modes:

- assignment marked complete but no report remains **Allocated**
- Docs Ready / `report_ready` appears in trade **Complete**
- an unknown stage remains visible with a warning

Consumers should treat a false parity result or duplicate job ID as a broken feed, not an empty board.
