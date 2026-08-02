# SES readiness gate drop v1

**Branch:** `fm/ses-readiness-gate-drop-v1`
**Captain's ruling:** `data/decisions/2026-08-03-captain-drops-the-readiness-precondition.md` (firstmate home) — option 3, drop the precondition, never assert readiness.
**Status:** implementation complete and committed. Live mint on SWMS-261109 NOT performed — blocked (section 8.7). One needs-decision raised (section 6).

---

## 1. The deadlock, re-proved end to end

### Static trace (repo)

| Fact | Evidence |
|---|---|
| `ready` defaults false | `20260728000001_..._u2.sql:223` |
| Only `commit_makesafe_readiness` sets it true | `..._u2.sql:565` |
| Exactly two callers repo-wide | `..._u5_u6.sql:745`, `:1593` — grep for `commit_makesafe_readiness` across `*.sql` + `*.ts` returns only those two `PERFORM` sites, one `CREATE`, the REVOKE/GRANT pair, and the rollback `DROP` |
| Caller 1 refuses unless already ready | `..._u5_u6.sql:610-613` |
| Caller 2 refuses unless already ready | `..._u5_u6.sql:1417-1418` |
| Caller 2 is the only site that *would* write `true` unconditionally | `..._u5_u6.sql:1589` passes literal `true` — but only after its own precondition passes |
| Caller 1 can only propagate | `next_ready := prior_readiness.current_ready AND ...` (`:738-739`) |
| The only creator of the row writes it false | `invalidate_makesafe_readiness` (`..._u2.sql:503-545`) |
| No later migration replaces either function | grep for both function names finds only `20260728020000` (definition + REVOKE + GRANT) and the two TS RPC call sites |

### Behavioural proof (production, read-only Management API, `read_only: true`)

```
readiness_rows            191      -- makesafe_readiness_current
readiness_ready_true        0
readiness_revisions         0      -- makesafe_readiness_revisions is EMPTY
readiness_revisions_ready   0
obligation_revisions        0
invalidations             511      -- the invalidator has been running fine all along
approvals                   0
makesafe_invoice_obligations total = 0
```

This is **stronger than the static argument**. The precondition is not merely
"unsatisfiable in principle": both preconditions `JOIN
makesafe_readiness_revisions`, and that table has **zero rows in production**.
`NOT FOUND` is therefore unconditionally true for **every job on the board**,
always. The `NOT ... current_ready` half of the test has never even been
evaluated.

`invalidations = 511` against `readiness_revisions = 0` is the shape of a
half-built phase exactly as described: the invalidator shipped, the producer
did not.

---

## 2. The minimum honest change is NOT "delete the RAISE blocks"

The task invited me to say so if my reading disagreed. It does.

`prior_readiness` is consumed **downstream** of the precondition in both
functions:

- fn 1: `.dependency_envelope` (`:724`), `.current_ready` (`:738`),
  `.blockers` (`:741-743`), `.attendance_cycle_set_hash` /
  `.family_matrix_revision` (`:749-750`)
- fn 2: `.dependency_envelope` (`:1571`), `.attendance_cycle_set_hash` /
  `.family_matrix_revision` / `.blockers` (`:1587-1591`)

With the `RAISE` deleted and nothing else changed, `prior_readiness` is an
all-NULL record. Traced:

1. `jsonb_set(NULL, …)` → NULL (`jsonb_set` is STRICT)
2. `makesafe_readiness_revision_v1(NULL)` → NULL (declared `STRICT`)
3. `commit_makesafe_readiness(…, p_readiness_revision => NULL, …)` — every
   guard inside it compares NULL to NULL and passes (`IS DISTINCT FROM`
   between two NULLs is false; `jsonb_typeof(NULL) <> 'object'` is NULL, so
   the `IF` is not taken)
4. `INSERT INTO makesafe_readiness_revisions (… readiness_revision …) VALUES (… NULL …)`
   → **`23502` not-null violation**

