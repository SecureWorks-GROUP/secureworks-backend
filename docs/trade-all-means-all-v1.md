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
  As of the 2026-09-24 addendum below, crew's All-tab search is now restricted
  to their own allocations only (never even the "active-jobs" browse this
  section originally described — that was itself a company-wide leak; see the
  addendum for the corrected shape).
- **A vertical manager's non-fencing lanes** stayed rolling-windowed under U2b;
  as of the 2026-09-24 addendum below every managed vertical is now full-range,
  same as fencing.
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
repair (they fall to `allocated` or `none`; the former `makesafe_open`
fallback is retired, see the 2026-09-24 addendum). Every `jobs` select that
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

## Addendum (2026-09-24): visibility is decided by an explicit tier, not by role — supersedes the 2026-07-31 search behaviour

Captain ruling, 2026-09-24 ("go A"): office role (Ops Dashboard staff set)
and Trade App job visibility are now two SEPARATE questions. Everyone keeps
their existing office role for the Ops Dashboard and every other
SecureWorks tool; only what the Trade App shows is decided by an explicit
per-person tier — never by `OPS_API_STAFF_OPERATOR_ROLES` membership. This
closed a real gap the 2026-07-31 "all means all" ruling had created: four of
the named people (Nithin, Khairo, Hugo, and the un-named Esther) held the
`ops_manager` staff role and so saw the WHOLE company on every Trade App
surface, when only Esther was meant to.

> "Shaun, Marnin, Jan and Esther see every job in every category, with full
> history, including every new allocation." / "Henry and Khairo ought to have
> the same access, all fencing jobs and full history of fencing jobs." /
> "Nithin sees all patio jobs, with decking staying in his view, full
> history." / "Hugo sees all make-safe jobs, full history... yes every app."
> "only hugo/ whoever that's allocated a make safe from now on." / "All tab is
> limited. if it's not anyone i mentioned, they will not see any other jobs
> but their own." / "for everyone else... let them have access to history of
> the jobs they were allocated to." / "if I were to schedule a job
> specifically for [a see-everything person], all of those people will be
> able to see the new allocations as well. And the newly allocated jobs, only
> the people that's intended to see them will see them."

### The rule table

| Tier | Grant | Gets |
|---|---|---|
| **See-everything** | `users.trade_sees_all_jobs = true` (new column, migration `20260924230000`). Target membership: Shaun, Marnin, Jan, Esther (see "Rollout" below for how it gets there). | Every job, every category, full history, on every surface — including new allocations as they happen. |
| **Category manager** | `users.managed_verticals` contains the job's vertical (`_jobVertical`), REGARDLESS OF ROLE. | Full history of every job in the managed categories, on every surface, plus their own allocations outside those categories (never narrower than their personal lane). |
| **Everyone else** | default. | Only jobs they hold (or held) a non-cancelled, non-ghost `job_assignments` row for — past and present, on every surface **including search**. Never a company-wide or "active-jobs" browse. |

