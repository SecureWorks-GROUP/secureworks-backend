# Trade app: a fencing person sees all fencing jobs; an assigner sees all the work in the job

Captain ruling, 2026-08-17: *"henry should see all fencing jobs. and whoever
assigns should be able to see all the work in the job."* Reference job
`SWF-26091` (Edgewater, fencing, `scheduled`, four crew rows dated 2026-08-17:
Henry, Alyx, Sonny Longstaff, Anthony — none flagged `is_lead`).

Grounding used, not re-derived: the authority model is `_resolveAllocationAuthz`
(office roles by name, then role-agnostic `users.managed_verticals` containing
`lower(jobs.type)`); `job_assignments.role` is worthless as a signal
(defaults to `lead_installer`); the real lead is `is_lead`.

## 0. What could and could not be observed

- **Observed (production, read-only, ops-api front door via the SecureSuite MCP,
  api_key class = the office/proven path):** `job_detail` for SWF-26091 (crew,
  documents, media, events); `list_jobs?type=fencing` (453 fencing rows by
  status and `assignment_count`).
- **Not observed:** Henry's own `users` row (`role`, `managed_verticals`), his
  live `my_jobs` response, and `ops_api_version`. The Management API and the SQL
  tool both return 401 for this session, and no trade JWT or ops key is available
  here. `ops_api_version` needs a signed caller. So every statement below about
  what Henry *sees today* is derived from main + the successful deploy runs on
  main (`Deploy Edge Functions` green on `5025c65d`, 2 days ago), and is
  labelled as such. Deployed truth was **not** measured; treat "deployed = main"
  as an assumption, per the AGENTS.md rule.
- **Henry's managed vertical, by ancestry rather than by reading the row:** the
  2026-07-31 ruling record (`docs/trade-all-means-all-v1.md`) measured *Henry saw
  102 fencing jobs* through the vertical-manager lane; on 2026-08-03 a
  Henry-authenticated `allocate_job` returned 200
  (`docs/evidence/trade-allocation-collision-2026-08-03.md`), which requires
  `_resolveAllocationAuthz` to pass, i.e. `managed_verticals ∋ fencing` for a
  non-office role; and PR #706 (2026-08-13) names Henry as a lead installer
  *with managed verticals*. Nothing in the record says it was removed since.
  **Note the client hard-codes two Henry logins** (`determineTier`:
  `henry@…` and `emeka.henry.1441@gmail.com`); the SWF-26091 crew row is the
  latter. If the Captain was looking at a different Henry account, that row is
  the first thing to check.

## 1. Ask 1 — a fencing person sees all fencing jobs

### Trigger, masking condition, visible symptom — kept separate

| | |
|---|---|
| Visible symptom | Henry's Trade job list shows only jobs he is personally on. |
| Trigger (what widens the list) | Server: `my_jobs` computes `managerScope = _managerBoardVerticals({ isDispatcher, mode, managedVerticals })` and widens the assignment read to the WHOLE vertical **only when** `mode === 'all'` **and** `users.managed_verticals` contains `'fencing'` (`ops-api/index.ts`, manager branch of `myJobs`; the fencing lane is full-range and paged). Otherwise the read is `user_id = viewer` plus the crew-ready open pool, and a fencing job held by another crew is deliberately dropped (`_shouldRecoverOccupiedPoolJob`, lens `mine`). |
| Masking condition (client) | `trade.html` sends `mode: _adminViewAll ? 'all' : 'mine'`; `_adminViewAll` defaults **true** on login for anyone with `managed_verticals` (`onLogin`, `canUseEveryoneLens`) and there is an Everyone/Mine toggle. The All tab calls `search_all_jobs` which, for a managed-vertical caller, browses the whole tenant (`_resolveTradeJobFeedLens` → `company`). |
| Intentional scope | The open pool is `_CREW_READY_STATUSES` (`order_confirmed / schedule_install / scheduled`) only — the M3b ruling; ordinary crew (no managed vertical) stay own-only by the 2026-07-31 ruling. |

So there is **no server-side query filter that narrows a fencing-vertical
caller on the Everyone lens to their own jobs**, and no client filter either.
The narrow list is what the server returns when EITHER (a) the caller's row has
no `fencing` in `managed_verticals`, or (b) the client asked for `mine`.

### Proven path vs divergent path, earliest divergence

