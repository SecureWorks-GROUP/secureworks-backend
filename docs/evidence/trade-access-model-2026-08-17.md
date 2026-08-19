# Trade app three-tier access model — gap map, fixes, and the live report (2026-08-17)

Captain ruling (2026-08-17):

> "Henry should be classed as the fencing division manager. He sees everything, he can do whatever he wants and he can allocate jobs. If a trade is allocated, they're either the lead or the crew. The lead and the crew should be able to see everything except the quote, and only Henry and the admin guys see the quote."

Rendered as three tiers:

| Tier | Who | Gets |
|---|---|---|
| 1 Office | `users.role` in `admin / owner / ops_manager` (`OPS_API_STAFF_OPERATOR_ROLES`), or a privileged server key | everything, everywhere |
| 2 Division manager | `users.managed_verticals` contains the job's vertical (`_jobVertical(job)`; whitelist `makesafe / fencing / patio / decking`) | everything on that trade's jobs, quote included; allocates crew, sets the lead |
| 3 Allocated trade | a non-cancelled `job_assignments` row for the caller on the job — `is_lead` TRUE **or** FALSE, no difference | everything about the job **except the quote** |

Nobody else sees anything on a job (the pre-existing MakeSafe field-report exception is kept and named — see ambiguities).

## The one predicate

`resolveTradeJobAccessTier(client, jobId, userId, { isOffice, access })` in `supabase/functions/ops-api/index.ts` returns `{ tier, quoteVisible, reason, job }` with `tier ∈ office | division_manager | allocated | makesafe_open | none`. `tradeQuoteVisibleForTier(tier)` is the ONE quote rule (`office` and `division_manager` only). `assertAssignedOrMakesafeAccess` — the gate every per-job trade door already called (`trade_job_detail`, `add_note`, `upload_photo`, `get_upload_url`, `confirm_upload`, `get_service_report`, `submit_service_report`, now `trade_labour_budget`) — is a throw-on-refuse wrapper over it, so the decision exists once and cannot drift per route. Order inside the predicate: tenant → office → division manager → allocated → makesafe_open → none. Division manager outranks allocation on purpose: Henry on his own crew still sees the quote. `job_assignments.role` is never read; `is_lead` is never a tier input.

Tests: `supabase/functions/ops-api/trade_access_tier_test.ts` (granted AND refused for every tier; lead vs crew payload byte-identical; quote refused on every touched surface; cross-vertical manager refused; stranger refused; other tenant refused first). Plus updated pins in `ops_api_operator_auth_test.ts`, `myjobs_all_means_all_test.ts`, `myjobs_manager_scope_test.ts`.

## Captain live report: allocated fencing crew cannot see their jobs

Report: crew Henry allocated to fencing jobs (lead and crew) cannot see those jobs in the Trade app.

Trace, plain installer (no managed vertical, `job_assignments` row on the job) vs an office session, on `main` at `d93cd632`:

| Step | Office (`admin`/`ops_manager`, `my_jobs mode=all`) | Allocated installer (`my_jobs`, personal lane) | Divergence |
|---|---|---|---|
| Front door `_authorizeOpsApiAction` | `my_jobs` is profile-scoped | same | none |
| `authTrade` | needs `users.org_id` | same | none (a crew row with no `org_id` fails BOTH with 403 "Trade profile not found", not silently) |
| `myJobs` lens | `showAll` (isDispatcher) → `job_assignments` INNER JOIN jobs, `neq status cancelled`, `is_ghost=false`, **full range** (Captain 2026-07-31 "all means all") | `eq user_id`, `neq status cancelled`, `is_ghost=false`, **`gte scheduled_date today-30d`** | **EARLIEST DIVERGENCE** — the personal lane had a start-date floor the office lane and Henry's fencing lane (also full-range) do not have |
| Grouping | today / thisWeek / upcoming / recent (no omit filter) | same, plus `shouldOmitTradeTodayRecent` on past rows (drops `complete` assignments and dead jobs from "Needs Report") | intended |
| Client (`trade.html` on secureworks-ux `main`) | renders sections | renders sections; `unscheduled` bucket is not rendered | UI, see front-end list |

