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

The migration version could **not** be checked against the live
`supabase_migrations.schema_migrations` ledger: both available Supabase
Management API tokens returned 401 (see the open item below). `20260803010000`
is ahead of every migration in this repo, but the AGENTS.md rule is to check the
live ledger, and that check is outstanding. `bash
scripts/apply-pending-migrations.sh --dry-run` with a working
`SUPABASE_ACCESS_TOKEN` reproduces it read-only.

## Open items

- **Management API access is broken from this workspace.** Both the
  `SUPABASE_ACCESS_TOKEN` in the environment and the one configured on the
  `supabase` MCP server return HTTP 401 on `GET /v1/projects`. All production
  measurement in this document was taken read-only through the ops-api front
  door instead. The live-ledger version check above is blocked on this.
- **`job_assignments.visible_to_trades` is written but never read.**
  `createAssignment` sets it true for make-safe allocations with a comment
  saying allocated make-safes are otherwise invisible to the trade, but no query
  in `ops-api` filters on it. Either the comment is stale or a filter was lost;
  worth resolving separately rather than guessing here.
- **Client rendering is a separate repo.** `dashboard/trade.html` lives in
  `secureworks-ux`. The server now returns a crew roster with names, a lead, a
  scope line, every live work order and a work-order document surface; rendering
  them is a follow-up PR there, in the same shape as the client follow-up
  section of `docs/trade-all-means-all-v1.md`.
