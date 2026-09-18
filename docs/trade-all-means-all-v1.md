# Trade app: "All" means ALL jobs — server contract v1

Captain's ruling, 2026-07-31: *"The company viewers and the trades need to see
all jobs. They can't just be like the most recent ones because sometimes there's
a rectification or whatever. So when they go to all, all needs to mean all. And
as long as there's no duplicate jobs, then that's fine. You should let them see
everything, because they need to be able to manage it or search it."*

Diagnosis this implements: `jan-trade-visibility-scout-v1` (2026-07-31). The
short version — the trade app's *widest* lens was also one of its narrowest.

## What changed server-side (`ops-api`)

| Seam | Before | After |
|---|---|---|
| `my_jobs?mode=all` dispatcher branch | assignments with `scheduled_date >= today−30d` | full range, paged at 1000, `id`-tiebroken; tenant-scoped |
| open make-safe pool | `limit(80)` newest, then `slice(0, 80)` again | paged up to the explicit 5,000-row safety ceiling, with a warning at the ceiling |
| make-safe legacy/detail reads | `select('*')` capped at `limit(120)` | slim 4-column table scan + `*` rows for pool ids only, chunked |
| cancelled make-safe feed | `limit(80)` | paged within its existing 90-day window |
| fencing / patio / decking pools (and, from 2026-09-17, the repair pool — see the addendum below) | `limit(80)` each | paged up to the explicit 5,000-row safety ceiling, with a warning at the ceiling |
| `search_all_jobs` empty query | viewer's own assignments + 200 newest active jobs | Everyone-lens users get the **whole tenant, full history**; crew unchanged |
| `search_all_jobs` any query | silent `limit(200)`, **no org filter** | paged with honest `total`, tenant-scoped |
| PO / make-safe-detail / contact enrichment | single unbounded `.in()` | chunked at 25 ids and paged |

The parity floor this establishes: **a dispatcher's visible set must always
contain every vertical manager's visible set.** It was inverted (Henry saw 102
fencing jobs, Jan and Marnin saw 58) purely because the `showAll` branch had a
date floor the manager branch did not. `myjobs_all_means_all_test.ts` guards it.

## What is deliberately unchanged

- **Mine lens and ordinary crew.** The personal feed keeps its 30-day window (its
  shape changed on 2026-08-17, see the addendum below) and its single unpaged
  read; an installer's `mode=all` output is still byte-identical to `mode=mine`.
  Crew keep the narrower active-jobs All-tab browse — they do not gain
  cancelled/archived history.
