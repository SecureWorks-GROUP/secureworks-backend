# Trade app: crew visibility, the named lead, and the missing scope/work order

2026-08-03. Three things an installer reported, diagnosed and fixed together
because they are one payload: `ops-api` `trade_job_detail`.

1. *"allow users know who they're on the job with"*
2. *"an option to assign someone as the lead installer for a job leaving others
   as crew members"*
3. *"those i assign jobs to can only see material order and photos. Can't see
   scope/work order"* — reported as a bug, and treated as one first.

## Item 3: the diagnosis

### It is not a role rule, and the trigger is not "being assigned"

`tradeJobDetail` has exactly one role-dependent branch:
`assertAssignedOrMakesafeAccess`, which is all-or-nothing. Past that gate an
ordinary assigned installer and a dispatcher receive a **byte-identical**
payload for the same job. There is no per-role field masking, and the client is
a service-role client, so RLS is not in play either. Whatever the reporter can
see and their crew cannot, the difference is not produced by the trade backend
deciding differently for the two of them.

Two hypotheses were tested against production and **refuted**, which is worth
recording because both were plausible:

- *"The crew select names a column that does not exist, so PostgREST 400s and
  `|| []` silently empties it"* — the documented top gotcha in AGENTS.md. The
  live `job_assignments` column set was read back through the admin `job_detail`
  path (which uses `select('*')`): all 18 columns the trade crew select names
  exist. Refuted.
- *"An installer is refused and sees a degraded page"* — refuted by the symptom
  itself. Materials and photos render, so the call returned 200.

### The masking condition is the payload's shape, not the viewer

Read-only production measurement, 2026-08-03, via the ops-api front door
(`SW_API_KEY`, GET only). 24 jobs sampled that actually carry assignments,
drawn from the calendar feed over 2026-05-01 → 2026-08-10:

| Fact | Measured |
|---|---|
| `work_orders` rows in the entire database | **33 distinct jobs** |
| distinct jobs carrying an assignment, 3-month window alone | **232** |
| sampled assigned jobs with a `work_orders` row | 11 / 24 |
| sampled assigned jobs with `scope_json` | 18 / 24 |
| largest single `scope_json` blob in the sample | **1,635,807 bytes** |

So `workOrder` was null on **54% of the assigned jobs sampled**, because the
trade payload sourced the work order *only* from the sparse `work_orders` table.
And the only route to scope on the trade payload was the raw `scope_json` blob —
up to 1.6 MB, mostly base64 site-plan media — which is not something a phone
should be reverse-engineering.

The reporter can see the work order because ops.html calls the admin
`job_detail`, which returns `work_orders` as an **array** of every live row and
every document. The trade path returned at most one work order (`.limit(1)`),
and buried the work-order PDF inside an undifferentiated `documents` array.

### The earliest real divergence

`jobDetail` (admin, proven path) vs `tradeJobDetail` (failing path), same table:

```
admin:  .from('work_orders').select('*').eq('job_id',id).neq('status','cancelled').order(...)
trade:  .from('work_orders').select(...).eq('job_id',id).neq('status','cancelled').order(...).limit(1)
```

`.limit(1)` plus the singular `workOrder` key is the divergence. It is real, not
theoretical — the sample contains jobs carrying two live work orders, where an
installer sent to the older one read the newer one's scope.

### The smallest change that flips the outcome

Three additive keys and one removed `.limit(1)`:

- `scopeSummary` — derived from `jobs.scope_json` by `buildScopeSummaryLine`,
  **the helper ops already uses** for invoice descriptions. No second scope
  grammar was written; the capability existed and was simply never wired to the
  trade payload.
- `workOrders` — every live work order, matching the admin path. `workOrder`
  keeps its exact previous meaning for the existing client.
- `workOrderDocuments` — the work-order PDFs, lifted out of `documents`.

### What would have proved this wrong