So a bare deletion swaps a clean `23514` for an uglier `23502`. The card still
never mints. The honest change has to decide what the readiness re-commit does
when there is nothing to re-commit.

### The shape chosen

> When there **is** a certified prior readiness revision, behave exactly as
> today, byte for byte. When there is **not**, record the invalidation and
> **skip the readiness re-commit entirely.**

Readiness is never asserted, never synthesised, never defaulted to true. The
uncertified branch leaves `makesafe_readiness_current` in the state it is
already in for all 191 live rows — `readiness_revision = NULL`, `ready =
false`, `invalidated_at` set — which is the truthful state: *readiness does not
know*.

This is minimal in the strict sense: **the only behaviour that changes is on
the path that previously raised.** Every input that would have been accepted
before is handled by identical code.

---

## 3. Scope decisions

### 3.1 `commit_ses_invoice_obligation_revision_v1` (`:610-613`) — CHANGED

In scope, explicitly. This is the 409 on every card.

### 3.2 `commit_ses_invoice_bound_docket_v1` (`:1417-1418`) — CHANGED

**Reasoning, as required.** Its message ("new evidence landed; review the
current docket revision again") reads as a freshness check, and in the intended
Phase-2 world it *is* one: after each material fact change the invalidator
clears the pointer, and the producer re-commits, so a stale binding would find
no matching revision. But:

1. **It is implemented as a readiness-ready precondition, not a freshness
   check.** It compares nothing against the docket it is binding from. A real
   freshness check here would test `current_row.readiness_revision =
   base.readiness_revision` (the `pre_xero` docket revision it copies).
   Dropping the `ready` test therefore removes no freshness comparison,
   because there is no freshness comparison to remove.
2. **It is equally unsatisfiable, and provably so after the fn-1 fix.** fn 1
   only ever *propagates* an existing `true`; it never bootstraps one. So after
   fn 1 is fixed, readiness on these cards is still `ready = false` with a NULL
   revision. fn 2's `NOT FOUND` fires for exactly the same reason it fires
   today. It moves the same deadlock one step later, which is the case the
   ruling names.
3. **Leaving it would be actively worse than changing it**, because fn 2 is the
   one site that passes a literal `true` to `commit_makesafe_readiness`
   (`:1589`). Any careless later "fix" that just deletes its `RAISE` would turn
   fn 2 into a readiness *forger*. The change here forecloses that: the
   uncertified branch skips the commit, so the `true` is unreachable without a
   real prior certification.

Changed, with the identical never-assert shape.

### 3.3 `next_ready := prior_readiness.current_ready AND …` (`:738-739`) — UNCHANGED

It now lives inside the certified branch, where `current_ready` is true by
construction, so it reduces to `p_revision->>'state' <> 'blocked'` — its intended
meaning. Left verbatim because:

- Making it `true` would assert readiness. Forbidden.
- Making it `false` would destroy a legitimately certified readiness state once
  the Phase-2 producer exists — a real regression planted for later.
- As written it can only ever **weaken** readiness (`true AND x`), never
  manufacture it. That is exactly the property the ruling wants preserved.

---

## 4. Recording that readiness was NOT certified

No schema change was needed. `invalidate_makesafe_readiness` already writes an
append-only `makesafe_readiness_invalidations` row on every obligation commit,
carrying `dependency_kind`, `dependency_identity` (**the exact obligation
revision id**), `reason`, `actor` and `generation_after`, with `UNIQUE (job_id,
generation_after)`. The same `reason` lands on
`makesafe_readiness_current.invalidation_reason`, so it is visible on the card
as well as in the ledger.

The uncertified branch passes a **distinct reason string** naming the ruling:

```
… ; readiness was NOT certified at mint (captain ruling 2026-08-03 …)
```

So "which obligations were minted under this decision" is a single join, on
schema that already exists, append-only, with no new column and no new table.

Query for the captain:

```sql
SELECT i.job_id, i.dependency_identity AS obligation_revision_id, i.invalidated_at
FROM public.makesafe_readiness_invalidations i
WHERE i.dependency_kind = 'makesafe_invoice_obligation_revisions'
  AND i.reason LIKE '%readiness was NOT certified at mint%';
```

`commit_ses_invoice_obligation_revision_v1` additionally returns a new
`readiness_certified` boolean key. It is additive; the TS caller passes the RPC
result straight through (`ses_reporting_actions.ts:725-737`).

---

## 5. What is NOT changed

| Gate | Status | How it is proved |
|---|---|---|
| Money seal `jobs.ses_money_sealed_at` and `_shared/sealed_ses_money_fence.ts` | untouched | The migration contains no executable statement referencing `ses_money_sealed_at` or `xero_invoices` — pinned by a test that strips `--` comments (the seal is named in prose only, to record it as out of scope). The fence file is not modified. `sealed_ses_money_fence_test.ts` is green and unchanged. |
| Human APPROVE INVOICE gate | untouched | `ses_reporting_actions.ts` is not modified. Pinned by a control test on `!authority.allowed \|\| operatorAuth.mode !== "jwt" \|\| !auth.user` and on `loadOperatorAuth` returning `{ mode: "api_key" \| "routine" }` without a user — a routine or api-key caller can never reach `jwt` mode. |
| `record_ses_revision_approval_v1` readiness recheck | untouched | Control test pins `NOT current_readiness.ready`, `NOT current_readiness.revision_ready`, the allowlist refusal and the mechanically-clean refusal. See section 6. |
| Every other precondition in both changed functions | untouched | 12 refusal strings asserted present in the effective bodies (job existence, cycle cardinality, content-hash collision, released/Xero-bound supersede refusal, explicit-supersede refusal, AUTHORISED binding shape, `pre_xero` base revision, confirmed effect-ledger row, SEND-IT ordering). |
| Readiness table, invalidator, recording behaviour | untouched | The migration contains no `DROP TABLE`/`DROP FUNCTION`/`DROP TRIGGER`, no `UPDATE public.makesafe_readiness_current`, and writes **zero rows at apply time** (verified by stripping the `AS $$ … $$;` bodies and asserting no top-level `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`). `invalidate_makesafe_readiness` is still called on every commit, certified or not. |
| Pricing, duplicate probe, blockers, cycle binding | untouched | The two function bodies are otherwise byte-identical to the originals — see the diff in section 8.2. |

---

## 6. The remaining wall — NOT in scope, NOT touched, needs a decision

`record_ses_revision_approval_v1` (`..._u5_u6.sql:978-996`) carries a **third**
instance of the same unsatisfiable gate:

```sql
IF NOT FOUND
   OR NOT current_readiness.ready
   OR NOT current_readiness.revision_ready
   OR current_readiness.readiness_revision IS DISTINCT FROM p_approval->>'readiness_revision'
   OR current_readiness.dependency_generation IS DISTINCT FROM (…)::bigint THEN
  RAISE EXCEPTION 'new evidence landed; review the current docket revision again'
```

Same `INNER JOIN makesafe_readiness_revisions` (0 rows), same `NOT … ready`.

This is the RPC behind **APPROVE INVOICE** itself. The captain's ruling names a
closed list of two functions and the task says no other precondition on the
obligation path may be removed, so **I have not touched it.**

Consequence, stated plainly: this change delivers "a job with a clean docket can
**reach** the captain's approval button" — the obligation now mints and the
cockpit binds it. **Pressing** the button will still 409 with `new evidence
landed; review the current docket revision again`, from
`record_ses_revision_approval_v1`, until the captain rules on that third site.

Related, same table, also untouched and also unsatisfiable today:
`makesafe_revision_approvals_current_v2` filters `WHERE … readiness.ready = true`
(`..._u5_u6.sql:457`), and `begin_ses_release_execution_v1` re-tests
`NOT current_readiness.ready` per release member (`:1213-1218`).

**This is a needs-decision for FirstMate, not something I have acted on.**

---

## 7. Pre-existing defect noticed in passing (not fixed, not in scope)

`invalidate_makesafe_readiness` requires `jobs.type = 'makesafe'` (`..._u2.sql:521-525`)
and raises `current make-safe job not found` otherwise. The obligation commit calls
it unconditionally. Restoration cards are `jobs.type = 'insurance'` with
`metadata.insurance_job_type = 'restoration'` (per repo `CLAUDE.md`), so the
obligation path would throw for a restoration card. Pre-existing — the call is
unconditional in the original migration and this change does not alter it.

---

## 8. Proof

### 8.1 Files

| File | What |
|---|---|
| `supabase/migrations/20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql` | the change — two `CREATE OR REPLACE FUNCTION`, grants restated, two `COMMENT ON FUNCTION`. **Writes zero rows.** |
| `supabase/rollbacks/20260803010000_..._down.sql` | restores the two bodies **byte-identically** to lines 550-766 and 1318-1606 of `20260728020000`, generated mechanically from that file rather than retyped, with a header warning that running it today re-blocks the whole board |
| `supabase/functions/ops-api/ses_readiness_precondition_drop_test.ts` | 12 tests: 6 regression, 1 destructiveness check, 5 controls |

Version `20260803010000` was checked against the **live** ledger
(`supabase_migrations.schema_migrations`), not just against the repo. Live max is
`20260802030000` and the repo max is the same, so repo and production are in
sync and `20260803010000` is unused — no ledger version/name collision.

No edge-function source changed, so no
`scripts/edge-function-schema-requirements.txt` entry is needed (the manifest's
marker kinds are table/column/constraint/index/policy/trigger; this migration
adds none of them) and no exclusion or alias is involved.

### 8.2 The change is exactly the intended diff

A mechanical unified diff of the two effective bodies against the originals
removes **only**:

- the two `IF NOT FOUND OR NOT prior_readiness.current_ready THEN RAISE … END IF;` blocks
- the two hard-coded invalidation reason literals, replaced by a `CASE` that
  appends the uncertified marker
- the readiness-commit blocks, which are **re-added verbatim, re-indented,
  inside `IF readiness_certified THEN`**

Nothing else is removed. Structural balance check on the four bodies:
`IF`/`END IF` nets to 0 in all four; `BEGIN`/`END` nets to `-(number of CASE
expressions)` in all four, which is correct because a `CASE … END` expression
contributes one bare `END` (originals: −1 and 0 with 1 and 0 CASEs; new: −2 and
−1 with 2 and 1 CASEs).

### 8.3 The regression test fails on the old shape

Proved by moving **only** the migration out of the tree and re-running the
**byte-identical** test file:

```
### OLD SHAPE: implementation reverted, test file byte-identical ###
running 12 tests from ./supabase/functions/ops-api/ses_readiness_precondition_drop_test.ts
the drop migration owns the effective obligation and bind bodies ... FAILED (1ms)
the obligation commit no longer refuses on an uncertified readiness revision ... FAILED (0ms)
the invoice-bound docket commit no longer refuses on an uncertified readiness revision ... FAILED (0ms)
readiness is dropped as a blocker, never asserted ... FAILED (0ms)
an uncertified mint is recorded, not silently omitted ... FAILED (0ms)
no other precondition on the obligation path was removed ... ok (0ms)
CONTROL: the human APPROVE INVOICE gate is untouched ... ok (0ms)
CONTROL: record_ses_revision_approval_v1 keeps its own readiness recheck ... ok (0ms)
the drop migration destroys nothing and touches no money row ... FAILED (0ms)
CONTROL: the readiness table, its invalidator and its recording behaviour survive ... ok (0ms)
CONTROL: the money seal fence is intact ... ok (0ms)
CONTROL: a genuinely blocked docket still cannot produce an executable obligation ... ok (0ms)
FAILED | 6 passed | 6 failed (5ms)
```

Sample failure message: `AssertionError: the unsatisfiable readiness refusal is
still in the effective obligation body`.

The tests read the **effective** body — every migration scanned in version
order, last `CREATE OR REPLACE FUNCTION` wins, which is what the database ends
up holding. That is why removing the migration flips them, and it also means a
future migration that re-introduces the precondition fails these tests too.

On the new shape:

```
ok | 12 passed | 0 failed (3ms)
```

### 8.4 Controls: pass on BOTH shapes

Every one of the five `CONTROL:` tests — plus "no other precondition on the
obligation path was removed" — is **`ok` on the old shape and `ok` on the new
shape** (see the two runs above). None of them reads the new migration, by
design, so they are shape-independent:

| Control | Old shape | New shape |
|---|---|---|
| the human APPROVE INVOICE gate is untouched | ok | ok |
| `record_ses_revision_approval_v1` keeps its own readiness recheck | ok | ok |
| the readiness table, its invalidator and its recording behaviour survive | ok | ok |
| the money seal fence is intact | ok | ok |
| a genuinely blocked docket still cannot produce an executable obligation | ok | ok |
| no other precondition on the obligation path was removed | ok | ok |

The blocked-docket control pins the real refusals: `No U4 pre-Xero docket exists
for this invoice proposal.`, `The current docket is not a pre-Xero proposal that
can mint an invoice obligation.`, `pricing_evidence_missing`, and — at the
execute step — `jsonb_array_length(target_revision.blockers) > 0` →
`the invoice obligation has no executable priced line set`. Note the precise
claim: a blocked docket *does* still mint a `state = 'blocked'` obligation
revision carrying its concrete blockers (that is the designed behaviour, pinned
by `makesafe_invoice_obligation_test.ts`); what it cannot do is become
executable. Stating it as "does not mint" would be false.

### 8.5 Full suite and type gate

```
baseline (clean tree):  FAILED | 2942 passed | 18 failed | 1 ignored (15s)
with this change:       FAILED | 2954 passed | 18 failed | 1 ignored (15s)
```

The failing test set is **identical** — verified by diffing the sorted
`FAILURES` blocks of both runs, which came back empty. All 18 are pre-existing
and unrelated (one of them, `ses_artifact_hash_budget_test.ts`, is the
documented `--allow-run`-less red noted in the repo `CLAUDE.md`). The delta is
exactly **+12 passes**, which is this change's 12 new tests. Zero regressions.

`deno check --config deno.jsonc supabase/functions/ops-api/index.ts` → exit 0.
`deno fmt --check` and `deno lint` clean on the new test file.

### 8.6 Live card: `SWMS-261109` Bertram — before state (read-only)

Read-only via the Supabase Management API with `read_only: true`, SELECT only.

```
job_id                208450c0-7161-4b30-9514-66226b054609
job_number            SWMS-261109        type makesafe   status accepted
site_suburb           Bertram            substatus admin_to_send_report
ses_money_sealed_at   2026-07-29 05:31:05.558259+00      <- SEALED

docket_revision_id    31daa258-5fc7-540c-9ced-c9d1b468195d
  stage               pre_xero
  state               ready
  pre_xero_docs_ready true
  blockers            0
  readiness_revision  NULL               <- readiness never certified
  committed_at        2026-08-02 15:08:26.83199+00
  proposal            480.00 ex / 48.00 GST / 528.00 inc, 1 line item
  builder_reference   AJBR-70271

makesafe_invoice_obligations            0
makesafe_invoice_obligation_revisions   0
makesafe_readiness_current              1 row, ready = false, generation 41,
                                        readiness_revision NULL,
                                        invalidation_reason
                                        'INSERT changed a makesafe-state.v2 dependency'
makesafe_readiness_invalidations       41
xero_invoices linked to this job        0
```

$528 inc GST and zero blockers reproduce the batch-1 crew's measurement exactly.
This card is held by nothing but the gate.

### 8.7 Live mint: NOT PERFORMED — blocked, reported, not worked around

Two independent blockers, both reported rather than routed around.

**(a) The fix is not deployed to production.** The new function bodies exist
only on this branch. Production still holds the `20260728020000` bodies, so a
mint attempt today executes the OLD function and returns the same `23514`. The
migration deploys on merge to `main` (section 9) — a merge I am forbidden to
perform.

**(b) The local `SW_API_KEY` is rejected by the deployed `ops-api`.**

```
POST …/functions/v1/ops-api  {"action":"prepare_ses_invoice_obligation", job_id:…}
  -> HTTP 401 {"error":"Unauthorized"}
```

Diagnosed, not assumed: the key loads correctly from
`~/.config/secureworks/env` (64 chars, md5 prefix `7f5ff53c`,
`SW_SUPABASE_URL` matching project `kevgrhcjxspbxgovpmfl`), and the **same key
on a trivially safe read** (`GET ?action=ops_summary`) returns the same
`HTTP 401 {"error":"Unauthorized"}`. So the request shape is fine and the
credential itself is rejected — `_resolveOpsApiAuthIntent` classified the caller
as none, meaning the key does not match the edge runtime's `SW_API_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` or `MAKESAFE_ROUTINE_KEY`.

**I did not swap credentials and did not seek another route.** No production
write was performed. The mint attempt itself would have written nothing in any
case: the readiness precondition raises *before* the `INSERT INTO
makesafe_invoice_obligations`, so the old function's refusal is write-free.

The after-state measurement is therefore still owed, and needs (a) the PR merged
and deployed, and (b) a working `SW_API_KEY`.

---

## 9. How this deploys

**Migration-only.** No edge-function source changed.

On merge to `main`, `.github/workflows/deploy-edge-functions.yml` runs in the
`production` environment. Its reviewed migration lane runs
`scripts/apply-pending-migrations.sh`, which applies repository migrations
missing from the production ledger in version order through the Management API,
verifying and ledgering each one. Per
`docs/project-knowledge/EDGE_DEPLOY_LANE.md`, **migration-only merges deploy
zero functions** — so this merge applies the migration and deploys no code.

**Nothing needs to be run by hand.** No exclusion, no alias, no ledger debt, no
manual `supabase db push`, no function deploy. The version does not collide with
the live ledger (section 8.1), and the migration is above the audited automatic
boundary (`20260722000001`), so it is in the automatic lane.

The cheap pre-merge check is
`bash scripts/apply-pending-migrations.sh --dry-run` with a production
`SUPABASE_ACCESS_TOKEN`, which reproduces the gate read-only.

**Caveat worth stating:** the migration was **not executed against any
database**. There is no local Postgres, no docker, and no `psql` on this
machine, and production is SELECT-only for me, so a `CREATE OR REPLACE FUNCTION`
could not be validated by execution. What was verified instead: the two bodies
are byte-identical to already-applied production bodies except for the audited
diff (8.2), and `IF`/`END IF` and `BEGIN`/`END`/`CASE` all balance. First real
parse happens in the deploy lane, which applies each migration in a transaction
and ledgers only on success — a syntax error would fail the run before anything
ships, not half-apply.

---

## 10. The pattern named

The task asked me to name it if I met it.

This is the **mirror image** of the usual finding on this codebase. The familiar
shape is "the capability already existed and only the wiring was missing." Here
the capability was deliberately **not built** — readiness shipped as an
explicitly labelled Phase-1 compare-only shadow with its producer scheduled for
a later phase — and the U5 money path wired it in anyway, as a hard
precondition. Half a mechanism plus a consumer that assumes the other half is a
deadlock, and it is silent: the invalidator kept running (511 rows), so the
subsystem *looked* alive right up to the point where something asked it a
question it could never answer.

The tell was in the data, not the code: **511 invalidations against 0
revisions.** A producer/consumer pair where one side has thousands of rows and
the other has none is the signature. Worth checking for on the other Phase-1
shadows.

And a second, smaller one worth recording: **"delete the check" was not the
minimum change** (section 2). The check was load-bearing for the code after it —
it guaranteed a non-NULL record to five downstream readers. Deleting it swaps a
clean refusal for a `23502` four statements later. Whenever a guard's variable
is read downstream, removing the guard is a two-part change, and the second part
is where the real decision lives.