- **A vertical manager's non-fencing lanes** stay rolling-windowed (U2b).
- **The open pool stays allocatable-gated.** The ruling is about *visibility*, and
  visibility is delivered by the complete job feed. Putting the 60
  `company_contact_required` make-safes (ops's own admin queue) into the lane that
  means "any crew may take this" would re-create the fake-available cards the
  captain called out in M3b. The cap on that lane is gone; the meaning of the lane
  is not.
- **`deleted` / `duplicate` / `void` records stay out** of the All feed. This is
  the pre-existing `search_all_jobs` exclusion set, not a new window: cancelled,
  archived, lost, complete, invoiced and paid jobs are all visible. Keeping known
  duplicate records out is also what lets "all" satisfy the captain's condition
  that one job renders as one card.

## `search_all_jobs` response shape

Additive — `jobs` keeps its existing shape and every previously-returned field.
The company and assigned browse paths are de-duplicated by job id; assignment
visits remain separate in `my_jobs` because the Board needs each real visit row.

```jsonc
{
  "jobs": [ /* one entry per job, deduped by job id */ ],
  "lens": "company" | "assigned" | "search",
  "total": 2369,          // null only if the count read failed
  "page_size": 200,       // clamped to 500
  "offset": 0,
  "truncated": true,
  "next_offset": 200
}
```

`page_size` and `offset` are new optional query params. `org_id` is stripped from
every returned job. A non-integer or out-of-range `page_size`/`offset` is a 400,
not a silent coercion.

## Addendum (2026-08-06): ghost rows are excluded at source

Every `job_assignments` read that can reach the my_jobs feed — the dispatcher
full-range pages, the manager rolling/fencing queries, the personal own-rows
query, the make-safe backstop, and the pool occupancy probe — carries
`.eq('is_ghost', false)`, the `calendar_events` view's own predicate. A
hand-placed ghost `role:'observer'` row keeps a job's old `scheduled_date` after
a reschedule, so a raw read let a consumer deduping to one row per job pick the
stale date (the 2026-08-04 Trade App defect). Ghosts auto-mirrored since
2026-09-17 (`ghost_observer_mirror.ts`, see AGENTS.md) follow their crew row,
but the exclusion is unchanged: a ghost is never crew. No lens above changes
meaning: the excluded rows were never visible on any calendar surface.
Structural guard:
`myjobs_ghost_rows_test.ts`; evidence:
`docs/evidence/trade-feed-ghost-row-source-exclusion-2026-08-06.md`.

## Addendum (2026-08-17): personal-lane recency is window overlap, plus `recentCompleted`

The personal (`mode=mine`, ordinary installer) lane's 30-day window is an
OVERLAP predicate, not a start-date floor: `_myJobsPersonalRecencyFilter(floor)`
= `scheduled_end >= floor OR (scheduled_end IS NULL AND scheduled_date >= floor)
OR scheduled_date IS NULL`. A multi-day allocation that started earlier and is
still on site, and an undated allocation, are now in the crew's own feed — both
were already in the office and fencing-manager lenses, which is the divergence
the Captain reported. Stale one-day rows older than the floor still stay out.

`my_jobs` also publishes an additive `recentCompleted` bucket: past-dated
`complete` allocations that `shouldOmitTradeTodayRecent` deliberately keeps out
of `recent` (the report-action / "Needs Report" queue), minus dead jobs
(`_TRADE_RECENT_COMPLETED_EXCLUDED_STATUSES` — cancelled / lost / deleted /
duplicate / void, and archived). It is discovery only, never merged into
`recent`, and only the omit-filtered personal lane fills it — the office and
manager lenses do not omit those rows in the first place, so their bucket is
empty. Client half: render it as "My recent completed" (secureworks-ux PR #275).

Diagnosis, the tier model this shipped with, and the full gap table:
`docs/evidence/trade-access-model-2026-08-17.md`. Guards:
`myjobs_all_means_all_test.ts`, `manager_visibility_test.ts`.

## Addendum (2026-09-17): repair is a trade vertical

Captain: "there's fencing, there's patio, and now there's repair. It's the
same theory." Backend half; the `trade.html` side (secureworks-ux task
`trade-repair-vertical-ux`) renders against this contract. Motivating case:
repair-family make-safe SWMS-261319 was invisible to Hugo in the Trade app
because its only feed was the make-safe board, which builds with
`excludeInsuranceRepairs: true`. That board is deliberately unchanged; a
repair-family job is now served through every ordinary trade read instead.

### Definition and the one classifier

A job is **repair** when `jobs.type = 'repair'` OR its family metadata says so
(`metadata.ses_family = 'repair'` or `metadata.makesafe_job_family = 'repair'`),
mirroring `isInsuranceRepairFamily` (`insurance_repairs_board.ts`), the
Repairs and make-safe boards' own rule. `update_makesafe_job_family` never
retypes a card and the SWR- mint is a one-way supervised door (ruling
2026-08-28), so a family-tagged make-safe or fencing job keeps its `jobs.type`
forever by design and must never be read as its birth vertical.

`_jobVertical` (`ops-api/index.ts`) is the ONE classifier. It checks repair
FIRST via `_jobIsRepairFamily`, then make-safe, then the plain `jobs.type`. It
accepts a full `jobs` row (reads `.metadata`) or a light `calendar_events` row
carrying the projected `job_family` column. `_jobFamilyOf` returns the bare
family tag for display (`job_family`) and is never an authority input.
`_MANAGED_VERTICALS` is `makesafe / fencing / patio / decking / repair`.

Every vertical decision routes through `_jobVertical`:
`_resolveManagerVisibility`, `_resolveAllocationAuthz`,
`resolveTradeJobAccessTier`, `tradeViewerQuoteVisibleForJob`. So a repair
division manager gets the repair open pool, allocation rights, the lead
control and the quote exactly like any other vertical, and a make-safe or
fencing manager LOSES automatic access to a job the moment its family says
repair (on a make-safe job they fall to `makesafe_open`, otherwise to
`allocated` or `none`). Every `jobs` select that
feeds one of those calls selects `metadata` (`assertAssignmentMutationAuthz`,
`allocateJob`, `getTradeJobForAccess`, `reopenMakesafe`, `cancelMakesafe`,
`reattendMakesafe`, the `submit_work_order_invoice` work-order fetch and the
weekly `_resolveWeeklyWorkOrderInvoice` lane, so `_canSubmitWorkOrderInvoice`
answers identically for a repair-family job).

### Superset SQL filter, exact precedence once

Each per-vertical SQL filter (`tradeCalendarVerticalFilter`, the `myJobs`
manager-board and generic open-pool queries, `tradeWorkOrders`' filter) is a
deliberate SUPERSET: for repair it ORs `type.eq.repair` with both metadata
keys (`job_family.eq.repair` on the calendar view). Clauses stay flat, never
PostgREST `and()` / `or()` nesting, so the existing flat-parsing test fixtures
keep working. The exact "repair wins over every other vertical" rule is then
enforced exactly once per surface, after the fetch, by re-classifying each row
through `_jobVertical` and intersecting with the requested or managed set.

### Surface by surface

- **`trade_calendar`**: `TRADE_CALENDAR_COLUMNS` adds `job_family`.
  `tradeCalendarEvents` decides `truncated` / `next_offset` on the raw
  lookahead and narrows only the returned page.
- **Office `calendar` for a division-manager JWT**:
  `_scopeCalendarPayloadToVerticals` passes the row's `job_family` into
  `_jobVertical`, so the same precedence applies there.
- **`my_jobs`**: `metadata` is selected on every assignment, pool and backstop
  read. The generic open pool for `repair` uses `_REPAIR_POOL_READY_STATUSES`
  (the crew-ready set plus `accepted` / `processing`, PROVISIONAL until the
  repair lifecycle is ruled) and is screened through the same
  `isAllocatableMakesafePoolDetail` read the make-safe pool uses (a job with no
  detail row is still admitted). Every OTHER vertical's pool drops a
  family-tagged repair row (a fencing job tagged repair, the SWF-261343 shape,
  cannot enter the fencing pool) and keeps `_CREW_READY_STATUSES` exactly. The
  make-safe pool drops repair-family rows for non-dispatchers only: a
  dispatcher's allocation is never vertical-refused, so their pool keeps them.
  Every returned `jobs` object carries additive `job_family` (nullable) and
  `vertical`; `type` is untouched.
- **`my_work_orders`**: same superset-then-narrow pattern over the embedded
  `jobs` row; each row carries `job_family` and `vertical` beside `job_type`.
- **`trade_job_detail`**: additive `job_family`, `vertical`, and, only for a
  repair-family job, a `repair` block: `builder_work_order_number`,
  `builder_po_number`, `builder_claim_ref` (read from the job's own metadata
  exactly as stored, never re-derived or split) and `repair_stage`
  (`insuranceRepairStage`). Non-repair jobs carry `repair: null`. Documents,
  notes, assignments, POs and work orders already come through one unified
  read with no branch on job type, so there is no separate make-safe detail
  path to route around.

### Bound by two rulings

- The fencing completion-evidence gate (photos plus neighbour sign-off before
  invoice or completion) keys on raw `jobs.type` through
  `completionEvidenceVertical` (`trade_completion_evidence.ts`), never on
  `_jobVertical`, so a fencing job whose family says repair is not relaxed.
  Owner: `docs/trade-quote-lines-and-completion-evidence-2026-09-08.md`.
- The repair pool's ready-status set above is provisional pending the repair
  lifecycle ruling.

### Known gaps (deliberate, traced)

A few display-only `_jobVertical` call sites (the `TRADE_JOB_FEED_SELECT_ALLOCATED`
variant in `searchAllJobs`, some crew-charge helper call sites) do not select
`metadata`; there a family-tagged job degrades to its plain `jobs.type`
classification. None is an authorization or money decision.

Tests: `repair_trade_vertical_test.ts`. No migration, no writer touched, no
deploy step.

## Calendar

No server-side date floor exists to drop: `tradeCalendarEvents` bounds only by
the caller's own `from`/`to`, and a dispatcher who requests no `type` already gets
every vertical. A calendar can only show scheduled/assigned work — that limit is
inherent to `calendar_events` (`job_assignments JOIN jobs`) and is accepted.

## Client follow-up (`secureworks-ux`, separate PR)

The server now returns everything; `trade.html` still has to render it.

1. **All tab**: call `search_all_jobs` with an empty query on the All filter (it
   currently fires only at ≥2 characters), and page with `next_offset` on scroll.
   The existing "Showing X of Y" copy becomes honest as soon as `total` is read.
2. **De-dupe the Jobs list** by `jobs.id` in the Everyone lens. The server keeps
   every real visit row because the fencing Board needs per-week rows
   (`FencingBoardCore.forSelection`), so collapsing to one card per job is a
   presentation step, not a feed change.
3. **Fencing Board**: it is built client-side from the same `my_jobs?mode=all`
   payload, so it inherits the full range automatically — but confirm the week
   pager reaches back far enough to be useful now that years of history arrive.
4. **Calendar lanes**: register patio and decking sources alongside fencing
   (`trade.html:13170-13182`). The server already serves them; this is a
   client-only change.

## Deploy

Code-only — no migration. Rides the next `ops-api` deploy through the standard
captain-gated lane (`docs/project-knowledge/EDGE_DEPLOY_LANE.md`).