A missing live column in the crew select, or any role branch inside
`tradeJobDetail`. Both were checked and neither exists. If the trade client
turns out to already render `job.scope_json` itself, then `scopeSummary` is a
convenience rather than the fix — but `workOrder` being null on 54% of assigned
jobs is not affected by that, and stands on its own.

## The commercial-visibility finding (a narrowing, not a widening)

`job_documents.visible_to_trades` is the declared answer to "may a trade see
this document". `tradeJobDetail` **selected that flag and shipped every row
anyway**, leaving the decision to the client.

Measured across the same 24 jobs: **108 documents reached the trade payload, 55
of them flagged `visible_to_trades = false`, including 38 QUOTE PDFs.** Quotes
carry pricing and margin.

| type | flagged true | flagged false |
|---|---|---|
| quote | 8 | **38** |
| work_order | 8 | 15 |
| supplier_quote | 10 | 1 |
| general | 15 | 0 |
| site_photo | 11 | 0 |
| client_reference | 1 | 1 |

The flag is **never null** in production — every row is explicitly true or false
— so honouring it exactly is both the narrow reading and the whole reading. The
payload now sends only rows flagged true.

This is enforcing an existing declared policy, not deciding a new one: ops sets
the flag on insert by document type and toggles it through the ops-only
`set_document_visibility` action. Ops keeping 8 quotes flagged true is ops's
call and is honoured. The 15 false work-order rows are superseded versions —
every sampled job with any work-order document has exactly one flagged true.

## Items 1 and 2: crew and the named lead

### Where job assignment lives, and whether crew is already modelled

`job_assignments` — one row per crew member per job — is the crew model, and it
already carries `role`, already joins `users(name, phone)`, and is already
projected with `role` by the make-safe board read model
(`assignmentFacts` in `makesafe_board_read_model.ts`). It was extended; no
parallel model was introduced.

`tradeJobDetail` already returned `crew`. What it did not do was surface a
`name` or any lead concept.

### Can a job have exactly one lead, and what happens to existing assignments?

**`job_assignments.role` cannot answer "who leads" and must not be repurposed.**
It is declared `default 'lead_installer'` in the original schema, and
`createAssignment` reinforces that with `role: role || 'lead_installer'`.
Measured on the 24-job sample (133 non-cancelled rows):

- `role` values in production: `lead_installer` **112**, `observer` **21**
  (`observer` is not in the repo's CHECK constraint — live schema drift, so
  nothing here depends on that constraint)
- **19 of 24 jobs carry two or more `lead_installer` rows**; one job carries 28

Reading a lead out of that column would name an arbitrary person on almost every
job in the business. So the lead is a new explicit flag,
`job_assignments.is_lead`, and **the migration deliberately does not backfill
it**. Every existing job ships with no lead, which is the truthful state: nobody
has ever been designated. `leadInstaller` is `null`, never a guess.

Exactly one lead per job is guaranteed by the database, not by application code:
`uq_job_assignments_one_lead`, a partial unique index on `job_id` where
`is_lead`. `setJobLead` clears then sets, in that order, because the index makes
any other ordering fail.

### Who is allowed to set the lead

The narrow reading, taken from what the code already says. Designating a lead is
an assignment mutation, so `set_job_lead` is gated by the **existing**
`assertAssignmentMutationAuthz` / `_resolveAllocationAuthz` pair that already
gates `create_assignment` / `update_assignment` / `delete_assignment`: the
dashboard or service key, a dispatcher (`admin` / `owner` / `ops_manager`), or a
manager of that job's vertical. An ordinary assigned installer is refused —
including on their own job and their own row. The make-safe automation routine
is refused outright.

## Tests

`supabase/functions/ops-api/trade_crew_visibility_lead_test.ts` — 22 tests
driving the **real** `tradeJobDetail` against a stub client, as an ordinary
installer viewer (`isAdmin = false`), not an admin.

Proof the regression tests fail on the old shape: the implementation was
reverted in place (payload behaviour only, test exports retained so the controls
could still run) and the suite re-run —