Effect of the floor: `scheduled_date >= X` (a) drops every row whose span STARTED more than 30 days ago even when it is still on site (`scheduled_end` in the future) — long fencing jobs are exactly this shape — and (b) drops NULL `scheduled_date` rows entirely (PostgREST `gte` excludes NULL). Both are visible to the office and to Henry (whose fencing lane is full-range since #Captain 2026-07-31), invisible to the crew allocated to them.

Fix (this PR): the personal lane uses the same window-OVERLAP predicate `trade_calendar` / `calendarEvents` already use — `_myJobsPersonalRecencyFilter(floor)` = `scheduled_end >= floor OR (scheduled_end IS NULL AND scheduled_date >= floor) OR scheduled_date IS NULL`. Stale one-day rows older than 30 days stay out (control pinned), so "Needs Report" does not fill with history. Regression: `myjobs_all_means_all_test.ts` "allocated crew (lead AND crew) see a still-on-site allocation that started 45 days ago…".

Counterfactual that flips it: give the same row a `scheduled_end` inside the window (or set the caller's `managed_verticals` to `['fencing']`) and it appears; remove the floor and it appears.

**What this does NOT prove.** Production was not observed from this worktree: the `SUPABASE_ACCESS_TOKEN` in the environment returns 401 from the Management API, so the live rows behind the report were not read. If the live symptom is NOT the floor, the remaining candidates are data shape, not code, and each is one read-only query away:

1. Rows Henry created that carry a `crew_name` but `user_id IS NULL` (name-only rows are invisible to every installer by design — `createAssignment` refuses to create new ones, but older/ops-side rows may exist): `select id, job_id, crew_name, scheduled_date from job_assignments where user_id is null and status <> 'cancelled' and job_id in (<the fencing jobs>)`.
2. `is_ghost = true` on the crew rows (watcher rows are excluded by design): `select id, user_id, is_ghost, status, scheduled_date, scheduled_end from job_assignments where job_id in (...)`.
3. Crew `users` rows with no `org_id` (fails `authTrade` for EVERYTHING, not just fencing): `select id, role, org_id, managed_verticals from users where id in (<crew ids>)`.
4. Assignment `status = 'cancelled'` or the job `status` in the terminal set.

If (1)–(4) are clean and the rows have a start date > 30 days back or NULL, the floor is the cause and this PR is the fix.

## Gap table — every Trade-reachable ops-api action and job-detail surface

Legend: T1 office, T2 division manager (of the job's vertical), T3 allocated trade (lead OR crew), X = a trade with no vertical and no allocation. "Before" = `main` at `d93cd632` + branch `fm/trade-fencing-visibility` (b31aa177, cherry-picked here as the base). Verdict is against the ruled model.

### Per-job doors

| Surface | Ruled | Before | Verdict | After |
|---|---|---|---|---|
| `trade_job_detail` — job core fields, crew, WOs, POs (pricing already stripped), media, notes, service reports | T1/T2 all; T3 all minus quote; X refused | Access: `assertAssignedOrMakesafeAccess` w/ context (T1/T2/T3 pass, X refused). **`job.scope_json` shipped RAW** — carries `_pricing_json` (totals, margin), `pricing.*Rows[].sell`, `pricing.labour.sell`, `notes.pricingNotes/noteQuote`, nested per patio/option/`job` | **too open** (quote to T3 by every route) | `redactTradeScopeQuote` for non-quote tiers; keeps `pricing.labour.{trades,days,dayRate}` (the installer's own labour budget the app already shows), everything else quote-shaped stripped at every depth. Payload now carries `access_tier` + `quote_visible` |
| `trade_job_detail.documents` | T1/T2 every document; T3 never a quote | `visible_to_trades=true` rows for EVERY tier — a QUOTE ops flagged visible reached T3; T2/T1 lost flagged-off docs | **too open** (T3) and **too closed** (T1/T2) | T1/T2: full document set. T3/makesafe_open: `_tradeDocumentsForAllocatedTrade` = flagged rows minus `TRADE_QUOTE_DOCUMENT_TYPES` (`quote`, `invoice`), `quote_number` dropped |
| `trade_job_detail.scopeSummary` | no price | `_tradeScopeSummary` strips `pricing_json`, summary is metres/config only | correct | unchanged |
| `trade_job_detail.metadata` | — | stripped (only `job_identity` projection) | correct | unchanged |
| `trade_job_detail.workOrders[].scope_items` | — | carries the WO line `price` (what the trade is paid — charge-in, not the client quote) | correct (not the quote) — noted | unchanged |
| `trade_job_detail.purchaseOrders` | no price | line items reduced to description/quantity | correct | unchanged |
| `trade_job_detail.notes` / `serviceReports` / `media` | all tiers | free text / evidence, system markers stripped | correct (free text could embed a figure — not filterable, noted) | unchanged |
| `trade_job_detail` lead vs crew | identical | identical (`is_lead` display only) | correct | pinned by test (payloads `assertEquals`) |
| `add_note`, `upload_photo`, `get_upload_url`, `get_service_report` | T1/T2/T3 pass, X refused | fixed by `fm/trade-fencing-visibility` (context threaded) | correct (on that branch) | built on; now resolve through the tier predicate |
| `confirm_upload` | T1/T2/T3 pass | no access context → T2 refused "not assigned"; office bypass was `role==='admin'` only (ops_manager fell to the assignment path) | **too closed** (T2, ops_manager) | context threaded; office bypass = `isDispatcher` (staff role set) |
| `submit_service_report` | T1/T2/T3 | context already threaded | correct | unchanged |
| `trade_labour_budget` | T1/T2 pass; T3 pass but no quote figure; `makesafe_open` and X refused | strict `assertAssigned` (T2 refused, office refused); **`pricing_json.labourTotal` (quoted labour) funded the budget for T3** | **too closed** (T2) and **too open** (quote component to T3) | tier predicate; quoted fallback only when `quoteVisible`; T3 budget is PO-derived only. The response names every assigned crew member and their `trade_rates.hourly_rate`, so `tradeLabourCostVisibleForTier` refuses the `makesafe_open` tier **at this door** — that tier is a REPORT door (any signed-in trade, any make-safe) and must not become a payroll one; the shared predicate keeps granting it for the report/photo doors that need it |
| `crew_charges_on_my_jobs`, `review_crew_charge`, `list_pending_verifications` | lead = `is_lead` | **`job_assignments.role in ('lead','lead_installer')` read as the lead** — role defaults to `lead_installer` on every insert (112/133 live rows 2026-08-03) so nearly every crew member could review every other trade's invoice lines on their jobs | **defect: role read as authority** | `tradeLeadJobIds` / `tradeIsDesignatedLead` read `is_lead = true`. NOTE: leads must be designated via `set_job_lead` for these three surfaces to light up — that is the ruled model (lead = `is_lead`) |
| `verify_hours`, `dispute_hours` | lead only | no lead/ownership check at all (any caller can verify any submitted assignment id) | too open — **out of tier scope, reported** | unchanged (separate ticket) |
| `roof_report_template`, `save_roof_report`, `submit_roof_report` | T3 on the job (make-safe) | `assertMakesafeJob` only (any signed-in trade, no assignment/tenant) | pre-existing MakeSafe open-pool exception — **ambiguity, reported** | unchanged |
| `create_trade_alert`, `request_assistance` | T3 on the job | no assignment predicate (write-only, no read-back) | too open — **out of tier scope, reported** | unchanged |
| `submit_makesafe_report` | T3 / makesafe_open | envelope auth + `assertMakesafeJob` w/ context; binds `role:'crew', is_lead:false` (writes role, does not read it) | correct within the make-safe exception | unchanged |
| `reattend_makesafe`, `cancel_makesafe`, `reopen_makesafe`, `allocate_job`, `set_job_lead` | T1/T2 (+ own assignment for reattend) | `_resolveAllocationAuthz` (office by name, manager by vertical); #718 put `set_job_lead` on the profile-scoped list | correct | unchanged. `reattend_makesafe` reads `role` only through `isGenuineTradeAssignment` to EXCLUDE observer/`makesafe_open` marker rows — a marker, not lead authority |
| `confirm_roof_report_done` | assignment on the exact job | assignment on the exact job; admin explicitly not sufficient | correct (portal attestation is the trade's own act) | unchanged |
| `submit_work_order_invoice` | own WO, or T1/T2 | `_canSubmitWorkOrderInvoice`: org match, then assignee / dispatcher / managed vertical | correct | unchanged |

### List / feed surfaces

| Surface | Ruled | Before | Verdict | After |
|---|---|---|---|---|
| `my_jobs` T1 | everything | full-range tenant-wide | correct | unchanged (owner now also dispatcher — see below) |
| `my_jobs` T2 (`mode=all`) | whole managed vertical(s) | vertical-wide, fencing full-range, other verticals rolling 30d | correct | unchanged |
| `my_jobs` T3 (personal lane) | every job they are allocated to | own rows, **`scheduled_date >= today-30d`** — on-site spans that started earlier and undated allocations invisible | **too closed** (Captain live report) | window-overlap recency `_myJobsPersonalRecencyFilter` |
| `my_jobs` T3 grouping — finished work | crew can find a job they completed without it re-entering the report queue | past-dated `complete` allocations were dropped by `shouldOmitTradeTodayRecent` and appeared in no bucket | discovery gap (not a tier defect) | additive `recentCompleted` bucket: exactly the rows that omit branch drops, minus dead jobs (`_TRADE_RECENT_COMPLETED_EXCLUDED_STATUSES` + `jobs.archived`). Never merged into `recent`; only the omit-filtered personal lane fills it. Contract: `docs/trade-all-means-all-v1.md` (2026-08-17 addendum) |
| `my_jobs` `scope_summary` | no price | derived from `pricing_json.job_description`, then `pricing_json` deleted | correct | unchanged |
| `my_work_orders` `mine` | own WOs | `assigned_user_id = viewer` (WO price is the trade's own charge-in) | correct | unchanged |
| `trade_calendar` | T1 all, T2 vertical(s), T3 own | lens-scoped, overlap window | correct | unchanged |
| `search_all_jobs` (All tab) | (see ambiguity) | Everyone-lens users get every company job (Captain 2026-07-31); ANY trade with a typed query searches every tenant job (client name, address, phone) | conflicts with the new ruling — **Captain item, unchanged** | unchanged |
| `makesafe_board projection=trade` | allocated only / manager sees all make-safes | role allow-list + `sees_all_makesafes` vs `allocated_only`; payload allow-listed, no pricing | correct | unchanged |
| `_resolveManagerVisibility.isDispatcher` | office = admin/owner/ops_manager | `admin \|\| ops_manager` — `owner` treated as a plain trade in `my_jobs`, `trade_calendar`, `search_all_jobs` | **too closed** (owner) | `_opsApiStaffOperatorRole(role)` — the one staff set |

### Office reads reachable by a `lead_installer` JWT (`LEAD_INSTALLER_READ_ACTIONS`, post-#667)

| Surface | Ruled | Before | Verdict | After |
|---|---|---|---|---|
| `pipeline` | T1 only (every job's quoted `value`, every vertical) | any `lead_installer` role, no managed vertical needed → **every job's quoted value across the company** | **too open** (quote + cross-vertical) | removed from the list (served `trade.html` on ux `main` does not call it) |
| `ops_summary` | T1 only (cross-vertical money aggregate) | same | **too open** | removed (not called by served `trade.html`) |
| `calendar` (team calendar) | T2: own trade(s) | any `lead_installer`, every vertical | **too open** | requires managed verticals; payload post-filtered to them (`_scopeCalendarPayloadToVerticals`: events, deliveries, readiness) |
| `list_users` | T2 (crew directory to allocate) | any `lead_installer` | too open (role name alone) | requires managed verticals |

## Ambiguities resolved RESTRICTIVELY — for the Captain to correct

1. **`invoice` documents hidden from allocated trades.** A client invoice restates the quoted amount, so `TRADE_QUOTE_DOCUMENT_TYPES = {quote, invoice}`. `supplier_quote` (a supplier's price to us, on ops's default-visible list) is NOT treated as the quote and still reaches T3. If the Captain wants supplier quotes hidden too, add it to that set (one line).
2. **`pricing_json.labourTotal` in `trade_labour_budget`.** Read as a component of the quote, so it no longer funds an allocated trade's budget (PO labour lines still do). If the Captain regards the labour budget as not-the-quote, drop the `quoteVisible` guard there.
3. **`scope_json.pricing.labour.{trades,days,dayRate}` kept for allocated trades** (the app's existing "Labour Budget" card shows exactly this to installers; `sell` is stripped). If the Captain wants even that hidden, remove `labour` from `TRADE_SCOPE_LABOUR_KEEP_KEYS`.
4. **MakeSafe open-pool exception kept.** Any signed-in trade may open/report an open MakeSafe before a named assignment exists (`makesafe_open` tier). The ruling says "if a trade is allocated…", so an unallocated trade on a make-safe is outside its letter; the exception is a deliberate, tested product flow (Hugo's intake), so it is kept and named as its own tier that never sees a quote. Removing it is the Captain's call.
5. **`search_all_jobs` typed search reaches every tenant job for every trade** (and the empty-query All tab reaches every company job for Everyone-lens users) by the Captain's 2026-07-31 ruling. The 2026-08-17 ruling implies a plain trade should see only allocated jobs and a manager only their trade. Two rulings conflict; this PR changes nothing there and lists it for the Captain rather than silently reverting the earlier ruling. Note the feed select carries `notes` and `metadata`, not pricing.
6. **`pipeline` / `ops_summary` dropped from the lead_installer read exception** rather than vertical-scoped. Verified against the served `trade.html` (secureworks-ux `main`, 2026-08-17): neither action is called. If a manager surface needs a board read, it should be `my_jobs mode=all` (already vertical-scoped).
7. **`crew_charges_on_my_jobs` / `review_crew_charge` / `list_pending_verifications` now need `is_lead`.** Until leads are designated (`set_job_lead`), these three show nothing / refuse. That is the ruled meaning of "lead"; the alternative (keep reading the worthless `role`) lets any crew member approve any other trade's invoice line.
8. **`owner` added to the Trade dispatcher set.** Office tier is admin/owner/ops_manager everywhere; the Trade resolvers had `admin || ops_manager` only.

## Out of scope, reported (not tier defects, no change)

- `verify_hours` / `dispute_hours` have no lead or ownership check; `create_trade_alert` / `request_assistance` take any `jobId`; `set_trade_rate` / `set_availability` / `acknowledge_invoice_line` (the live case at index.ts:7273 — an earlier duplicate case shadows the JWT-scoped one at 10097) take a body user/line id without ownership; `get_crew_availability` / `list_expenses` / `list_users` are tenant-wide reads. Each is an ownership hole, not a tier decision — separate tickets.
- Free-text `jobs.notes` / `job_events` notes could embed a price; not filterable server-side.

## Front-end (secureworks-ux `trade.html`) changes needed — do NOT edit from this repo

1. `viewOnly` (`isForeignCrewJob`) hides the Comms tab and note/photo controls for a managed-vertical viewer (Henry). Backend now admits him on every door and returns `access_tier: 'division_manager'` on `trade_job_detail`; use it (or `quote_visible`) instead of crew-membership to decide `viewOnly`, so a manager gets the full job UI.
2. Render the `unscheduled` bucket from `my_jobs` for allocated trades (server now returns undated allocations there); today the client only paints today/thisWeek/upcoming/recent.
3. Stop calling `pipeline` / `ops_summary` from any manager path (already true on `main`); `calendar` and `list_users` remain for a lead_installer WITH managed verticals only — a lead_installer without verticals now gets 403 `operator_access_required` there (already handled: 403 is not a logout).
4. `renderJobTab_scope` reads `job.scope_json.pricing.labour` for the Labour Budget card — unchanged shape for allocated trades (days/dayRate/trades survive), so no change required; the quote-bearing keys the client already avoids are simply absent now.
5. Documents tab: allocated trades will no longer see quote/invoice PDFs even if flagged visible; managers now receive the full document list including flagged-off docs — decide whether to badge `visible_to_trades=false` rows for managers.

## Not done here (by design)

- No deploy, no migration, no data change; Henry's `users.managed_verticals` is the Captain's data action.
- Production not observed (token 401) — every "live" statement above is code-derived and labelled.