Make-safe specifically: the `makesafe_open` field-report door (any
signed-in trade could open/report an unassigned make-safe) is **retired**.
Only see-everything or a make-safe category manager may open or allocate an
unassigned make-safe job now. A Trade App `submit_makesafe_report` (draft or
final) passes the same per-job tier gate (`resolveTradeJobAccessTier`, with the
caller's see-everything flag as `isOffice`) before any write; the Ops Dashboard /
routine / api-key path keeps its existing staff-role behaviour unchanged.

A ghost watcher row (`job_assignments.is_ghost = true`, the ops-manager mirror
written by `ghost_observer_mirror.ts`) is never an allocation: the per-job tier
check and `search_all_jobs`' allocated set both exclude it.

### What changed in code

- **New column**: `users.trade_sees_all_jobs boolean not null default false`
  (migration `20260924230000_users_trade_sees_all_jobs.sql`), read by
  `authTrade()` into `TradeAuthContext.seeEverything`.
- **`_resolveManagerVisibility`** (`index.ts`) — the one resolver `my_jobs`
  (all modes), `trade_calendar`, `my_work_orders`, and `search_all_jobs`'s
  lens/company-scope decision all share — now derives `isDispatcher` (kept as
  the field name every call site already destructures; its meaning is now
  "see-everything", not "staff role") from `input.seeEverything`, never from
  `_opsApiStaffOperatorRole(role)`. `OPS_API_STAFF_OPERATOR_ROLES` itself, and
  every OTHER gate that reads it (Ops Dashboard actions, `_resolveAllocationAuthz`,
  pricing, admin surfaces), is completely unchanged.
- **`resolveTradeJobAccessTier`** — `isOffice` is fed by the same
  see-everything-derived flag at every call site. The `makesafe_open` branch
  is removed: an unallocated caller with no see-everything/make-safe-manager
  standing now falls through to `tier: 'none'` on a make-safe job exactly like
  on any other vertical. The `'makesafe_open'` literal stays in the
  `TradeJobAccessTier` type (and in every downstream money/quote guard that
  compares against it) so those guards keep compiling; it can simply never be
  produced again.
- **`my_jobs`'s category-wide (`mode=all` for a category manager) branch** —
  every managed vertical is now full-range and paged, exactly like fencing
  always was (the old 30-day rolling window for non-fencing verticals, and
  the 180-day make-safe backstop that patched a hole in it, are both retired
  — a full-range primary query has no hole to patch). The **personal
  (`mode=mine`) lane keeps its own, separately-ruled 30-day-ish recency
  window** (Captain 2026-08-17, `_myJobsPersonalRecencyFilter`) — this ruling
  named only "category-wide views" for the full-history change, so the
  personal lane is deliberately out of scope here. If the Captain intends
  the personal lane to also go full-range (closing the very literal reading
  of "past and present... on every surface"), that is a named follow-up, not
  silently folded into this change.
- **`search_all_jobs`** — **supersedes the 2026-07-31 ruling's search
  behaviour entirely.** That ruling's `company` lens had no vertical bound at
  all ("typed search has always reached every vertical for every trade
  user"), and its `assigned` lens for ordinary crew was unrestricted at the
  DB level too — the client's 2-character search-box minimum was the *only*
  thing standing between an ordinary installer and a company-wide result,
  on every path including the empty-query browse. Both gaps are closed:
  - A **see-everything** caller still gets the whole tenant, full history —
    unchanged from 2026-07-31.
  - A **category manager** is now restricted, server-side, to jobs in their
    managed vertical(s) (`_jobsTableVerticalFilter`, the `jobs`-table
    equivalent of `tradeCalendarVerticalFilter`) UNIONED with their own
    personal assignments (so a one-off out-of-vertical allocation is never
    hidden — matches `my_jobs`' personal lane).
  - **Everyone else** is restricted, server-side, to their own assigned job
    ids (the assignment read is paged to completion; the id filter is sent in
    25-id chunks and merged, newest first, so a long history never overflows a
    PostgREST URL) — every path (empty-query browse, typed search, and
    the external-ref match) is filtered through the same
    `jobWithinVisibility` gate, so a 1-character query can never leak a
    company-wide result. This governs `.notIn` status exclusion too: the
    narrower `_ASSIGNED_BROWSE_STATUS_EXCLUDE` set (which additionally hid an
    allocated trade's own cancelled/lost/paid/closed jobs) is retired in
    favour of the SAME broad `_GLOBAL_SEARCH_STATUS_EXCLUDE` (hard
    deletes/duplicates/voids only) every tier now shares — "past and present"
    means every job status too, not just every date, for a job the caller is
    actually allocated to.
  - This resolves ambiguity #5 in `docs/evidence/trade-access-model-2026-08-17.md`
    (the standing conflict between the 2026-07-31 and 2026-08-17 rulings) in
    favour of the 2026-08-17 three-tier model, generalised by this ruling's
    explicit tier.
- **The make-safe board's own resolver** (`resolveMakesafeTradeViewer`,
  `makesafe_board_read_model.ts`) — `seeEverything` OR `managed_verticals`
  contains `makesafe` now decides `sees_all_makesafes` / `can_allocate`.
  **Retired**, because nothing live depended on them: the role-based
  `privileged` check (admin/owner/ops_manager), the `makesafe_view` /
  `makesafe_readonly` managed-vertical special case (no production row ever
  carried either value), and the `fencing_view_only` special case for
  `managed_verticals` containing `fencing` or `role === 'sales'` (no
  production user held `role: 'sales'`, and `trade.html` never read
  `fencing_view_only`). A fencing-only manager now gets plain
  `allocated_only` on the make-safe board, matching "let them have access to
  history of the jobs they were allocated to" for a category they don't
  manage. `fencing_view_only` stays `false` in the payload shape only, so an
  existing reader of that key never sees it disappear.

### Tests

`manager_visibility_test.ts`, `myjobs_all_means_all_test.ts`,
`myjobs_manager_scope_test.ts`, `trade_access_tier_test.ts`,
`trade_manager_job_access_test.ts`, `makesafe_board_auth_test.ts`,
`makesafe_board_read_model_test.ts`, `repair_trade_vertical_test.ts`,
`makesafe_access_shape_test.ts`, `makesafe_submit_report_test.ts` were all
updated to the new model (every test asserting the OLD role-derived or
company-wide behaviour was rewritten to assert the new one, never deleted
outright — the retirement is proven, not just assumed).
`trade_app_visibility_rules_test.ts` is the new, single contract test that
pins the rule table itself across every named persona (see-everything, a
fencing manager holding either an `ops_manager` or a `lead_installer` role,
a patio+decking manager, a make-safe manager, and ordinary crew with a past
AND a present allocation) against the shared decision primitives every
surface routes through, plus end-to-end proof for `search_all_jobs` and
`my_jobs`.

### Rollout (two phases)

**Phase 1 — the merge is invisible.** Migration
`20260924230000_users_trade_sees_all_jobs.sql` adds the column AND, in the same
apply, sets `trade_sees_all_jobs = true` for every existing user whose role is
`admin`, `owner` or `ops_manager` (matched by role only, no names or ids). That is
exactly the set that saw everything under the old role-derived code, so the
moment the matching `ops-api` deploys nobody loses or gains Trade App visibility.
The backfill runs only on the apply that creates the column, so it can never
re-widen a Phase 2 narrowing. Contract:
`supabase/tests/migration-contracts/20260924230000_users_trade_sees_all_jobs/`.

**Phase 2 — the Captain's rules, a separate Marnin-approved data change, run any
time after merge.** This is the moment visibility actually changes.

Step 1, read-only: resolve each person's stable id once, by name, and confirm
exactly one row per name with Marnin. Stop on any ambiguous or missing name.

```sql
select id, name, email, role, managed_verticals, trade_sees_all_jobs
from public.users
where name ilike any (array[
  '%shaun%', '%marnin%', '%jan%', '%esther%',
  '%khairo%', '%hugo%', '%nithin%', '%ryan%'
])
order by name;
```

Step 2, the writes, by id only:

```sql
-- See-everything: Shaun, Marnin, Jan, Esther. Already true from the Phase 1
-- backfill (all four hold an admin/ops_manager role); this is a confirmation.
update public.users set trade_sees_all_jobs = true
where id in ('<shaun-id>', '<marnin-id>', '<jan-id>', '<esther-id>');

-- Nithin, Khairo, Hugo: ops_manager role, so Phase 1 left them seeing
-- everything. THIS edit is what narrows each of them to their category.
update public.users set trade_sees_all_jobs = false
where id in ('<nithin-id>', '<khairo-id>', '<hugo-id>');

update public.users set managed_verticals = array['fencing']::text[]
where id = '<khairo-id>';
update public.users set managed_verticals = array['makesafe']::text[]
where id = '<hugo-id>';
update public.users set managed_verticals = array['patio', 'decking']::text[]
where id = '<nithin-id>';

-- Ryan: crew, managed_verticals [makesafe] -> []. NOT a no-op, and independent
-- of the backfill: the moment this row is edited Ryan loses make-safe-wide
-- visibility and allocation and becomes allocated-only ("Ryan is like
-- everyone else").
update public.users set managed_verticals = array[]::text[]
where id = '<ryan-id>';
```

Step 3, verify with the Step 1 select.

## Deploy

The schema migration (`20260924230000_users_trade_sees_all_jobs.sql`) applies
before the matching `ops-api` through the standard lane
(`docs/project-knowledge/EDGE_DEPLOY_LANE.md`); its backfill makes that deploy
change nobody's visibility. The Phase 2 data change above is a separate,
explicitly approved step.