```
FAILED | 14 passed | 8 failed (13ms)
  assigned installer sees who else is on the job, with names
  no lead is designated until somebody designates one
  set_job_lead names exactly one lead and the payload reports it
  assigned installer gets a readable scope summary
  assigned installer gets EVERY live work order, not just the newest
  assigned installer gets the work-order PDF as its own surface
  CONTROL: a quote PDF flagged not-visible-to-trades never reaches an installer
  CONTROL: a superseded work order flagged not-visible stays hidden
```

The two failing CONTROLs are the leak proof: on the old shape the assertion
message is literally `quote PDF leaked to the trade payload`.

**Which controls pass on BOTH shapes** — the ones proving this did not widen too
far. All 14 that passed on the old shape pass on the new one:

- an ordinary installer may not name the lead
- an installer may not name the lead on their own job either
- a vertical manager may name the lead only in their vertical
- the make-safe automation routine may never name a lead
- a non-crew or cancelled person cannot be made lead
- an assignment belonging to another job cannot be made lead
- an unassigned installer is still refused the job entirely
- `job.metadata` still never reaches the trade payload
- PO line items still carry no pricing
- the scope summary can never fall back to a quote description
- `leadInstaller` is null rather than a guess when nobody is flagged
- moving the lead leaves exactly one lead, never two
- the lead can be cleared back to nobody
- an empty document set stays empty

Full suite: **2964 passed / 18 failed** against a **2942 / 18** baseline on the
same commit without these changes — the 18 failures are byte-identical and
pre-existing (one of them, `ses_artifact_hash_budget_test.ts`, is the documented
`--allow-run` skip). `deno check --config deno.jsonc
supabase/functions/ops-api/index.ts` is clean.

## Deploy

**Migration first**, and the gate enforces it. The trade crew select names
`is_lead`; per AGENTS.md a missing column returns a PostgREST 400 that degrades
to an **empty crew list** rather than an error, which would blank the very
feature this ships. `20260803010000_job_assignment_lead_installer.sql` is
therefore declared in `scripts/edge-function-schema-requirements.txt` so the
production lane refuses to deploy `ops-api` until the column and the unique
index exist. `tradeJobDetail` additionally logs `crewRes.error` loudly so a gate
bypass is diagnosable instead of invisible.

Rollback twin: `supabase/rollbacks/20260803010000_..._down.sql`.

### UNVERIFIED: the live migration-ledger version check

**This check was not performed. Treat the migration version as unconfirmed
until it is.**

AGENTS.md requires a new migration's version to be checked against the LIVE
`supabase_migrations.schema_migrations` ledger, not just against
`supabase/migrations/`, because production carries migrations applied through
other lanes that are not in this repo.

**What the check would have confirmed:** that version `20260803010000` does not
already exist in the production ledger under a different filename. A repository
file whose version matches a ledger row of a different name is a `ledger
version/name collision`, and it fails the entire deploy run — every migration
and every function — before anything ships. The fix for a collision is to
renumber this file (plus its `supabase/rollbacks/` twin and every reference to
it), never to add an exclusion or an alias.

**Why it was not done:** both available Supabase Management API tokens return
HTTP 401. Per the captain, those credentials are dead and are being handled
separately; they were not chased. All production measurement in this document
was taken read-only through the ops-api front door instead, which cannot read
the ledger.

**How to close it:** `bash scripts/apply-pending-migrations.sh --dry-run` with a
working `SUPABASE_ACCESS_TOKEN` reproduces the whole gate read-only. It is the
cheap pre-merge check.

What is known without the ledger: `20260803010000` is ahead of every migration
present in this repo (newest is `20260802030000`). That is necessary but not
sufficient.

### Ordering: the migration MUST land before ops-api

For whoever merges this. The two halves of this change are not
order-independent:

`tradeJobDetail`'s crew select names `is_lead`. If `ops-api` ships while the
column is absent, PostgREST returns a 400 and the call site's `|| []` turns that
into an **empty crew list** — not an error. The trade app would show every
assigned installer that nobody is on the job with them, silently, which is worse
than the bug this change fixes.