- Proven path: an `ops_manager` session — `isDispatcher` → `showAll` → every
  assignment in the tenant, full range.
- Fencing-vertical lead on `mode=all`: every fencing assignment across every
  crew, full range, plus the crew-ready open pool. Parity floor
  (dispatcher ⊇ manager) is pinned by `myjobs_all_means_all_test.ts`.
- Same person with `managed_verticals` empty, or on `mode=mine`: own rows +
  unassigned crew-ready pool.

The earliest meaningful divergence is therefore **`_managerBoardVerticals`**:
`if (String(input.mode || '') !== 'all') return []` and
`_normalizeManagedVerticals(managedVerticals)`. Everything downstream is common.

### History

- `6f1cd890` 2026-07-05 (#277) Manager View W1: `managed_verticals`, `_resolveAllocationAuthz`.
- `26f49c7e` 2026-07-07 (#295) U2b: manager's Board (`mode:'all'`) sees the whole vertical.
- `6b75dbb2` 2026-07-25 (#377) tenant-scope manager reads; **managed-vertical job-detail access** (`TradeJobAccessContext`).
- 2026-07-31 all-means-all: fencing lane full-range; `search_all_jobs` company lens for managers.
- `#667` 2026-08-13 default-deny front door; `#706` restores four dispatcher-view reads for `lead_installer`. `my_jobs`, `trade_job_detail`, `search_all_jobs`, `trade_calendar`, `allocate_job` were profile-scoped from #667 and are unaffected. `#258` (ux, operator identity before dashboard shells) touched `ops.html` boot, not the trade feed.

None of these narrows a fencing manager's Everyone feed; #667 could only have
*refused* the call outright (403), and `my_jobs` was on the profile-scoped list
from the start.

### Smallest counterfactual and disconfirming evidence

- Counterfactual (single condition that flips the outcome): `users.managed_verticals`
  containing `'fencing'` **with** the request carrying `mode=all`. Run in this
  PR as `Captain 2026-08-17: a fencing-vertical lead on Everyone sees EVERY
  same-tenant fencing job` (`myjobs_manager_scope_test.ts`) — the seen set equals
  the fixture's every live-assigned fencing job plus every unheld crew-ready
  fencing job, and nothing else. The mirror control proves an installer with no
  vertical, and a patio-only manager, see none of the other crews' fencing jobs.
- What would falsify this reading: Henry's live `my_jobs?mode=all` returning
  own-only **while** his `users` row carries `fencing` **and** the deployed
  `ops_api_version.commit_sha` is a descendant of `26f49c7e`. That triple was
  not observable from this session; if it holds, the explanation above is wrong
  and the next place to look is the served `trade.html` bytes (a stale cached
  client) rather than the query.
- Read-only check for whoever has a session:
  `select id, email, role, managed_verticals from users where name ilike '%henry%'`.
  If `fencing` is absent, the fix is a one-row update through the ops UI's user
  editor (server whitelists `makesafe/fencing/patio/decking`), **not code** — and
  it is a permission grant, so it is the Captain's to make.

### Backend change for Ask 1

None to the query. This PR adds the two-direction pin tests named for the ruling
so the contract cannot drift silently. If Henry still sees own-only after this,
it is data (his row) or the device (Mine toggle / stale client), and both are
diagnosable from the check above.

## 2. Ask 2 — whoever assigns sees all the work in the job

### What "all the work in the job" resolves to

The Trade job detail is one payload, `ops-api?action=trade_job_detail`, and its
tabs (`renderJobDetail` in `trade.html`) are: **Work Order** (`workOrder` /
`workOrders` / `workOrderDocuments`), **Scope** (`scopeSummary`, `job.scope_json`),
**Files** (`documents`, already `visible_to_trades`-filtered), **Photos**
(`media` / `currentCycleMedia`), **Comms** (ghl-proxy `get_conversation`,
outside ops-api), **Log** (`notes` from `job_events`), plus the crew roster
(`crew`, `leadInstaller`) and POs with pricing stripped.

### Per surface: server refusal, empty response, or client not rendering

Measured against the code path for a fencing-vertical lead who is **not** on the
crew of a fencing job (exactly the assigner's situation after they allocate
others), compared with the ops_manager proven path:

| Surface | ops_manager | fencing-vertical lead not on crew (before) | Kind |
|---|---|---|---|
| `trade_job_detail` (WO, scope, files, photos, log, crew) | 200, full | 200, **byte-identical** payload — `assertAssignedOrMakesafeAccess` receives `{orgId, managedVerticals}` and admits the vertical (#377) | none withheld |
| `add_note` (Log write) | 200 | **refused** "You are not assigned to this job" — call site passed no access context | server refusal |
| `upload_photo`, `get_upload_url`, `confirm_upload` (Photos write) | 200 (admin) | **refused** — same omission | server refusal |
| `get_service_report` (report read) | refused unless assigned (isAdmin not threaded) | **refused** — same omission | server refusal |
| `my_work_orders` (WO tab cost breakdown) | own only (client sends no `mode`) | own only → "No invoiceable work order found" | client (request shape) |
| Comms tab | rendered | **not rendered**: `isForeignCrewJob()` → `viewOnly` hides the tab and the note/photo controls | client not rendering |
| quote PDFs flagged `visible_to_trades=false` | hidden | hidden | intentional (2026-08-03 policy), left withheld |
| `job.metadata`, PO pricing | stripped | stripped | intentional, left withheld |

So on the read side the assigner already sees everything the trade payload
carries; the divergence is that **the sibling per-job doors ran the same
predicate without the context** (`addNote`, `uploadPhoto` / `getUploadUrl` /
`confirmUpload`, `getServiceReport`) while `tradeJobDetail` and `submitServiceReport` (#526)
passed it. Earliest divergence: the call sites, not the predicate.

### Backend change (this PR)

Thread ONE `TradeJobAccessContext` (`orgId` + `managedVerticals`, from the
server-owned profile, never the request) into those call sites. Same predicate,
every door: an assigner of the job's vertical now writes to its log, uploads to
its photos and reads its report; a patio-only manager, an unassigned installer
and another tenant are still refused; the MakeSafe field-report exception is
unchanged; staff callers keep their unchanged bypass and gain no extra read.
Regression + controls: `trade_manager_job_access_test.ts` (15 tests; the five
widening tests go red when the old call sites are restored, the ten controls
are green on both shapes).

No front-door set changed. `_opsApiActionNeedsSignedCaller`,
`OPS_API_PROFILE_SCOPED_JWT_ACTIONS`, `LEAD_INSTALLER_READ_ACTIONS` and the
office-role sets are untouched.

### Front-end half (secureworks-ux `trade.html`, not editable from here)

1. `isForeignCrewJob(data)` currently makes every job the viewer is not
   personally on `viewOnly`, hiding the Comms tab and the note/photo controls.
   For a viewer with `managesTradeVertical(job.type)` those controls should
   render (the server now accepts them); keep the OWN-assignment writes (clock,
   accept, complete, invoice) gated exactly as today.
2. The Work Order tab's cost-breakdown read `api('my_work_orders')` sends no
   `mode`; for a managed-vertical viewer pass `mode:'all'` (the server already
   bounds it to their verticals) so an assigner is not told "No invoiceable
   work order found" on a job that has one.
3. Nothing needed for Ask 1 if the row carries `fencing`.

### Deliberately left withheld / not touched

- Quote PDFs flagged not-visible-to-trades, `job.metadata`, PO pricing: trade-wide
  policy, not an assigner question.
- `update_assignment` (Board schedule edit) and `reassign_crew` are staff-only at
  the front door since #667 for a `lead_installer` JWT even though
  `update_assignment` carries a vertical-manager check inside. They are
  assignment WRITES, adjacent to the concurrent `trade-lead-assign` slice
  (`set_job_lead`), and outside these two asks; noted, not fixed.
- `trade_labour_budget` still calls the narrower `assertAssigned` (own
  assignment only, no vertical or MakeSafe fallback), so a vertical manager is
  still refused that read. Pre-existing, outside these two asks; noted, not
  fixed.
- Latent trap, unchanged: the client accepts any `managed_verticals` string,
  the server whitelists four.

## 3. Guards, before and after

For every caller class the reachable set is equal or smaller except the one
named widening (managed-vertical caller, in-vertical job, four per-job write
doors — `add_note`, `upload_photo`, `get_upload_url`, `confirm_upload` — plus
the `get_service_report` read), which is scoped by the same vertical predicate
`_resolveAllocationAuthz` uses to let that caller assign the job in the first
place. Passing `orgId` also adds a tenant check those five doors did not
previously run.