`scripts/edge-function-schema-requirements.txt` declares the column and the
index, so the production lane refuses to deploy `ops-api` until both exist, and
the standard workflow applies pending reviewed migrations before deploying
function code. The ordering is therefore enforced rather than trusted — but it
is enforced by that manifest entry, so do not drop it, and do not deploy
`ops-api` from a path that bypasses the lane.

## Client follow-up (`secureworks-ux`, separate task)

`dashboard/trade.html` lives in `secureworks-ux` and was deliberately not
touched from this worktree. **The server now returns everything below; the app
still has to render it.** None of it is speculative — every key is asserted by
`trade_crew_visibility_lead_test.ts`.

All five items read from the existing `trade_job_detail` response. No new call,
no new parameter, no auth change.

1. **Crew section — "who am I on the job with".** `crew[]` now carries a
   resolved `name` (from the joined user, falling back to `crew_name`) and
   `is_lead`. The existing section header in the trade-app doc says "who else is
   assigned today"; the payload is deliberately NOT date-filtered (the user
   explicitly opened this job), so render the whole roster.
2. **Lead badge.** `leadInstaller` is `{assignment_id, user_id, name}` or
   **`null`**. The lead's phone is read from the matching `crew[]` row rather
   than duplicated onto `leadInstaller`. Null is the normal case today and for every historical job — it
   means nobody has been designated, and it must render as absent, not as a
   placeholder or a guess. Do not derive a lead from `crew[].role`; see the
   role-default measurement above for why that column says almost everyone is a
   lead.
3. **Scope.** `scopeSummary` is a plain one-line string, e.g.
   `6m x 4m, Gable, SolarSpan 75mm, Monument, 4 x 100x100 SHS posts`. It is
   `""` when the scope blob yields nothing — render nothing, not an empty
   heading. This is what the app should show instead of reaching into
   `job.scope_json`, which is the multi-hundred-kB scoping-tool blob.
4. **Work order.** `workOrders[]` is every live work order; `workOrder` is
   unchanged and still the newest one, so **the existing rendering keeps
   working untouched** — this is purely an opportunity to show all of them on
   the jobs that have more than one.
5. **Work-order PDF.** `workOrderDocuments[]` is the work-order documents ops
   has flagged for trades, already visibility-filtered.

**One behaviour change to be aware of on the client side:** `documents[]` is now
filtered server-side to `visible_to_trades = true`. If `trade.html` currently
does its own `visible_to_trades` filter, it becomes a no-op and nothing changes.
If it does NOT filter, the document list will get shorter — that is the point,
it was showing quote PDFs. Either way the client needs no change for
correctness; check it only so the shorter list is not mistaken for a defect.

Setting a lead (`set_job_lead`) is an **ops** action, not a trade one: an
ordinary installer is refused by the server. If a lead picker is wanted in the
trade app it belongs on the manager/dispatcher allocation screen, alongside the
existing allocate flow, and it will only work for a dispatcher or a manager of
that job's vertical.

## Other open items

- **Management API access is broken from this workspace.** Both the
  `SUPABASE_ACCESS_TOKEN` in the environment and the one configured on the
  `supabase` MCP server return HTTP 401 on `GET /v1/projects`. Per the captain
  these credentials are dead and are being handled separately; they were not
  chased. Consequence for this change is the unverified ledger check above.
- **`job_assignments.visible_to_trades` is written but never read.**
  `createAssignment` sets it true for make-safe allocations with a comment
  saying allocated make-safes are otherwise invisible to the trade, but no query
  in `ops-api` filters on it. Either the comment is stale or a filter was lost;
  worth resolving separately rather than guessing here.
- **`job_assignments.role` carries an undeclared value in production.** Live
  data contains `observer`, which is not in the repo's `job_assignments_role_check`
  constraint (`lead_installer, helper, estimator, crew, lead`). Nothing in this
  change depends on that constraint, but it is live schema drift.
